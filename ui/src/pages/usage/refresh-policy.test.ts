import { describe, expect, it } from "vitest";
import { decideUsageRefresh, USAGE_PAYLOAD_TTL_MS } from "./refresh-policy.ts";

const NOW_MS = 1_000_000;

describe("decideUsageRefresh", () => {
  it("skips a reconnect while the cached payload is within the TTL", () => {
    expect(
      decideUsageRefresh({
        reason: "reconnect",
        visible: true,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS + 1,
      }),
    ).toBe("skip");
  });

  it("defers a stale reconnect until the page is visible", () => {
    const stale = {
      nowMs: NOW_MS,
      lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS,
    };
    expect(decideUsageRefresh({ reason: "reconnect", visible: false, ...stale })).toBe("defer");
    expect(decideUsageRefresh({ reason: "focus", visible: true, ...stale })).toBe("fetch");
  });

  it("always fetches for a manual refresh", () => {
    expect(
      decideUsageRefresh({
        reason: "manual",
        visible: false,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS,
      }),
    ).toBe("fetch");
  });

  it("fetches on a visible reconnect after the TTL", () => {
    expect(
      decideUsageRefresh({
        reason: "reconnect",
        visible: true,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS,
      }),
    ).toBe("fetch");
  });

  it("applies the same TTL to automatic settle polling", () => {
    expect(
      decideUsageRefresh({
        reason: "poll",
        visible: true,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS + 1,
      }),
    ).toBe("skip");
  });
});
