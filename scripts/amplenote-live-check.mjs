// Read-only check of the REAL Amplenote API with the owner's approved application, before anything
// is deployed or the registered redirect address is changed (docs/AMPLENOTE.md#checking-the-real-api).
//
//   node scripts/amplenote-live-check.mjs start [--redirect https://daly.id.au/blog]
//       prints the Amplenote sign-in link. Open it and approve; Amplenote sends you to the redirect
//       address with ?code=… in it (the page itself ignores it).
//   node scripts/amplenote-live-check.mjs finish "<the full address you were sent to>" [--token <public note token>]
//       exchanges the code (with the PKCE verifier kept from `start`), refreshes once, lists your
//       notes, and reports what the API returns: field names, counts, your website/blog notes'
//       titles and "public" flags, and whether a public note token appears anywhere in the response.
//
// The client id comes from AMPLENOTE_CLIENT_ID (and AMPLENOTE_CLIENT_SECRET if Amplenote issued one)
// in your shell; never put either in a file. Only the notes:list scope is asked for. Tokens are never
// printed or saved; the PKCE verifier is kept in a private temp file between the two steps and
// deleted after `finish`.
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const API = "https://api.amplenote.com";
const LOGIN = "https://login.amplenote.com/login";
const SPEC = "https://api.amplenote.com/doc/swagger.json";
const SCOPE = "notes:list";
const TAG = (process.env.AMPLENOTE_TAG || "website/blog").toLowerCase();
const PENDING = path.join(tmpdir(), "amplenote-live-check.json");

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
};
const b64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const clientId = process.env.AMPLENOTE_CLIENT_ID;
if (!clientId) {
    console.error("Set AMPLENOTE_CLIENT_ID in your shell first (and AMPLENOTE_CLIENT_SECRET if your application has one).");
    process.exit(1);
}

async function token(params) {
    const body = new URLSearchParams({ ...params, client_id: clientId });
    if (process.env.AMPLENOTE_CLIENT_SECRET) body.set("client_secret", process.env.AMPLENOTE_CLIENT_SECRET);
    const response = await fetch(`${API}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
}

const describeToken = ({ status, data }) =>
    `${status}; fields: ${data ? Object.keys(data).sort().join(", ") : "(not JSON)"}` +
    (data?.expires_in ? `; expires_in ${data.expires_in}s` : "") +
    (data?.scope ? `; scope "${data.scope}"` : "") +
    (data?.error ? `; error "${String(data.error).slice(0, 60)}"` : "");

if (command === "start") {
    const redirect = option("redirect") || "https://daly.id.au/blog";
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    await writeFile(PENDING, JSON.stringify({ state, verifier, redirect, created: Date.now() }), { mode: 0o600 });
    const url = new URL(LOGIN);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
    }).toString();
    console.log(`Open this link, approve, then run "finish" with the address Amplenote sends you to:\n\n${url}\n`);
    process.exit(0);
}

if (command !== "finish" || !rest[0]) {
    console.error('Usage: start [--redirect URL] | finish "<redirected address>" [--token <public note token>]');
    process.exit(1);
}

const pending = JSON.parse(await readFile(PENDING, "utf8").catch(() => "null"));
await rm(PENDING, { force: true });
if (!pending || Date.now() - pending.created > 15 * 60_000) {
    console.error('No recent "start" found (or it is over 15 minutes old). Run start again.');
    process.exit(1);
}
const returned = new URL(rest[0]);
if (returned.searchParams.get("state") !== pending.state) {
    console.error("The state in that address doesn't match the sign-in this script started. Run start again.");
    process.exit(1);
}
if (returned.searchParams.get("error")) {
    console.error(`Amplenote returned an error: ${returned.searchParams.get("error")}`);
    process.exit(1);
}

const report = [];
const line = (text) => {
    report.push(text);
    console.log(text);
};

// 1. What the official spec offers today.
const spec = await fetch(SPEC)
    .then((r) => r.json())
    .catch(() => null);
if (spec) {
    line(`Spec ${spec.info?.title ?? ""} ${spec.info?.version ?? ""}, ${spec.host}${spec.basePath}`);
    for (const [p, methods] of Object.entries(spec.paths ?? {})) line(`  ${Object.keys(methods).join(",").toUpperCase()} ${p}`);
    const oauth = Object.values(spec.securityDefinitions ?? {})[0];
    if (oauth) line(`  OAuth: ${oauth.flow}, scopes ${Object.keys(oauth.scopes ?? {}).join(", ")}`);
} else line("Couldn't download the spec");

// 2. The code exchange (PKCE) and one refresh.
const exchanged = await token({
    grant_type: "authorization_code",
    code: returned.searchParams.get("code") ?? "",
    redirect_uri: pending.redirect,
    code_verifier: pending.verifier,
});
line(`Token exchange: ${describeToken(exchanged)}`);
if (!exchanged.data?.access_token) process.exit(1);
let access = exchanged.data.access_token;
if (exchanged.data.refresh_token) {
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: exchanged.data.refresh_token });
    line(
        `Refresh: ${describeToken(refreshed)}; refresh token rotated: ${refreshed.data?.refresh_token ? refreshed.data.refresh_token !== exchanged.data.refresh_token : "n/a"}`,
    );
    if (refreshed.data?.access_token) access = refreshed.data.access_token;
} else line("No refresh token was issued");

// 3. The note list: what each note carries, and whether anything identifies a public page.
// Amplenote answers with an object holding a `notes` array (and the account's tags), not a bare array.
const listNotes = async (query = "") => {
    const response = await fetch(`${API}/v4/notes${query}`, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {}
    const notes = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.notes) ? parsed.notes : null;
    const shape = parsed === null ? "not JSON" : Array.isArray(parsed) ? "an array" : `an object with keys: ${Object.keys(parsed).sort().join(", ")}`;
    return { status: response.status, text, notes, shape };
};

const full = await listNotes();
line(`GET /v4/notes: ${full.status}, ${full.text.length} bytes; response is ${full.shape}`);
const notes = full.notes ?? [];
const keys = new Set(notes.flatMap((n) => Object.keys(n)));
line(`  ${full.notes ? notes.length : "?"} notes; fields seen: ${[...keys].sort().join(", ")}`);
line(`  timestamps fields: ${[...new Set(notes.flatMap((n) => Object.keys(n.timestamps ?? {})))].sort().join(", ")}`);
line(`  tag value types: ${[...new Set(notes.flatMap((n) => (n.tags ?? []).map((t) => typeof t)))].sort().join(", ") || "(no tags)"}`);
line(`  public: true on ${notes.filter((n) => n.public === true).length} note(s)`);
const tagText = (t) => String(typeof t === "object" && t !== null ? t.text : t).toLowerCase();
const tagged = notes.filter((n) => (n.tags ?? []).some((t) => tagText(t) === TAG));
line(`  Tagged ${TAG}: ${tagged.length}`);
for (const n of tagged) line(`    "${n.name}" public=${n.public} deleted=${!!n.deleted} updated=${n.timestamps?.updated ?? "?"}`);
line(`  Mentions public.amplenote.com anywhere: ${full.text.includes("public.amplenote.com")}`);
const publicToken = option("token");
if (publicToken) line(`  Contains the public token ${publicToken.slice(0, 4)}…: ${full.text.includes(publicToken)}`);

const since = Math.floor(Date.now() / 1000) - 86_400;
const changed = await listNotes(`?since=${since}`);
line(`GET /v4/notes?since=<24h ago>: ${changed.status}, response is ${changed.shape}; ${changed.notes ? changed.notes.length : "?"} note(s)`);
console.log("\nNothing was saved. Paste the lines above (they contain no tokens) back into the conversation.");
