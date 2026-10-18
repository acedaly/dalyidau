// Helpers for the Daly Intelligence tests. Every identity, note, recording and document is fictional.
//
// Models are never called: `scriptedAi` wraps the deterministic stand-in (worker/intelligence/
// bindings.ts) and lets a test replace any answer, make a call fail, or count calls. Passing these
// tests says nothing about the quality of a real model; the optional live evaluation does that.
import { expect } from "vitest";
import { DEFAULT_CONFIG, type IntelligenceConfig } from "../src/shared/intelligence/config";
import type { Env } from "../worker/env";
import { type AiBinding, MemoryVectorIndex, mockAi } from "../worker/intelligence/bindings";
import { processJobs } from "../worker/intelligence/jobs";
import { jobHandlers } from "../worker/intelligence/runner";
import { loadConfig } from "../worker/intelligence/settings";
import { OWNER, apiCall, portalEnv } from "./portal-helpers";

export const I = "/api/portal/intelligence";

export interface Script {
    /** Replaces a text model's answer. Receives the system and user prompts. Throw to fail the call. */
    text?: (system: string, user: string, model: string) => string | Promise<string>;
    embed?: (texts: string[]) => number[][] | Promise<number[][]>;
    transcribe?: (audioBase64: string, inputs: Record<string, unknown>) => unknown;
    toMarkdown?: (name: string, bytes: Uint8Array) => unknown;
}

export interface ScriptedAi extends AiBinding {
    calls: { model: string; kind: "text" | "embed" | "transcribe" | "document" }[];
    script: Script;
}

export function scriptedAi(script: Script = {}): ScriptedAi {
    const base = mockAi(1024);
    const ai: ScriptedAi = {
        calls: [],
        script,
        async run(model, inputs, options) {
            if (model.includes("whisper")) {
                ai.calls.push({ model, kind: "transcribe" });
                return ai.script.transcribe ? ai.script.transcribe(String(inputs.audio), inputs) : base.run(model, inputs, options);
            }
            if (model.includes("bge") || model.includes("embedding")) {
                ai.calls.push({ model, kind: "embed" });
                const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)];
                return ai.script.embed ? { data: await ai.script.embed(texts) } : base.run(model, inputs, options);
            }
            ai.calls.push({ model, kind: "text" });
            if (ai.script.text) {
                const messages = inputs.messages as { role: string; content: string }[];
                const response = await ai.script.text(messages[0].content, messages[1].content, model);
                return { response, usage: { prompt_tokens: 1_000, completion_tokens: 200 } };
            }
            return base.run(model, inputs, options);
        },
        async toMarkdown(file, options) {
            ai.calls.push({ model: "tomarkdown", kind: "document" });
            if (ai.script.toMarkdown) return ai.script.toMarkdown(file.name, new Uint8Array(await file.blob.arrayBuffer())) as never;
            return base.toMarkdown!(file, options);
        },
    };
    return ai;
}

/** An environment with the stand-in AI and an in-memory vector index (both off until switched on). */
export async function aiEnv(script: Script = {}, overrides: Partial<Env> = {}) {
    const ai = scriptedAi(script);
    const vectors = new MemoryVectorIndex();
    const env = await portalEnv({ AI: ai, VECTORS: vectors, ...overrides });
    return { env, ai, vectors };
}

export const ALL_ON: IntelligenceConfig["features"] = {
    enabled: true,
    semanticSearch: true,
    capture: true,
    documents: true,
    meetings: true,
    briefingRecommendations: true,
    scheduled: true,
};

/** Saves the account configuration as the owner (features all on unless given). */
export async function configure(env: Env, change: Partial<IntelligenceConfig> = {}) {
    const { version } = await loadConfig(env.DB);
    const config = { ...DEFAULT_CONFIG, features: ALL_ON, ...change };
    const result = await apiCall("PUT", `${I}/settings`, { version, config }, { env });
    expect(result.status, result.text).toBe(200);
    return config;
}

export const iCall = <T = unknown>(env: Env, method: string, path: string, body?: unknown, email = OWNER) =>
    apiCall<T>(method, `${I}${path}`, body, { email, env });

/** Runs whatever is queued (the request's own nudge normally already did). */
export async function drain(env: Env) {
    const { config } = await loadConfig(env.DB);
    return processJobs(env, config, jobHandlers(env), { deadline: Date.now() + 20_000, maxJobs: 20 });
}

/** A model answer in the extraction shape. */
export const extraction = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ summary: "A short summary.", tags: [], items, questions: [], ...extra });

export const base64 = (bytes: Uint8Array) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};

/** Uploads a file through the chunked attachment API and returns its id. */
export async function upload(env: Env, filename: string, bytes: Uint8Array, kind: "audio" | "document", email = OWNER) {
    const started = await iCall<{ id: string; partBytes: number; parts: number }>(env, "POST", "/attachments", { filename, bytes: bytes.length, kind }, email);
    expect(started.status, started.text).toBe(201);
    const { id, partBytes, parts } = started.json;
    for (let n = 1; n <= parts; n++) {
        const part = await iCall(env, "POST", `/attachments/${id}/parts/${n}`, { data: base64(bytes.subarray((n - 1) * partBytes, n * partBytes)) }, email);
        expect(part.status, part.text).toBe(200);
    }
    const done = await iCall(env, "POST", `/attachments/${id}/complete`, undefined, email);
    expect(done.status, done.text).toBe(200);
    return id;
}

/** A PCM WAV file of silence. */
export function wav(seconds: number, sampleRate = 8_000): Uint8Array {
    const data = Math.round(seconds * sampleRate) * 2;
    const out = new Uint8Array(44 + data);
    const view = new DataView(out.buffer);
    const write = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
    write(0, "RIFF");
    view.setUint32(4, 36 + data, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, data, true);
    return out;
}
