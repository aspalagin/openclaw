import { describe, expect, it } from "vitest";
import { createChannelActionContext } from "./message-action-contracts.js";

type ActionContextInput = Parameters<typeof createChannelActionContext>[0]["ctx"];

function createResolvedContext(input: Record<string, unknown>): ActionContextInput {
  return {
    channel: "telegram",
    cfg: {},
    params: { to: "123", message: "Deploy?" },
    accountId: "default",
    agentId: "main",
    dryRun: false,
    input: { cfg: {}, action: "send", params: {}, ...input },
  } as unknown as ActionContextInput;
}

describe("createChannelActionContext", () => {
  it.each([
    { label: "model-authored message-tool sends", actionOrigin: "message-tool" as const },
    { label: "operator and gateway sends", actionOrigin: undefined },
  ])("forwards the host-owned action origin for $label", ({ actionOrigin }) => {
    const ctx = createChannelActionContext({
      ctx: createResolvedContext(actionOrigin ? { actionOrigin } : {}),
      action: "send",
    });

    expect(ctx.actionOrigin).toBe(actionOrigin);
    expect(ctx).toMatchObject({ channel: "telegram", action: "send", accountId: "default" });
  });
});
