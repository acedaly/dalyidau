// Phase 1 staging Worker: the combined Worker (entry.ts) with all outbound requests refused.
// `wrangler.jsonc` env.staging points `main` here. The import order matters: the lock goes first.
import "./egress-lock";

// @ts-expect-error: produced by `opennextjs-cloudflare build`
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";
export { PortalMcpEntrypoint } from "../../../worker/index";
export { default } from "./entry";
