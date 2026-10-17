// Helpers for what the Worker writes to its logs. Logs are kept by Cloudflare, so they must never
// carry a credential.

/**
 * A request path that's safe to log. Webhook URLs carry their secret as a path segment (older
 * provider configurations), so it's replaced; query strings, which carry signed invitation links,
 * are never part of a pathname.
 */
export const loggablePath = (path: string) => path.replace(/^(\/api\/comms\/webhooks\/[^/]+)\/.+$/, "$1/[secret]");
