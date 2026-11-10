// Phase 0 combined Worker: Payload (through OpenNext) and the existing daly.id.au Worker in one script.
// wrangler.jsonc points `main` here. Built only by `npm run poc:build`; never deployed in Phase 0.

// @ts-expect-error: produced by `opennextjs-cloudflare build`
import payload from "../.open-next/worker.js";
import legacy from "../../../worker/index";
import type { Env } from "../../../worker/env";
import { authenticate } from "../../../worker/portal/auth";
import { createPlatformWorker, type PlatformEnv } from "./compose";

// The MCP gateway's service binding target and OpenNext's Durable Objects keep their exports.
export { PortalMcpEntrypoint } from "../../../worker/index";
// @ts-expect-error: produced by `opennextjs-cloudflare build`
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";

export default createPlatformWorker<Env & PlatformEnv>({ legacy, payload, authenticate });
