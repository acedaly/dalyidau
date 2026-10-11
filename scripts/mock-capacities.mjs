// Local stand-in for the Capacities API: `npm run mock:capacities`, then point
// CAPACITIES_API_BASE at http://localhost:8790 in .dev.vars.
// POST /__control {"action":"setStatus","args":[id,"Draft"]} changes the sample space for testing.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockApi } from "../fixtures/capacities/mock-api.mjs";

const port = Number(process.env.PORT ?? 8790);
const baseUrl = `http://localhost:${port}`;
const imagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/capacities/images");
const { handle, control } = createMockApi({
    baseUrl,
    readFile: async (name) => {
        if (!/^[\w.-]+$/.test(name)) return null;
        try {
            return await readFile(path.join(imagesDir, name));
        } catch {
            return null;
        }
    },
});

createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (req.url === "/__control" && req.method === "POST") {
        const { action, args = [] } = JSON.parse(body.toString() || "{}");
        if (typeof control[action] !== "function") {
            res.writeHead(400).end("unknown action");
            return;
        }
        control[action](...args);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
    }

    const request = new Request(new URL(req.url, baseUrl), { method: req.method, headers: req.headers });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`Mock Capacities API on ${baseUrl}`));
