import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

/**
 * Regression coverage for the "Agent database execution admission is closed" wedge
 * (openclaw/openclaw#159438).
 *
 * Production sequence (2026.9.6, observed 2026-09-27 01:00 UTC):
 *   1. an agent-DB operation fails while its native store becomes unavailable
 *      (`generation.failed()` → true), so `run()` calls `owner.close()`;
 *   2. `owner.close()` sets `retired = true` first, then `closeNative()` rejects,
 *      so `finishRetirement()` never runs and the owner stays in `executions`;
 *   3. the caller sees `AggregateError("Agent operation and cleanup failed")`;
 *   4. before the fix, every later capture for the same agent path found the retired
 *      owner in `executions`, and `borrow()` → `assertCurrent()` threw
 *      "Agent database execution admission is closed" until the process restarted.
 *
 * The faults below (worker exit on a marked command, refused lease release) make the
 * native store unavailable mid-operation and make the native close fail the same way
 * a transient I/O error did in production. Only an explicit `revoke()` stays terminal.
 */
const fault = vi.hoisted(() => ({
  marker: "close-wedge-kill-marker",
  enabled: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
}));

vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { MessagePort, workerData } from "node:worker_threads";
    // Fault 2: while enabled, the retired lease cannot be released (mimics the
    // transient SQLITE_IOERR that made the native close fail in production).
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (/delete from "?agent_database_leases"?/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          if (Atomics.load(new Int32Array(workerData.closeWedgeEnabled), 0)) {
            throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10, errstr: "disk I/O error" });
          }
          return run(...args);
        };
      }
      return statement;
    };
    // Fault 1: the agent worker exits while handling the marked command.
    const on = MessagePort.prototype.on;
    MessagePort.prototype.on = function (event, listener) {
      if (event !== "message") {
        return on.call(this, event, listener);
      }
      return on.call(this, event, function (message) {
        if (Atomics.load(new Int32Array(workerData.closeWedgeEnabled), 0)) {
          let text = "";
          try {
            const input = message && message.input;
            text = input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1") : "";
          } catch {}
          if (text.includes(workerData.closeWedgeMarker)) {
            // The native store disappears mid-operation (worker exit → broker fail(slot)).
            process.exit(3);
          }
        }
        return listener.call(this, message);
      });
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          closeWedgeMarker: fault.marker,
          closeWedgeEnabled: fault.enabled,
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    Atomics.store(new Int32Array(fault.enabled), 0, 0);
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Close wedge fixture lost admission");
        }
      }, binding.attachment),
    });
  },
};

async function failFirstOperation(
  first: ReturnType<typeof captureOpenClawAgentDatabaseExecution>,
): Promise<unknown> {
  Atomics.store(new Int32Array(fault.enabled), 0, 1);
  const failure: unknown = await first
    .runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKey: fault.marker } }),
    )
    .catch((error: unknown) => error);
  Atomics.store(new Int32Array(fault.enabled), 0, 0);
  return failure;
}

it("re-admits an agent after a failed operation whose owner close also failed", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-wedge-")) };
  const first = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  await first.prepare(source);
  expect(await first.runExisting(source, async () => "healthy")).toBe("healthy");

  // 1. The operation fails because the native store becomes unavailable mid-run.
  const failure = await failFirstOperation(first);
  expect(failure).toBeInstanceOf(Error);
  console.log(`[close-wedge] operation failure: ${formatErrorMessageWithCode(failure)}`);
  await first.release().catch((error: unknown) => {
    console.log(`[close-wedge] release failure: ${formatErrorMessageWithCode(error)}`);
  });

  // 2. The fault is gone. A fresh capture for the same agent must be admitted again;
  //    on 2026.9.6 (and current main) it throws
  //    "Agent database execution admission is closed" until the gateway restarts.
  const retry = await Promise.resolve()
    .then(async () => {
      const execution = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
      await execution.prepare(source);
      return execution;
    })
    .catch((error: unknown) => {
      console.log(`[close-wedge] re-admission failure: ${formatErrorMessageWithCode(error)}`);
      throw error;
    });
  expect(await retry.runExisting(source, async () => "recovered")).toBe("recovered");
  await retry.release();
});

it("surfaces the native cleanup cause while the close still fails, then recovers once it clears", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-close-wedge-scope-")) };
  const first = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  await first.prepare(source);

  // The fault stays enabled through the whole retry below.
  Atomics.store(new Int32Array(fault.enabled), 0, 1);
  const failure: unknown = await first
    .runExisting(source, (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKey: fault.marker } }),
    )
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(formatErrorMessageWithCode(failure)).toContain("Agent operation and cleanup failed");
  await first.release().catch(() => undefined);

  // Another agent on the same state directory is not affected.
  const second = captureOpenClawAgentDatabaseExecution({ agentId: "second", env });
  await second.prepare(source);
  expect(await second.runExisting(source, async () => "second usable")).toBe("second usable");
  await second.release();

  // The failed agent is re-admitted; its retained cleanup is retried first and still fails,
  // so the caller sees the native cause instead of a generic admission refusal.
  const retry = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  const stillFailing: unknown = await retry.prepare(source).catch((error: unknown) => error);
  const stillFailingText = formatErrorMessageWithCode(stillFailing);
  console.log(`[close-wedge] retry while cleanup still fails: ${stillFailingText}`);
  expect(stillFailing).toBeInstanceOf(Error);
  expect(stillFailingText).toContain("disk I/O error");
  expect(stillFailingText).not.toContain("admission is closed");
  await retry.release().catch(() => undefined);

  // Once the cause is gone the same agent recovers without a process restart.
  Atomics.store(new Int32Array(fault.enabled), 0, 0);
  const recovered = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  await recovered.prepare(source);
  expect(await recovered.runExisting(source, async () => "recovered")).toBe("recovered");
  await recovered.release();
});
