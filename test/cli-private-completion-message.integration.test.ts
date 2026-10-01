import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPreparedModelRuntimeSnapshots } from "../src/agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import * as runtimePlugins from "../src/agents/runtime-plugins.js";
import { listSubagentRunsForRequester } from "../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import type { ChannelPlugin } from "../src/channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { revokeMcpLoopbackClientGrant } from "../src/gateway/mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "../src/gateway/mcp-http.loopback-runtime.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import type { CliBackendPlugin } from "../src/plugins/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../src/state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../src/test-utils/bundled-plugin-public-surface.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

// Attached devices are outside this completion journey.
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

const chatId = "555000111";
const telegramToken = "8000000001:AAHsyntheticPrivateCompletionToken01";
const modelId = "claude-sonnet-4-6";
const modelRef = `anthropic/${modelId}`;
const requesterKey = "agent:main:private-cli-completion";
const parentMarker = "PRIVATE-CLI-PARENT-TURN";
const childTask = "Reply exactly PRIVATE-CLI-CHILD-RESULT and nothing else.";
const childResult = "PRIVATE-CLI-CHILD-RESULT";
const parentReply = "PRIVATE-CLI-PARENT-ACCEPTED";

// The maintained control/JSONL child protocol from anthropic/cli-process.test.ts. Only
// Claude's decisions are synthetic: the child reads the runner-generated MCP config and
// calls the real loopback server with the grant the real CLI runner minted.
const PROTOCOL_CHILD = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const record = (entry) =>
  appendFileSync(new URL("./turns.jsonl", import.meta.url), JSON.stringify(entry) + "\n");
const configPath = process.argv.includes("--mcp-config") ? argument("--mcp-config") : undefined;
const server = configPath
  ? JSON.parse(readFileSync(configPath, "utf8")).mcpServers?.openclaw
  : undefined;
const headers = Object.fromEntries(Object.entries(server?.headers ?? {}).map(([name, value]) => [
  name,
  value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? ""),
]));
let sequence = 0;
const rpc = async (method, params) => {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: response.ok ? await response.json() : undefined };
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : "";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
    return;
  }
  if (message.type !== "user") return;
  void (async () => {
    const sessionId = message.session_id || argument("--session-id");
    send({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
    const prompt = textOf(message.message?.content);
    const turn = { kind: "other", mcp: Boolean(server), calls: [] };
    let result = "NO_REPLY";
    if (prompt.includes(${JSON.stringify(childTask)})) {
      turn.kind = "child";
      result = ${JSON.stringify(childResult)};
    } else if (prompt.includes(${JSON.stringify(parentMarker)})) {
      turn.kind = "parent";
      const spawned = await rpc("tools/call", { name: "sessions_spawn", arguments: {
        task: ${JSON.stringify(childTask)}, label: "private child", completionTarget: "parent",
      } });
      turn.calls.push({ name: "sessions_spawn", status: spawned.status, result: spawned.body?.result });
      result = ${JSON.stringify(parentReply)};
    } else if (prompt.includes(${JSON.stringify(childResult)})) {
      turn.kind = "completion";
      if (server) {
        const listed = await rpc("tools/list");
        turn.tools = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
        if (turn.tools.includes("message")) {
          if (process.env.PRIVATE_COMPLETION_REVOKE_URL) {
            const revoked = await fetch(process.env.PRIVATE_COMPLETION_REVOKE_URL, {
              method: "POST",
              body: headers.Authorization ?? headers.authorization ?? "",
            });
            turn.revoked = revoked.status;
          }
          const sent = await rpc("tools/call", { name: "message", arguments: {
            action: "send", message: "Child finished: " + ${JSON.stringify(childResult)},
          } });
          turn.calls.push({ name: "message", status: sent.status, result: sent.body?.result,
            error: sent.body?.error });
        }
      }
    }
    record(turn);
    send({ type: "result", subtype: "success", is_error: false, result, session_id: sessionId,
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
      usage: {}, modelUsage: {}, permission_denials: [],
    });
  })().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
    process.stdin.destroy();
  });
});
`;

type Turn = {
  kind: "parent" | "child" | "completion" | "other";
  mcp: boolean;
  tools?: string[];
  revoked?: number;
  calls: Array<{ name: string; status: number; result?: { isError?: boolean }; error?: unknown }>;
};
type TelegramCall = { method: string; chatId?: string; text?: string };
type Scenario = {
  title: string;
  deny?: boolean;
  gate?: boolean;
  revoke?: boolean;
};

const scenarios: Scenario[] = [
  { title: "relays the private completion through exactly one Telegram send" },
  { title: "sends nothing when the operator denies message", deny: true },
  { title: "sends nothing when Telegram disables the send action", gate: true },
  { title: "rejects a revoked completion grant before Telegram sends", revoke: true },
];

async function installPrivateCompletionRuntime(params: {
  cfg: OpenClawConfig;
  childPath: string;
  cleanup: Array<() => void | Promise<void>>;
}) {
  const [{ buildAnthropicCliBackend }, { telegramPlugin }] = await Promise.all([
    loadBundledPluginFacade<{ buildAnthropicCliBackend: () => CliBackendPlugin }>({
      pluginId: "anthropic",
      artifactBasename: "api.js",
    }),
    loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
      pluginId: "telegram",
      artifactBasename: "api.js",
    }),
  ]);
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  for (const id of ["anthropic", "telegram"]) {
    const record = createPluginRecord({ id, origin: "global", trustedOfficialInstall: true });
    owner.registry.plugins.push(record);
    const api = owner.createApi(record, { config: params.cfg, registrationMode: "full" });
    if (id === "telegram") {
      api.registerChannel({ plugin: { ...telegramPlugin, status: undefined } });
    } else {
      const backend = buildAnthropicCliBackend();
      api.registerCliBackend({
        ...backend,
        config: { ...backend.config, command: params.childPath },
      });
    }
  }
  setActivePluginRegistry(owner.registry);
  params.cleanup.push(() => resetPluginRuntimeStateForTest());
  vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockImplementation(
    (_params, onPrimaryRegistry) => {
      onPrimaryRegistry?.(owner.registry);
      return owner.registry;
    },
  );
  vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry").mockResolvedValue({
    registry: owner.registry,
    primaryRegistry: owner.registry,
  });
}

async function readTurns(turnsPath: string): Promise<Turn[]> {
  const raw = await readFile(turnsPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Turn);
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T | undefined>,
  diagnostics: () => string,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Timed out waiting for ${label}: ${diagnostics()}`);
}

describe("private parent completion on a CLI requester", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(scenarios)("$title", async (scenario) => {
    const isolatedHome = expectDefined(process.env.OPENCLAW_TEST_HOME, "isolated test HOME");
    const root = tempDirs.make("private-cli-completion-", isolatedHome);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const childPath = path.join(root, "claude.mjs");
    const turnsPath = path.join(root, "turns.jsonl");
    const cleanup: Array<() => void | Promise<void>> = [];
    const telegram: TelegramCall[] = [];
    const revocations: boolean[] = [];
    let turns: Turn[] = [];
    const diagnostics = () => JSON.stringify({ turns, telegram, revocations });

    await runQaGatewayFixture(
      async () => {
        await mkdir(workspaceDir, { recursive: true });
        await writeFile(childPath, `#!${process.execPath}\n${PROTOCOL_CHILD}`, { mode: 0o700 });
        await appendFile(turnsPath, "");
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
        vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-config"));
        for (const key of [
          "OPENCLAW_TEST_MINIMAL_GATEWAY",
          "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
          "OPENCLAW_SKIP_CANVAS_HOST",
          "OPENCLAW_SKIP_GMAIL_WATCHER",
        ]) {
          vi.stubEnv(key, "1");
        }
        // Minimal mode suppresses channel startup; the skip flags would also remove
        // the channel credentials from the published runtime config.
        vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
        vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
        cleanup.push(() => clearRuntimeConfigSnapshot());
        cleanup.push(() => closeOpenClawStateDatabaseForTest());
        cleanup.push(() => closeOpenClawStateDatabaseAsync());

        const provider = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const url = new URL(request.url ?? "/", "http://fixture.invalid");
            const body = Buffer.concat(chunks).toString("utf8");
            if (url.pathname === "/revoke-grant") {
              const token = body.replace(/^Bearer\s+/i, "");
              revocations.push(revokeMcpLoopbackClientGrant(token));
              response.writeHead(200).end();
              return;
            }
            const method = url.pathname.split("/").pop() ?? "";
            const fields = body ? (JSON.parse(body) as Record<string, unknown>) : {};
            const call: TelegramCall = {
              method,
              ...(fields.chat_id !== undefined ? { chatId: String(fields.chat_id) } : {}),
              ...(typeof fields.text === "string" ? { text: fields.text } : {}),
            };
            telegram.push(call);
            const result = method.startsWith("send")
              ? {
                  message_id: 700 + telegram.length,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: Number(call.chatId), type: "private", first_name: "Requester" },
                  ...(call.text ? { text: call.text } : {}),
                }
              : true;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, result }));
          });
        });
        await new Promise<void>((resolve) => {
          provider.listen(0, "127.0.0.1", resolve);
        });
        cleanup.push(
          () =>
            new Promise<void>((resolve) => {
              provider.close(() => resolve());
            }),
        );
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected fixture TCP address");
        }
        const providerOrigin = `http://127.0.0.1:${address.port}`;
        vi.stubEnv(
          "PRIVATE_COMPLETION_REVOKE_URL",
          scenario.revoke ? `${providerOrigin}/revoke-grant` : undefined,
        );

        const gatewayPort = await getGatewayE2ePortBlock();
        const gatewayToken = "synthetic-private-completion-gateway-token";
        const cfg: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: gatewayPort,
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            ownership: "explicit",
            entries: { main: {} },
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              timeoutSeconds: 40,
              model: { primary: modelRef, fallbacks: [] },
              models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
              thinkingDefault: "off",
            },
          },
          models: {
            providers: {
              anthropic: {
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                apiKey: "synthetic-unused-model-key",
                models: [
                  {
                    id: modelId,
                    name: "Synthetic Claude CLI model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          tools: {
            toolSearch: false,
            alsoAllow: ["sessions_spawn"],
            ...(scenario.deny ? { deny: ["message"] } : {}),
          },
          plugins: { allow: ["anthropic", "telegram"], slots: { memory: "none" } },
          channels: {
            telegram: {
              enabled: true,
              botToken: telegramToken,
              apiRoot: providerOrigin,
              dmPolicy: "allowlist",
              allowFrom: [chatId],
              ...(scenario.gate ? { actions: { sendMessage: false } } : {}),
            },
          },
          cron: { enabled: false },
        };
        await writeFile(configPath, JSON.stringify(cfg));
        setRuntimeConfigSnapshot(cfg, cfg);
        await ensureMcpLoopbackServer(0);
        cleanup.push(() => closeMcpLoopbackServer());
        expectDefined(getActiveMcpLoopbackRuntime(), "task-owned MCP runtime");
        await installPrivateCompletionRuntime({ cfg, childPath, cleanup });
        cleanup.push(() => resetPreparedModelRuntimeSnapshotsForTest());

        const gateway = await startGatewayWithClient({
          port: gatewayPort,
          cfg,
          configPath,
          token: gatewayToken,
          scopes: ["operator.admin"],
        });
        cleanup.push(async () => {
          await runQaGatewayFixture(
            () => disconnectGatewayClient(gateway.client),
            () => gateway.server.close({ reason: "private completion fixture complete" }),
          );
        });
        await gateway.server.startupSettled;
        await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
          gatewayLifecycle: true,
          catalogMode: "static",
        });

        await gateway.client.request(
          "agent",
          {
            sessionKey: requesterKey,
            idempotencyKey: `private-cli-completion-${scenario.title}`,
            channel: "telegram",
            to: chatId,
            deliver: true,
            message: `${parentMarker}: spawn one hidden child and report its result privately.`,
          },
          { expectFinal: true, timeoutMs: 60_000 },
        );

        const child = await waitFor(
          "the hidden child completion",
          async () =>
            listSubagentRunsForRequester(requesterKey).find(
              (run) =>
                run.completion?.resultText?.includes(childResult) === true &&
                run.execution.outcome?.status === "ok",
            ),
          diagnostics,
        );
        const completion = await waitFor(
          "the requester completion turn",
          async () => {
            turns = await readTurns(turnsPath);
            return turns.find((turn) => turn.kind === "completion");
          },
          diagnostics,
        );
        turns = await readTurns(turnsPath);
        const spawn = turns.find((turn) => turn.kind === "parent")?.calls[0];
        expect(spawn?.result?.isError, diagnostics()).toBe(false);
        expect(child.completionTarget, diagnostics()).toBe("parent");

        const childSends = telegram.filter(
          (call) => call.method.startsWith("send") && call.text?.includes(childResult),
        );
        const messageCall = completion.calls.find((call) => call.name === "message");
        if (scenario.deny) {
          // A denied completion runs tool-free: no MCP grant, no message call, no send.
          expect(completion.tools ?? [], diagnostics()).not.toContain("message");
          expect(messageCall, diagnostics()).toBeUndefined();
        } else {
          expect(completion.tools, diagnostics()).toEqual(["message"]);
          if (scenario.revoke) {
            expect(revocations, diagnostics()).toEqual([true]);
            expect(messageCall?.result, diagnostics()).toBeUndefined();
          } else if (scenario.gate) {
            expect(messageCall?.result?.isError, diagnostics()).toBe(true);
          } else {
            expect(messageCall?.result?.isError, diagnostics()).toBe(false);
          }
        }
        expect(childSends, diagnostics()).toEqual(
          scenario.deny || scenario.gate || scenario.revoke
            ? []
            : [{ method: "sendMessage", chatId, text: `Child finished: ${childResult}` }],
        );
        // The requester's own visible reply proves the Telegram transport was reachable.
        expect(
          telegram.filter((call) => call.method.startsWith("send") && call.text === parentReply),
          diagnostics(),
        ).toHaveLength(1);
      },
      () => runQaGatewayFixture(async () => {}, ...cleanup.toReversed()),
      () => vi.restoreAllMocks(),
      () => vi.unstubAllEnvs(),
    );
  });
});
