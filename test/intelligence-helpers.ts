// Helpers for the Daly Intelligence tests. Every identity and record is fictional.
//
// Models are never called: `scriptedAi` wraps the deterministic stand-in (worker/intelligence/
// bindings.ts) and lets a test replace any answer, make a call fail, or count calls. Passing these
// tests says nothing about the quality of a real model.
import { expect } from "vitest";
import { DEFAULT_CONFIG, type IntelligenceConfig } from "../src/shared/intelligence/config";
import type { Env } from "../worker/env";
import { type AiBinding, mockAi } from "../worker/intelligence/bindings";
import { processJobs } from "../worker/intelligence/jobs";
import { jobHandlers } from "../worker/intelligence/runner";
import { loadConfig } from "../worker/intelligence/settings";
import { OWNER, apiCall, portalEnv } from "./portal-helpers";

export const I = "/api/portal/intelligence";

export interface Script {
    /** Replaces a text model's answer. Receives the system and user prompts. Throw to fail the call. */
    text?: (system: string, user: string, model: string) => string | Promise<string>;
    toMarkdown?: (name: string, bytes: Uint8Array) => unknown;
}

export interface ScriptedAi extends AiBinding {
    calls: { model: string; kind: "text" | "document" }[];
    script: Script;
}

export function scriptedAi(script: Script = {}): ScriptedAi {
    const base = mockAi();
    const ai: ScriptedAi = {
        calls: [],
        script,
        async run(model, inputs, options) {
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

/** An environment with the stand-in AI (off until switched on). */
export async function aiEnv(script: Script = {}, overrides: Partial<Env> = {}) {
    const ai = scriptedAi(script);
    const env = await portalEnv({ AI: ai, ...overrides });
    return { env, ai };
}

export const ALL_ON: IntelligenceConfig["features"] = {
    enabled: true,
    documents: true,
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

/** Runs whatever is queued. */
export async function drain(env: Env) {
    const { config } = await loadConfig(env.DB);
    return processJobs(env, config, jobHandlers(env), { deadline: Date.now() + 20_000, maxJobs: 20 });
}
