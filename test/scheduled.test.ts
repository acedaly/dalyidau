import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { createMock, publishedSlugs, resetDb, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("the cron trigger runs a sync and logs it", async () => {
    await resetDb();
    const mock = createMock();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => mock.handle(new Request(input as RequestInfo, init)));
    const log = vi.spyOn(console, "log");

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/15 * * * *" }) as never, testEnv, ctx as never);
    await waitOnExecutionContext(ctx);

    expect(await publishedSlugs()).toHaveLength(3);
    const run = await testEnv.DB.prepare("SELECT trigger, status FROM sync_runs").first();
    expect(run).toEqual({ trigger: "cron", status: "ok" });
    expect(log.mock.calls.some(([line]) => String(line).includes('"event":"sync_complete"'))).toBe(true);
});

it("skips a run while another is still in progress", async () => {
    await resetDb();
    await testEnv.DB.prepare("INSERT INTO sync_runs (trigger, started_at, status) VALUES ('cron', ?, 'running')").bind(new Date().toISOString()).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/15 * * * *" }) as never, testEnv, ctx as never);
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
});
