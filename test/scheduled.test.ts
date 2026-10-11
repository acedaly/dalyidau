import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker, { guardedSync } from "../worker/index";
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
    await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE key = 'sync_lock'").bind(`${Date.now()}:other-run`).run();
    await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('sync_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(`${Date.now()}:other-run`)
        .run();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/15 * * * *" }) as never, testEnv, ctx as never);
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    await testEnv.DB.prepare("UPDATE meta SET value = '' WHERE key = 'sync_lock'").run();
});

it("lets only one of two simultaneous syncs run, then releases the lock", async () => {
    await resetDb();
    await testEnv.DB.prepare("DELETE FROM meta WHERE key = 'sync_lock'").run();
    const mock = createMock();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => mock.handle(new Request(input as RequestInfo, init)));
    const results = await Promise.all([guardedSync(testEnv, "cron", false), guardedSync(testEnv, "manual", false)]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await guardedSync(testEnv, "manual", false)).not.toBeNull();
});

it("takes over a lock left behind by a crashed run", async () => {
    await resetDb();
    await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('sync_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(`${Date.now() - 60 * 60_000}:crashed`)
        .run();
    const mock = createMock();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => mock.handle(new Request(input as RequestInfo, init)));
    expect(await guardedSync(testEnv, "cron", false)).not.toBeNull();
});
