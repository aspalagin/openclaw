// Telegram tests cover message-session routing and persisted model inheritance.
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import { createTelegramMessageSessionRuntime } from "./bot-handlers.message-context.js";

describe("createTelegramMessageSessionRuntime", () => {
  it.each([
    { name: "fresh", topic: {}, model: "openai/gpt-5.5" },
    {
      name: "previously used",
      topic: { modelProvider: "anthropic", model: "claude-opus-4-7" },
      model: "openai/gpt-5.5",
    },
    {
      name: "explicitly pinned",
      topic: { providerOverride: "anthropic", modelOverride: "claude-opus-4-7" },
      model: "anthropic/claude-opus-4-7",
    },
    {
      name: "explicitly parented",
      topic: { parentSessionKey: "agent:main:main" },
      model: "anthropic/claude-opus-4-7",
    },
  ])("uses the effective model for a $name DM topic picker", ({ topic, model }) => {
    const storePath = "/tmp/telegram-sessions.sqlite";
    const childSessionKey = "agent:main:main:thread:12345:99";
    const parentSessionKey = "agent:main:main";
    const entries: Record<string, SessionEntry> = {
      [childSessionKey]: { sessionId: "child", updatedAt: 2, ...topic },
      [parentSessionKey]: {
        sessionId: "parent",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
      },
    };
    const getSessionEntry = vi.fn<NonNullable<TelegramBotDeps["getSessionEntry"]>>(
      ({ sessionKey }) => entries[sessionKey],
    );
    const telegramDeps = {
      resolveStorePath: vi.fn(() => storePath),
      getSessionEntry,
    } as Pick<TelegramBotDeps, "resolveStorePath" | "getSessionEntry"> as TelegramBotDeps;
    const { resolveTelegramSessionState } = createTelegramMessageSessionRuntime({
      accountId: "default",
      resolveTelegramGroupConfig: () => ({}),
      telegramDeps,
    });

    const state = resolveTelegramSessionState({
      chatId: 12345,
      isGroup: false,
      threadSpec: { id: 99, scope: "dm" },
      botHasTopicsEnabled: true,
      senderId: 12345,
      runtimeCfg: { agents: { defaults: { model: "openai/gpt-5.5" } } },
    });

    expect(state.sessionKey).toBe(childSessionKey);
    expect(state.model).toBe(model);
    expect(getSessionEntry).toHaveBeenCalledWith({ storePath, sessionKey: childSessionKey });
  });
});
