// The one piece of the "cloudflare:workers" runtime module this Worker uses: WorkerEntrypoint, for
// the MCP gateway's service-binding entrypoint (worker/mcp/entrypoint.ts). The project loads the
// Workers types by explicit import rather than globally, so the module is declared here.
declare module "cloudflare:workers" {
    import type { ExecutionContext } from "@cloudflare/workers-types";

    export abstract class WorkerEntrypoint<Env = unknown> {
        protected readonly ctx: ExecutionContext;
        protected readonly env: Env;
        constructor(ctx: ExecutionContext, env: Env);
    }
}
