// The combined Worker's router with the real existing Worker and a stand-in for Payload, so the existing
// test suites (which import "../worker/index") run unchanged through platform/compose.ts.
import legacy, * as legacyModule from "../../../worker/index";
import type { Env } from "../../../worker/env";
import { authenticate } from "../../../worker/portal/auth";
import { createPlatformWorker, type PlatformEnv } from "../platform/compose";

export const payloadCalls: string[] = [];
/** The credentials each request carried when it reached Payload. */
export const payloadSeen: Array<{ cookie: string | null; authorization: string | null }> = [];
export const payloadStub = {
    async fetch(request: Request) {
        payloadCalls.push(`${new URL(request.url).host}${new URL(request.url).pathname}`);
        payloadSeen.push({ cookie: request.headers.get("Cookie"), authorization: request.headers.get("Authorization") });
        // Like Payload after a sign-in: tries to set its own session cookie next to an unrelated one.
        const headers = new Headers({ "X-Poc-Target": "payload" });
        headers.append("Set-Cookie", "payload-token=eyJ.stub.jwt; Path=/; HttpOnly");
        headers.append("Set-Cookie", "payload-theme=dark; Path=/");
        return new Response("payload", { status: 200, headers });
    },
};

export const PortalMcpEntrypoint = legacyModule.PortalMcpEntrypoint;
export const guardedSync = legacyModule.guardedSync;
export default createPlatformWorker<Env & PlatformEnv>({ legacy, payload: payloadStub, authenticate });
