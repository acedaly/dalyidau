// Phase 1 measurement only: today's Worker alone (no Payload), behind the same outbound lock, so the
// staging timings have a like-for-like baseline. Run with `wrangler dev --remote --env staging
// platform/entry-legacy-baseline.ts`; never deployed.
import "./egress-lock";

export { PortalMcpEntrypoint } from "../../../worker/index";
export { default } from "../../../worker/index";
