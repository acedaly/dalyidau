// The Cloudflare binding Daly Intelligence uses (Workers AI), described narrowly: only the calls this
// code makes. Keeping them as small interfaces means tests and local development can supply a
// deterministic stand-in (below) without any network, account or cost.
//
// The stand-ins are for tests and `AI_PROVIDER=mock` local development only (ENVIRONMENT=development
// on localhost, the same rule as the portal's development sign-in). They are not models: their
// "analysis" is a handful of fixed text patterns. They prove the pipeline (budgets, validation,
// grounding, access checks), never the quality of a real model.

export interface AiRunOptions {
    gateway?: { id: string; skipCache?: boolean; collectLog?: boolean };
}

export interface ConversionResult {
    name: string;
    format: "markdown" | "text" | "error";
    mimeType?: string;
    tokens?: number;
    data?: string;
    error?: string;
}

export interface AiBinding {
    run(model: string, inputs: Record<string, unknown>, options?: AiRunOptions): Promise<unknown>;
    toMarkdown?(files: { name: string; blob: Blob }, options?: { conversionOptions?: Record<string, unknown> }): Promise<ConversionResult | ConversionResult[]>;
}

// --- Deterministic stand-ins ----------------------------------------------------------------------

const SOURCE_START = "<<<SOURCE";
const SOURCE_END = "SOURCE>>>";

/** The untrusted source a prompt carried (see prompts.ts), or the whole text. */
const sourceOf = (prompt: string) => {
    const start = prompt.indexOf(SOURCE_START);
    const end = prompt.lastIndexOf(SOURCE_END);
    return start >= 0 && end > start ? prompt.slice(prompt.indexOf("\n", start) + 1, end) : prompt;
};

// Home & Assets capture (worker/assets/capture.ts): fixed patterns over the document's text.
const auDate = (text: string) => {
    const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1];
    if (iso) return iso;
    const au = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(text);
    return au ? `${au[3]}-${au[2].padStart(2, "0")}-${au[1].padStart(2, "0")}` : null;
};
const dollars = (line: string) => {
    const m = /\$\s?([\d,]+(?:\.\d{2})?)/.exec(line);
    return m ? Number(m[1].replace(/,/g, "")) : null;
};

function mockAssetCapture(task: string, source: string) {
    // PDF structure lines (%PDF-1.4, %%EOF) aren't content.
    const all = source
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("%"));
    if (task === "asset_receipt") {
        const total = all.find((l) => /total/i.test(l));
        return {
            merchant: all[0] ?? null,
            purchaseDate: auDate(source),
            items: all
                .filter((l) => dollars(l) !== null && !/total|gst|tax/i.test(l))
                .map((l) => ({ description: l.replace(/\$.*$/, "").trim(), amount: dollars(l) })),
            total: total ? dollars(total) : null,
            warranty: all.find((l) => /warranty/i.test(l)) ?? null,
            documentKind: /invoice/i.test(source) ? "invoice" : "receipt",
        };
    }
    if (task === "asset_photo") {
        const maker = /(?:logo|brand|badge) reading ([A-Z][\w-]+)/.exec(source)?.[1] ?? null;
        const modelName = /model ([A-Z0-9][\w-]+)/.exec(source)?.[1] ?? null;
        const type = /photo of an? ([a-z][a-z -]+?)(?: with| on|[.,]|$)/i.exec(source)?.[1] ?? null;
        return {
            itemType: type,
            manufacturer: maker,
            model: modelName,
            category: /drill|saw|tool/i.test(source) ? "tools" : null,
            description: all[0]?.slice(0, 200) ?? null,
        };
    }
    const field = (label: RegExp) =>
        all
            .find((l) => label.test(l))
            ?.replace(label, "")
            .trim() || null;
    const period = all.find((l) => /period of insurance/i.test(l)) ?? "";
    const dates = [...period.matchAll(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/g)].map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
    const premium = all.find((l) => /premium/i.test(l));
    const excess = all.find((l) => /excess/i.test(l));
    return {
        provider: field(/^insurer:\s*/i),
        reference: field(/^policy number:\s*/i),
        startsOn: dates[0] ?? null,
        renewsOn: dates[1] ?? null,
        premium: premium ? dollars(premium) : null,
        excess: excess ? dollars(excess) : null,
        policyType: /caravan|trailer/i.test(source) ? "caravan_trailer" : /motor|vehicle/i.test(source) ? "motor" : null,
        coverage: all.filter((l) => /^covered:/i.test(l)).map((l) => ({ statement: l.replace(/^covered:\s*/i, ""), evidence: l })),
        exclusions: all.filter((l) => /^not covered:/i.test(l)).map((l) => ({ statement: l.replace(/^not covered:\s*/i, ""), evidence: l })),
    };
}

function mockText(model: string, inputs: Record<string, unknown>) {
    const messages = (inputs.messages as { role: string; content: string }[] | undefined) ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
    const task = /TASK: ([a-z_]+)/.exec(system)?.[1] ?? "summarise";
    const source = sourceOf(user);
    let body: unknown;
    if (task.startsWith("asset_")) body = mockAssetCapture(task, source);
    else if (task === "briefing") {
        const ids = [...source.matchAll(/^\[([^\]\s]+)\]/gm)].map((m) => m[1]);
        body = { recommendations: ids.slice(0, 2).map((id) => ({ text: "Consider handling this first.", refs: [id] })) };
    } else body = { summary: source.replace(/\s+/g, " ").trim().slice(0, 300) };
    const response = JSON.stringify(body);
    return { response, usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: Math.ceil(response.length / 4) }, model };
}

export const mockAi = (): AiBinding => ({
    async run(model, inputs) {
        return mockText(model, inputs);
    },
    async toMarkdown(file) {
        const bytes = new Uint8Array(await file.blob.arrayBuffer());
        // An image's "description" is any readable text embedded in it (tests put one there).
        if (file.blob.type.startsWith("image/")) {
            const runs = new TextDecoder("latin1").decode(bytes).match(/[\x20-\x7e]{16,}/g) ?? [];
            return { name: file.name, format: "markdown", tokens: 20, data: runs.join("\n") || "A photo." };
        }
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const printable = text.replace(/[^\x20-\x7e\n\r\t]/g, "");
        return {
            name: file.name,
            format: "markdown",
            tokens: Math.ceil(printable.length / 4),
            data: printable.length > 20 ? printable : `# ${file.name}\n\n(no text found)`,
        };
    },
});
