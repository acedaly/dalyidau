import { applyD1Migrations, env } from "cloudflare:test";
import type { Env } from "../worker/env";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(bindings.DB as unknown as Parameters<typeof applyD1Migrations>[0], bindings.TEST_MIGRATIONS);
