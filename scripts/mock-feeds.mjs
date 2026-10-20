// Local stand-in for the Intelligence Centre's public sources (development and browser tests only):
// `npm run mock:feeds`, then set CENTRE_FEED_BASE=http://localhost:8791 in .dev.vars. The Worker only
// honours it with ENVIRONMENT=development on a localhost SITE_URL (worker/centre/net.ts).
//
// Serves the INVENTED fixtures in fixtures/intelligence-centre/feeds.mjs as /<host>/<path>, and the
// Bureau's FTP files as /ftp/<host>/<path> (with ?list=<glob> for a directory listing). Records
// collected from here are marked as fixture data everywhere they appear.
import { createServer } from "node:http";
import { feedFixtures, tfnswHazards } from "../fixtures/intelligence-centre/feeds.mjs";

const port = Number(process.env.PORT ?? 8791);

createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const now = new Date();
    const fixtures = feedFixtures(now);
    const send = (status, body, type = "application/octet-stream") => res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
    if (url.pathname === "/health") return send(200, "ok", "text/plain");
    if (url.pathname.startsWith("/ftp/")) {
        const [, , host, ...rest] = url.pathname.split("/");
        const path = `/${rest.join("/")}`;
        const list = url.searchParams.get("list");
        if (list) {
            const re = new RegExp(`^${list.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
            const minute = `${new Date(now.getTime() - 60_000).toISOString().slice(0, 16)}:00Z`;
            const entries = Object.keys(fixtures)
                .filter((k) => k.startsWith(`ftp://${host}${path}/`))
                .map((k) => k.slice(`ftp://${host}${path}/`.length))
                .filter((name) => re.test(name))
                .map((name) => ({ name, modified: minute, size: fixtures[`ftp://${host}${path}/${name}`].length }));
            return send(200, JSON.stringify(entries), "application/json");
        }
        const body = fixtures[`ftp://${host}${path}`];
        return body === undefined ? send(404, "not found") : send(200, body);
    }
    const [, host, ...rest] = url.pathname.split("/");
    const target = `https://${host}/${rest.join("/")}`;
    const tfnsw = /^https:\/\/api\.transport\.nsw\.gov\.au\/v1\/live\/hazards\/(\w+)\/open$/.exec(target);
    if (tfnsw) return send(200, tfnswHazards(now, tfnsw[1]), "application/json");
    const body = fixtures[target];
    return body === undefined ? send(404, "not found") : send(200, body);
}).listen(port, () => console.log(`Mock public feeds (invented fixtures) on http://localhost:${port}`));
