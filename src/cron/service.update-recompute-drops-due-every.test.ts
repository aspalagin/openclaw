import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createFinishedBarrier,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { loadCronJobsStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("update() must not drop a due every-job's pending run", () => {
  it("preserves a due every-job nextRunAtMs on an idempotent schedule re-save", async () => {
    const store = await makeStorePath();
    const base = Date.parse("2025-12-13T00:00:00.000Z");

    const lastRunAtMs = base + 10_005;
    const dueSlot = lastRunAtMs + 10_000;
    const nowDue = dueSlot + 50;
    const job: CronJob = {
      id: "every-10s",
      name: "every 10s",
      enabled: true,
      createdAtMs: base,
      updatedAtMs: lastRunAtMs,
      schedule: { kind: "every", everyMs: 10_000, anchorMs: base },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "tick" },
      delivery: { mode: "announce" },
      state: { lastRunAtMs, lastRunStatus: "ok", nextRunAtMs: dueSlot },
    };
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    try {
      // Seed completed work so setup does not drive SQLite idle or scheduler timers.
      await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [job] });
      vi.setSystemTime(new Date(nowDue));

      // The control UI resubmits the unchanged schedule without its internal anchor.
      await cron.update(job.id, { schedule: { kind: "every", everyMs: 10_000 } });

      const current = (await cron.list({ includeDisabled: true })).find((j) => j.id === job.id)!;
      expect(current.state.lastRunAtMs).toBe(lastRunAtMs);
      expect(current.state.nextRunAtMs).toBe(dueSlot);
      expect(current.state.nextRunAtMs).toBeLessThanOrEqual(nowDue);
      expect(current.schedule).toMatchObject({ kind: "every", anchorMs: base });

      const persisted = (await loadCronJobsStore(store.storePath)).jobs.find(
        (j) => j.id === job.id,
      )!;
      expect(persisted.state).toMatchObject({ lastRunAtMs, nextRunAtMs: dueSlot });
      expect(persisted.schedule).toMatchObject({ kind: "every", anchorMs: base });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it.each([
    { name: "before its first run", previousEveryMs: 10_000, nextEveryMs: 3_600_000 },
    {
      name: "after a completed run when the interval increases",
      previousEveryMs: 10_000,
      nextEveryMs: 3_600_000,
      completedRun: true,
    },
    {
      name: "after a completed run when the interval decreases",
      previousEveryMs: 60_000,
      nextEveryMs: 10_000,
      completedRun: true,
    },
    {
      name: "at an explicit future anchor after a completed run",
      previousEveryMs: 10_000,
      nextEveryMs: 3_600_000,
      completedRun: true,
      futureAnchorOffsetMs: 7_200_000,
    },
  ])(
    "re-anchors an every-job $name",
    async ({ previousEveryMs, nextEveryMs, completedRun, futureAnchorOffsetMs }) => {
      const store = await makeStorePath();
      const base = Date.parse("2025-12-13T00:00:00.000Z");

      const finished = createFinishedBarrier();
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        onEvent: finished.onEvent,
      });

      await cron.start();

      const job = await cron.add({
        name: "every 10s",
        enabled: true,
        schedule: { kind: "every", everyMs: previousEveryMs },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "tick" },
      });
      const jobId = job.id;
      expect(job.schedule).toMatchObject({ kind: "every", anchorMs: base });

      let editTime = base + 3_000;
      if (completedRun) {
        vi.setSystemTime(new Date(base + previousEveryMs + 5));
        const firstRun = finished.waitForOk(jobId);
        await vi.runOnlyPendingTimersAsync();
        await firstRun;
        const completedJob = (await cron.list({ includeDisabled: true })).find(
          (candidate) => candidate.id === jobId,
        )!;
        editTime = completedJob.state.lastRunAtMs! + 3_000;
      }

      vi.setSystemTime(new Date(editTime));
      const futureAnchorMs =
        futureAnchorOffsetMs === undefined ? undefined : editTime + futureAnchorOffsetMs;
      await cron.update(jobId, {
        schedule: {
          kind: "every",
          everyMs: nextEveryMs,
          ...(futureAnchorMs === undefined ? {} : { anchorMs: futureAnchorMs }),
        },
      });

      const current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
      expect(current.schedule).toMatchObject({
        kind: "every",
        everyMs: nextEveryMs,
        anchorMs: futureAnchorMs ?? editTime,
      });
      expect(current.state.nextRunAtMs).toBe(futureAnchorMs ?? editTime + nextEveryMs);

      cron.stop();
    },
  );

  it("preserves a due cron-job nextRunAtMs on an idempotent schedule re-save", async () => {
    const store = await makeStorePath();
    vi.setSystemTime(new Date("2025-12-13T08:59:00.000Z"));

    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: finished.onEvent,
    });

    await cron.start();

    const job = await cron.add({
      name: "daily 9am",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
    });
    const jobId = job.id;
    const dueSlot = job.state.nextRunAtMs!;

    // Advance past the 09:00 slot so it is now due, before the timer fires it.
    vi.setSystemTime(new Date(dueSlot + 50));
    const nowDue = dueSlot + 50;

    await cron.update(jobId, { schedule: { kind: "cron", expr: "0 9 * * *" } });

    const current = (await cron.list({ includeDisabled: true })).find((j) => j.id === jobId)!;
    // Correct: the due slot is preserved. Buggy main: nextRunAtMs jumps to the
    // next day, dropping today's run.
    expect(current.state.nextRunAtMs).toBe(dueSlot);
    expect(current.state.nextRunAtMs).toBeLessThanOrEqual(nowDue);

    cron.stop();
  });
});
