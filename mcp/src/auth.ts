// Who is calling mcp.daly.id.au/mcp (docs/MCP.md).
//
// Cloudflare Access (an MCP server application with Managed OAuth) runs the OAuth flow and forwards
// a signed Cf-Access-Jwt-Assertion. This Worker still verifies it (signature against the team's
// keys, issuer, the MCP application's audience, RS256, a stable subject) before any tool is offered.
// Daly Portal then verifies the same token again with its own, independent implementation
// (worker/portal/access.ts) and decides what the person may see. Missing configuration fails closed.
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface McpAuthEnv {
    readonly ENVIRONMENT: string;
    readonly AUTH_MODE: string;
    /** https://<team>.cloudflareaccess.com */
    readonly TEAM_DOMAIN?: string;
    /** The AUD tag of the mcp.daly.id.au Access application. */
    readonly POLICY_AUD?: string;
    /** Local development only: a bearer token of at least 32 characters. */
    readonly DEV_MCP_TOKEN?: string;
}

export interface AuthenticatedMcpActor {
    /** The Access subject: the key for per-person rate limits. */
    readonly subject: string;
    /**
     * The Access assertion exactly as received, so Daly Portal can verify it itself. Forwarded over
     * the private service binding only; never logged, stored or returned. "development" locally.
     */
    readonly assertion: string;
}

export class McpAuthenticationError extends Error {
    readonly status: number;
    constructor(message: string, status = 401) {
        super(message);
        this.name = "McpAuthenticationError";
        this.status = status;
    }
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedIssuer: string | undefined;

function accessJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
    if (cachedJwks === undefined || cachedIssuer !== issuer) {
        cachedIssuer = issuer;
        cachedJwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    }
    return cachedJwks;
}

/** Test hook: forget the cached key set. */
export const resetJwksCache = () => {
    cachedJwks = undefined;
    cachedIssuer = undefined;
};

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [a, b] = [encoder.encode(left), encoder.encode(right)];
    if (a.byteLength !== b.byteLength) return false;
    const [aDigest, bDigest] = await Promise.all([crypto.subtle.digest("SHA-256", a), crypto.subtle.digest("SHA-256", b)]);
    const av = new Uint8Array(aDigest);
    const bv = new Uint8Array(bDigest);
    let difference = 0;
    for (let index = 0; index < av.length; index += 1) difference |= av[index]! ^ bv[index]!;
    return difference === 0;
}

function bearerToken(request: Request): string | null {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice(7);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export async function authenticateMcpRequest(request: Request, env: McpAuthEnv): Promise<AuthenticatedMcpActor> {
    if (env.AUTH_MODE === "development") {
        // Three conditions, so a stray deploy of the development configuration can't be used: the
        // environment says development, the request is to localhost, and a long token matches.
        if (env.ENVIRONMENT !== "development" || !LOCAL_HOSTS.has(new URL(request.url).hostname)) {
            throw new McpAuthenticationError("Development authentication is disabled", 503);
        }
        const supplied = bearerToken(request);
        if (!env.DEV_MCP_TOKEN || env.DEV_MCP_TOKEN.length < 32 || !supplied) throw new McpAuthenticationError("Authentication required");
        if (!(await constantTimeEqual(supplied, env.DEV_MCP_TOKEN))) throw new McpAuthenticationError("Authentication required");
        return { subject: "local-mcp-developer", assertion: "development" };
    }

    if (env.AUTH_MODE !== "cloudflare-access" || !env.TEAM_DOMAIN || !env.POLICY_AUD) {
        throw new McpAuthenticationError("MCP authentication is not configured", 503);
    }
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) throw new McpAuthenticationError("Authentication required");

    const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
    if (!issuer.startsWith("https://") || !issuer.endsWith(".cloudflareaccess.com")) {
        throw new McpAuthenticationError("MCP authentication is not configured", 503);
    }
    try {
        const { payload } = await jwtVerify(token, accessJwks(issuer), { issuer, audience: env.POLICY_AUD, algorithms: ["RS256"] });
        if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new McpAuthenticationError("Authentication required");
        return { subject: payload.sub, assertion: token };
    } catch (cause) {
        if (cause instanceof McpAuthenticationError) throw cause;
        throw new McpAuthenticationError("Authentication required");
    }
}
