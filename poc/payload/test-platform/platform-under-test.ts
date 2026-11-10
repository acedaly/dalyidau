// The combined Worker's router with the real existing Worker and a stand-in for Payload, so the existing
// test suites (which import "../worker/index") run unchanged through platform/compose.ts.
import legacy, * as legacyModule from "../../../worker/index";
import type { Env } from "../../../worker/env";
import { authenticate } from "../../../worker/portal/auth";
import { createPlatformWorker, type PlatformEnv } from "../platform/compose";

export const payloadCalls: string[] = [];
export const payloadStub = {
    async fetch(request: Request) {
        payloadCalls.push(`${new URL(request.url).host}${new URL(request.url).pathname}`);
        return new Response("payload", { status: 200, headers: { "X-Poc-Target": "payload" } });
    },
};

export const PortalMcpEntrypoint = legacyModule.PortalMcpEntrypoint;
export const guardedSync = legacyModule.guardedSync;
export default createPlatformWorker<Env & PlatformEnv>({ legacy, payload: payloadStub, authenticate });
