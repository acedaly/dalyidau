// Local stand-in for Amplenote (fixtures/amplenote/mock-api.mjs) for development and browser tests:
// `npm run mock:amplenote`, then AMPLENOTE_TEST_BASE=http://localhost:8792 with ENVIRONMENT=development.
// POST /__control {"action":"unpublish","args":[uuid]} changes the invented notes.
import { createServer } from "node:http";
import { createAmplenoteMock } from "../fixtures/amplenote/mock-api.mjs";

const port = Number(process.env.PORT ?? 8792);
const base = `http://localhost:${port}`;
const { handle, control } = createAmplenoteMock({ apiBase: `${base}/api`, loginBase: `${base}/login`, publicBase: `${base}/public`, imageBase: base });

createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (req.url === "/health") return res.writeHead(200).end("ok");
    if (req.url === "/__control" && req.method === "POST") {
        const { action, args = [] } = JSON.parse(body.toString() || "{}");
        if (typeof control[action] !== "function") return res.writeHead(400).end("unknown action");
        const result = control[action](...args);
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: result ?? null }));
    }

    // Only the headers the stand-in reads: hop-by-hop headers from the Worker's fetch would make Request() throw.
    const headers = Object.fromEntries(["authorization", "content-type", "accept", "cookie"].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    let response;
    try {
        response = await handle(
            new Request(`${base}${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }),
        );
    } catch (error) {
        console.error(error);
        return res.writeHead(500).end("mock error");
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`Mock Amplenote on ${base}`));
