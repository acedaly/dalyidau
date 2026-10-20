// The two Cloudflare bindings Daly Intelligence uses, described narrowly: only the calls this code
// makes. Keeping them as small interfaces means tests and local development can supply a
// deterministic stand-in (below) without any network, account or cost.
//
// The stand-ins are for tests and `AI_PROVIDER=mock` local development only (ENVIRONMENT=development
// on localhost, the same rule as the portal's development sign-in). They are not models: their
// "analysis" is a handful of fixed text patterns and their "embeddings" are hashed words. They prove
// the pipeline (budgets, validation, approval, access checks), never the quality of a real model.

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

export interface VectorRecord {
    id: string;
    values: number[];
    namespace?: string;
    metadata?: Record<string, string | number | boolean>;
}

export interface VectorMatch {
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
}

export interface VectorIndex {
    upsert(vectors: VectorRecord[]): Promise<unknown>;
    query(
        vector: number[],
        options: { topK: number; namespace?: string; returnMetadata?: "none" | "indexed" | "all"; returnValues?: boolean },
    ): Promise<{ matches: VectorMatch[] }>;
    deleteByIds(ids: string[]): Promise<unknown>;
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

const lines = (text: string) =>
    text
        .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
        .map((l) => l.trim())
        .filter(Boolean);
const firstDate = (text: string) => /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null;
const quote = (text: string) => text.slice(0, 200);

function mockExtraction(source: string) {
    const items: Record<string, unknown>[] = [];
    const tags = [...new Set([...source.matchAll(/#([A-Za-z][\w-]{1,30})/g)].map((m) => m[1].toLowerCase()))].slice(0, 5);
    let project: string | null = null;
    for (const line of lines(source)) {
        const action = /^(?:[-*]\s*)?(?:\[ \]\s*|TODO:?\s+|Action:?\s+|Task:?\s+)(.+)$/i.exec(line);
        const decision = /^(?:[-*]\s*)?(?:Decision|Decided|We decided)(?::|\s+to|\s+that)?\s+(.+)$/i.exec(line);
        const fact = /^(?:[-*]\s*)?Fact:?\s+(.+)$/i.exec(line);
        const waiting = /waiting (?:on|for) ([A-Z][a-z]+)/.exec(line);
        const projectLine = /^Project:?\s+(.+)$/i.exec(line);
        if (projectLine) project = projectLine[1].replace(/[.]$/, "").trim();
        else if (action) {
            const date = firstDate(action[1]);
            items.push({
                kind: waiting ? "follow_up" : "task",
                title: action[1]
                    .replace(/\s*\bby\s+20\d{2}-\d{2}-\d{2}\b/, "")
                    .replace(/[.]$/, "")
                    .trim(),
                dueDate: date,
                dueText: date ? `by ${date}` : null,
                dateCertainty: date ? "explicit" : "none",
                waitingOn: waiting?.[1] ?? null,
                project,
                evidence: quote(line),
                confidence: 0.8,
            });
        } else if (decision) items.push({ kind: "decision", title: decision[1].replace(/[.]$/, "").trim(), evidence: quote(line), confidence: 0.7 });
        else if (fact) items.push({ kind: "fact", statement: fact[1].trim(), evidence: quote(line), confidence: 0.6 });
        else if (waiting) items.push({ kind: "follow_up", title: line.replace(/[.]$/, ""), waitingOn: waiting[1], evidence: quote(line), confidence: 0.5 });
    }
    const sentences = source
        .replace(/\s+/g, " ")
        .trim()
        .split(/(?<=[.!?])\s+/);
    return { summary: sentences.slice(0, 2).join(" ").slice(0, 400), tags, items, questions: [] };
}

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
    if (task === "extract" || task === "meeting") body = mockExtraction(source);
    else if (task.startsWith("asset_")) body = mockAssetCapture(task, source);
    else if (task === "briefing") {
        const ids = [...source.matchAll(/\[(t(?:sk|pj)_[a-z0-9]{14}|kob_[a-z0-9]{14})\]/g)].map((m) => m[1]);
        body = { recommendations: ids.slice(0, 2).map((id) => ({ text: "Consider handling this first.", refs: [id] })) };
    } else if (task === "classify") body = { tags: [...new Set(source.toLowerCase().match(/[a-z]{6,}/g) ?? [])].slice(0, 3) };
    else body = { summary: source.replace(/\s+/g, " ").trim().slice(0, 300) };
    const response = JSON.stringify(body);
    return { response, usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: Math.ceil(response.length / 4) }, model };
}

/** A few equivalences, so the stand-in's "meaning" search can find what keyword search can't. Tests only. */
const MOCK_SYNONYMS: Record<string, string> = { vehicle: "car", automobile: "car", ute: "car", spending: "budget", money: "budget", costs: "budget" };

const stem = (word: string) => {
    const w = word.toLowerCase();
    const s = w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
    return MOCK_SYNONYMS[s] ?? MOCK_SYNONYMS[w] ?? s;
};

/** Hashed bag of words, unit length. Deterministic and dimension-agnostic. */
export function mockEmbedding(text: string, dimensions = 1024): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (const word of text.match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
        let hash = 2166136261;
        for (const c of stem(word)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
        vector[Math.abs(hash) % dimensions] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((v) => v / norm);
}

export const mockAi = (dimensions = 1024): AiBinding => ({
    async run(model, inputs) {
        if (model.includes("whisper")) {
            const audio = String(inputs.audio ?? "");
            return {
                text: "Project: Garden shed. Action: Order the timber by 2026-11-02. Decision: We will use the north corner of the yard.",
                segments: [{ start: 0, end: 6, text: "Project: Garden shed." }],
                transcription_info: { language: "en", duration: Math.max(1, Math.round((audio.length * 0.75) / 16_000)) },
            };
        }
        if (model.includes("bge") || model.includes("embedding")) {
            const text = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text ?? "")];
            return { shape: [text.length, dimensions], data: text.map((t) => mockEmbedding(t, dimensions)) };
        }
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

export class MemoryVectorIndex implements VectorIndex {
    readonly namespaces = new Map<string, Map<string, VectorRecord>>();

    async upsert(vectors: VectorRecord[]) {
        for (const v of vectors) {
            const ns = this.namespaces.get(v.namespace ?? "") ?? new Map();
            ns.set(v.id, v);
            this.namespaces.set(v.namespace ?? "", ns);
        }
        return { count: vectors.length };
    }

    async query(vector: number[], options: { topK: number; namespace?: string }) {
        const ns = this.namespaces.get(options.namespace ?? "") ?? new Map<string, VectorRecord>();
        const matches = [...ns.values()]
            .map((v) => ({ id: v.id, score: v.values.reduce((sum, x, i) => sum + x * (vector[i] ?? 0), 0), metadata: v.metadata }))
            .sort((a, b) => b.score - a.score)
            .slice(0, options.topK);
        return { matches };
    }

    async deleteByIds(ids: string[]) {
        for (const ns of this.namespaces.values()) for (const id of ids) ns.delete(id);
        return { count: ids.length };
    }

    size() {
        return [...this.namespaces.values()].reduce((n, ns) => n + ns.size, 0);
    }
}
