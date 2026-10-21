// Mock OpenAI Responses provider for the PR 179902 live proof. Only the model is synthetic:
// progress_card, sessions_spawn, sessions_yield, the child run, requester settle and Telegram
// delivery are real. Based on .agents/skills/telegram-e2e-userbot/scripts/reply-policy-mock.mjs.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const run = process.env.E2E_RUN;
const marker = {
  request: "PR179902_REQUEST_" + run,
  task: "PR179902_CHILD_TASK_" + run,
  child: "PR179902_CHILD_RESULT_" + run,
  final: "PR179902_FINAL_" + run,
};
const holdChildMs = Number(process.env.HOLD_CHILD_MS ?? 20000);
const holdFinalMs = Number(process.env.HOLD_FINAL_MS ?? 20000);
const usage = { input_tokens: 64, output_tokens: 16, total_tokens: 80, input_tokens_details: { cached_tokens: 0 } };
const plan = (first, second) => [
  { step: "Fetch the recording", status: first },
  { step: "Transcribe it", status: second },
  { step: "Update the notes", status: "pending" },
];
const log = (facts) =>
  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ at: new Date().toISOString(), ...facts }) + "\n");

function result(value) {
  if (typeof value === "string") {
    try {
      return result(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  if (value.status || value.ok !== undefined || value.revision !== undefined) return value;
  if (value.details) {
    const found = result(value.details);
    if (found) return found;
  }
  for (const part of Array.isArray(value) ? value : (value.content ?? [])) {
    const found = result(part.text ?? part);
    if (found) return found;
  }
}
function textEvents(text) {
  const item = { type: "message", id: "msg_mock", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_mock_text", status: "completed", output: [item], usage } },
  ];
}
function toolEvents(name, args) {
  const serialized = JSON.stringify(args), id = hash(name + serialized).slice(0, 10);
  const item = { type: "function_call", id: "fc_" + id, call_id: "call_" + id, name, arguments: serialized };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: serialized },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_" + id, status: "completed", output: [item], usage } },
  ];
}
function decide(body) {
  const all = Array.isArray(body.input) ? body.input : [];
  // Judge only this run's request and what followed it in the session transcript.
  const start = all.findLastIndex((item) => JSON.stringify(item).includes(marker.request));
  const input = start >= 0 ? all.slice(start) : all;
  const raw = JSON.stringify(input);
  const tools = new Map((body.tools ?? []).map((tool) => [tool.name, tool]));
  if (!tools.size) return { kind: "side", text: "ok" };
  const calls = input.filter((item) => item.type === "function_call");
  const receipts = calls.map((call) => {
    const rawOutput = input.find((item) => item.type === "function_call_output" && item.call_id === call.call_id)?.output;
    return { call, rawOutput: JSON.stringify(rawOutput ?? ""), output: result(rawOutput) };
  });
  const ok = (name) => receipts.filter(({ call, output }) => call.name === name && output);
  // progress_card answers with text ("Progress card updated (rev N, X/Y done)") before its JSON.
  const cardsDone = receipts.filter(({ call, rawOutput }) => call.name === "progress_card" && /Progress card updated/.test(rawOutput));
  const tool = (name, args, kind, holdMs = 0) => {
    const schema = tools.get(name)?.parameters;
    if (!schema || Object.keys(args).some((key) => !schema.properties?.[key])) throw new Error("TOOL_SCHEMA_MISMATCH_" + name);
    return { kind, tool: name, args, holdMs };
  };
  if (!raw.includes(marker.request) && raw.includes(marker.task)) {
    return { kind: "child", text: marker.child, holdMs: holdChildMs };
  }
  if (!raw.includes(marker.request)) throw new Error("UNKNOWN_MODEL_TURN");
  const cards = cardsDone;
  if (!raw.includes(marker.child)) {
    if (cards.length === 0) {
      return tool("progress_card", { plan: plan("in_progress", "pending") }, "plan-0of3");
    }
    if (ok("sessions_spawn").every(({ output }) => output.status !== "accepted")) {
      return tool("sessions_spawn", { task: marker.task + ". Return the result.", taskName: "transcribe", mode: "run", context: "isolated", completionTarget: "parent" }, "spawn");
    }
    if (ok("sessions_yield").every(({ output }) => output.status !== "yielded")) {
      return tool("sessions_yield", { acknowledgment: "Started the transcription; I will report when it is done." }, "yield");
    }
    return { kind: "after-yield", text: "NO_REPLY" };
  }
  // Requester settle wake: the child's result is in the transcript.
  if (cards.length < 2) {
    return tool("progress_card", { plan: plan("completed", "in_progress") }, "plan-1of3");
  }
  return { kind: "settle-final", text: marker.final, holdMs: holdFinalMs };
}
http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5", object: "model" }] }));
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      if (req.url !== "/v1/responses") {
        res.writeHead(404);
        return res.end();
      }
      try {
        const decision = decide(JSON.parse(raw));
        log({ kind: decision.kind, tool: decision.tool, holdMs: decision.holdMs ?? 0 });
        if (decision.holdMs) await new Promise((resolve) => setTimeout(resolve, decision.holdMs));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const events = decision.tool ? toolEvents(decision.tool, decision.args) : textEvents(decision.text);
        for (const event of events) res.write("data: " + JSON.stringify(event) + "\n\n");
        res.end("data: [DONE]\n\n");
        log({ kind: decision.kind, done: true });
      } catch (error) {
        log({ kind: "fixture-error", code: /^[A-Z_0-9]+$/.test(error.message) ? error.message : "MOCK_INPUT_ERROR", message: String(error.message).slice(0, 200) });
        res.writeHead(400);
        res.end();
      }
    });
  })
  .listen(Number(process.env.MOCK_PORT), "127.0.0.1", () => console.log("mock-openai listening"));
