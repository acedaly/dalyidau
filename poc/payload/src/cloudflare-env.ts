import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * The Worker's bindings, for code that runs outside a route (hooks, migrations). In the deployed
 * Worker that's the request's context; under the CLI and in local development it's the platform
 * proxy that payload.config.ts opened.
 */
export async function cloudflareEnv<T = Record<string, unknown>>(): Promise<T> {
  const local = (globalThis as { __payloadLocalEnv?: unknown }).__payloadLocalEnv
  if (local) return local as T
  const { env } = await getCloudflareContext({ async: true })
  return env as unknown as T
}
