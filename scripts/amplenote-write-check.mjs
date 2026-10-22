// Checks what Amplenote's REST API does with new notes, text and tasks, before the assistant tools'
// task properties are switched on (docs/AMPLENOTE.md#ai-assistants). Run it yourself, in your own
// terminal, with your approved application. It never edits or deletes an existing note.
//
//   node scripts/amplenote-write-check.mjs start [--redirect https://daly.id.au/blog]
//       prints the Amplenote sign-in link, asking for notes:list, notes:create and
//       notes:create-content-action. Open it and approve.
//   node scripts/amplenote-write-check.mjs finish "<the full address you were sent to>"
//       READ-ONLY. Exchanges the code and reports: the scopes granted, the spec's OAuth scopes, and
//       everything the spec says about POST /notes, POST /notes/{uuid}/actions and the check_list_item
//       node (its attributes). Nothing in your Amplenote changes.
//   node scripts/amplenote-write-check.mjs finish "<address>" --write
//       Also creates ONE new note, "Daly MCP write check (safe to delete)", tagged daly/mcp-check, and
//       adds to that note only: a paragraph, a plain task, and one task per candidate attribute below,
//       each in its own request. It reports each answer. Then open the note in Amplenote and say which
//       tasks show a due date, a reminder or a priority. Delete the note when you're done.
//
// Tokens are never printed or saved; the PKCE verifier is kept in a private temp file between the
// two steps and deleted after `finish`.
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const API = "https://api.amplenote.com";
const LOGIN = "https://login.amplenote.com/login";
const SPEC = "https://api.amplenote.com/doc/swagger.json";
const SCOPE = "notes:list notes:create notes:create-content-action";
const PENDING = path.join(tmpdir(), "amplenote-write-check.json");
const NOTE_NAME = "Daly MCP write check (safe to delete)";
const NOTE_TAG = "daly/mcp-check";

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
};
const flag = (name) => rest.includes(`--${name}`);
const b64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const clientId = process.env.AMPLENOTE_CLIENT_ID;
if (!clientId) {
    console.error("Set AMPLENOTE_CLIENT_ID in your shell first (and AMPLENOTE_CLIENT_SECRET if your application has one).");
    process.exit(1);
}

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
    console.error('Usage: start [--redirect URL] | finish "<redirected address>" [--write]');
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

const line = (text) => console.log(text);

// 1. The spec: scopes, the two write endpoints and anything about task nodes.
const spec = await fetch(SPEC)
    .then((r) => r.json())
    .catch(() => null);
if (spec) {
    const oauth = Object.values(spec.securityDefinitions ?? {})[0];
    line(`Spec ${spec.info?.title ?? ""} ${spec.info?.version ?? ""}; OAuth scopes: ${Object.keys(oauth?.scopes ?? {}).join(", ") || "(none listed)"}`);
    for (const p of ["/notes", "/notes/{uuid}/actions"]) {
        const post = spec.paths?.[p]?.post;
        line(`POST ${p}: ${post ? JSON.stringify({ parameters: post.parameters, responses: post.responses }).slice(0, 4000) : "(not in spec)"}`);
    }
    const definitions = spec.definitions ?? spec.components?.schemas ?? {};
    const relevant = Object.entries(definitions).filter(
        ([name, def]) => /node|task|check|action|insert/i.test(name) || /check_list_item/.test(JSON.stringify(def)),
    );
    line(`Definitions mentioning nodes, tasks or actions: ${relevant.length}`);
    for (const [name, def] of relevant) line(`  ${name}: ${JSON.stringify(def).slice(0, 3000)}`);
    const raw = JSON.stringify(spec);
    for (const word of ["check_list_item", "startAt", "due", "important", "urgent", "hideUntil", "remind", "priority"])
        line(`  spec mentions "${word}": ${raw.includes(word)}`);
} else line("Couldn't download the spec");

// 2. The code exchange.
const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: returned.searchParams.get("code") ?? "",
    redirect_uri: pending.redirect,
    code_verifier: pending.verifier,
    client_id: clientId,
});
if (process.env.AMPLENOTE_CLIENT_SECRET) body.set("client_secret", process.env.AMPLENOTE_CLIENT_SECRET);
const tokenResponse = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
});
const tokens = await tokenResponse.json().catch(() => null);
line(`Token exchange: ${tokenResponse.status}; scope returned: ${tokens?.scope ?? "(none)"}`);
if (!tokens?.access_token) process.exit(1);
const access = tokens.access_token;

if (!flag("write")) {
    line("\nRead-only run: nothing in your Amplenote changed. Paste the lines above back into the conversation.");
    process.exit(0);
}

// 3. Writes, only after a typed confirmation, and only to one new note.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nThis creates one new note "${NOTE_NAME}" and adds test content to it. Type "create" to go ahead: `);
rl.close();
if (answer.trim() !== "create") {
    line("Stopped. Nothing was written.");
    process.exit(0);
}

const post = async (p, json) => {
    const response = await fetch(`${API}${p}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(json),
    });
    const text = await response.text();
    return { status: response.status, text: text.slice(0, 500) };
};

const created = await post("/v4/notes", { name: NOTE_NAME, tags: [{ text: NOTE_TAG }] });
line(`POST /v4/notes: ${created.status}; body: ${created.text}`);
let uuid = null;
try {
    const parsed = JSON.parse(created.text);
    uuid = parsed?.uuid ?? parsed?.note?.uuid ?? null;
} catch {}
line(`  note uuid read from: ${uuid ? "the response" : "(not found in the response)"}`);
if (!uuid) process.exit(1);

const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const task = (text, attrs) => ({ type: "check_list_item", ...(attrs ? { attrs } : {}), content: [paragraph(text)] });
// Tomorrow at 09:00 in this machine's time zone, as Unix seconds.
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(9, 0, 0, 0);
const at = Math.floor(tomorrow.getTime() / 1000);

const cases = [
    ["paragraph", [paragraph("A paragraph added by the write check.")]],
    ["T1 plain task", [task("T1 plain task")]],
    ["T2 startAt (tomorrow 9am)", [task("T2 startAt tomorrow 9am", { startAt: at })]],
    ["T3 due (tomorrow 9am)", [task("T3 due tomorrow 9am", { due: at })]],
    ["T4 important", [task("T4 important", { important: true })]],
    ["T5 urgent", [task("T5 urgent", { urgent: true })]],
    ["T6 hideUntil (tomorrow 9am)", [task("T6 hideUntil tomorrow 9am", { hideUntil: at })]],
    ["T7 unknown attribute", [task("T7 unknown attribute", { notARealAttribute: true })]],
];
for (const [label, nodes] of cases) {
    const result = await post(`/v4/notes/${uuid}/actions`, { type: "INSERT_NODES", nodes });
    line(`INSERT_NODES ${label}: ${result.status}${result.text ? `; body: ${result.text}` : ""}`);
}
line(`\nOpen "${NOTE_NAME}" in Amplenote and note, for each task T1–T7: whether it appears, where in the note, and`);
line("whether it shows a start/due date, a reminder, or Important/Urgent. T7 shows whether unknown attributes are");
line("silently ignored. Paste the lines above and what you saw back into the conversation, then delete the note.");
