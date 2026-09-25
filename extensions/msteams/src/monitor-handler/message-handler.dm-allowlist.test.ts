import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { createMessageHandlerDeps } from "./message-handler.test-support.js";

const { dispatchReplyWithBufferedBlockDispatcher: dispatch } = getRuntimeApiMockState();

describe("msteams DM allowlist admission", () => {
  it.each([
    {
      name: "dispatches the matching sender",
      senderId: "11111111-1111-4111-8111-111111111111",
      allowed: true,
    },
    {
      name: "blocks a different sender",
      senderId: "22222222-2222-4222-8222-222222222222",
      allowed: false,
    },
  ])("$name with a provider-prefixed DM allowlist entry", async ({ senderId, allowed }) => {
    dispatch.mockClear();
    const { deps, conversationStore, recordInboundSession } = createMessageHandlerDeps({
      channels: {
        msteams: {
          dmPolicy: "allowlist",
          allowFrom: ["msteams:user:11111111-1111-4111-8111-111111111111"],
        },
      },
    });

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-prefixed-allowlist",
        type: "message",
        text: "please check the build",
        from: {
          id: `botframework:${senderId}`,
          aadObjectId: senderId,
          name: "Sender",
        },
        recipient: { id: "bot-id", name: "Bot" },
        conversation: {
          id: "a:personal-chat",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
      sendActivities: vi.fn(async () => undefined),
      updateActivity: vi.fn(async () => undefined),
      deleteActivity: vi.fn(async () => undefined),
    });

    if (allowed) {
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            SenderId: senderId,
            BodyForAgent: "please check the build",
          }),
        }),
      );
      expect(recordInboundSession).toHaveBeenCalledTimes(1);
      expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    } else {
      expect(dispatch).not.toHaveBeenCalled();
      expect(recordInboundSession).not.toHaveBeenCalled();
      expect(conversationStore.upsert).not.toHaveBeenCalled();
    }
  });
});
