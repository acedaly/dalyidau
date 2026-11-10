// Invented Cloudflare Access identity for local Phase 0 runs only.
//   node scripts/test-identity.mjs init          → key pair in .poc-keys/, .dev.vars for wrangler dev
//   node scripts/test-identity.mjs init --staging → .dev.vars.staging, for `wrangler dev --remote --env staging`
//                                                  (a private measurement session on Cloudflare; never deployed)
//   node scripts/test-identity.mjs token <email> → a signed Access-style JWT for that email
// The verifier accepts these only with ENVIRONMENT=development or test (worker/portal/access.ts).
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const keyFile = path.join(root, ".poc-keys", "access-test-key.pem");
export const TEAM = "daly-poc.cloudflareaccess.com";
export const AUD = "aud-payload-poc-0123456789";
export const OWNER = "owner@example.test";
const b64url = (b) => Buffer.from(b).toString("base64url");

export function token(email, { aud = AUD, expiresIn = 3600 } = {}) {
    const key = createPrivateKey(readFileSync(keyFile));
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", kid: "poc-key-1", typ: "JWT" };
    const claims = { aud: [aud], iss: `https://${TEAM}`, sub: `sub-${email}`, iat: now, exp: now + expiresIn, type: "app", email };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${unsigned}.${b64url(sign("RSA-SHA256", Buffer.from(unsigned), key))}`;
}

if (process.argv[2] === "init") {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    if (!existsSync(keyFile)) {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    const jwk = createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ format: "jwk" });
    const vars = {
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: AUD,
        ACCESS_TEST_JWKS: JSON.stringify({ keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", kid: "poc-key-1" }] }),
        PORTAL_OWNER_EMAILS: OWNER,
        RSVP_LINK_SECRET: randomBytes(32).toString("hex"),
        PAYLOAD_SECRET: randomBytes(32).toString("hex"),
        PAYLOAD_JOBS_SECRET: randomBytes(32).toString("hex"),
        COMMS_WEBHOOK_SECRET: randomBytes(24).toString("hex"),
    };
    // The verifier accepts the invented key only in a development session, so the measurement session
    // is one. The deployed staging Worker keeps ENVIRONMENT=staging and has none of these.
    const staging = process.argv.includes("--staging");
    if (staging) vars.ENVIRONMENT = "development";
    writeFileSync(path.join(root, staging ? ".dev.vars.staging" : ".dev.vars"), Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join("\n") + "\n", { mode: 0o600 });
    console.log(`Wrote ${staging ? ".dev.vars.staging" : ".dev.vars"} and .poc-keys/ (both git-ignored).`);
} else if (process.argv[2] === "token") {
    console.log(token(process.argv[3] ?? OWNER));
}
