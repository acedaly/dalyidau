// The one way any part of the portal calls a model.
//
// Each call: refuse if Intelligence is off or the binding is missing; refuse while the circuit is
// open (the provider kept failing); check the budgets against an estimate; run with a timeout;
// record usage (never content); and turn every provider failure into a small set of codes the
// callers and the UI understand. Structured output is parsed and validated with a strict schema:
// anything that doesn't fit is a `malformed_output` error, never a guess.
import type { z } from "zod";
import { type BudgetFeature, type IntelligenceConfig, estimateTextNeurons, estimateTokens, modelById } from "../../src/shared/intelligence/config";
import type { Env } from "../env";
import { HttpError } from "../portal/http";
import type { AiRunOptions } from "./bindings";
import { aiBinding } from "./settings";
import { type UsageRow, checkBudget, circuitOpen, recordUsage } from "./usage";

export type AiErrorCode = "ai_off" | "not_configured" | "ai_unavailable" | "timeout" | "malformed_output" | "provider_error" | "too_large";

export class AiError extends HttpError {
    constructor(
        readonly aiCode: AiErrorCode,
        message: string,
        status = aiCode === "ai_off" || aiCode === "not_configured" ? 409 : aiCode === "too_large" ? 413 : 503,
    ) {
        super(status, aiCode, message);
    }
}

export const MESSAGES: Record<AiErrorCode, string> = {
    ai_off: "Intelligence is switched off. An owner can switch it on in Intelligence settings.",
    not_configured: "Workers AI isn't connected to this portal yet (docs/INTELLIGENCE.md, activation).",
    ai_unavailable: "Workers AI isn't responding right now. Nothing was changed; try again in a few minutes.",
    timeout: "The model took too long to answer. Nothing was changed; try again, or with less text.",
    malformed_output: "The model's answer couldn't be understood, so it was discarded. Try again.",
    provider_error: "Workers AI refused the request. Nothing was changed.",
    too_large: "That is more than the model can take in one go.",
};

export interface AiContext {
    env: Env;
    config: IntelligenceConfig;
    /** The person the work is for. */
    email: string | null;
    feature: BudgetFeature;
    jobId?: string | null;
}

type Role = keyof IntelligenceConfig["models"];
const ROLE_TASK: Record<Role, UsageRow["task"]> = {
    extract: "extract",
    summarise: "summarise",
    synthesis: "generate",
};

const options = (env: Env): AiRunOptions | undefined =>
    // Through AI Gateway when one is configured. Log collection is asked to be off: prompts carry private notes.
    env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } } : undefined;

const withTimeout = async <T>(work: Promise<T>, seconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiError("timeout", MESSAGES.timeout)), seconds * 1000);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
};

/** Workers AI error messages carry numeric codes; capacity and rate limits are "unavailable", the rest refusals. */
const classify = (error: unknown): { code: AiErrorCode; usageCode: string } => {
    if (error instanceof AiError) return { code: error.aiCode, usageCode: error.aiCode === "timeout" ? "timeout" : error.aiCode };
    const message = String((error as Error)?.message ?? error);
    if (/3040|capacity|429|rate limit|too many/i.test(message)) return { code: "ai_unavailable", usageCode: "capacity" };
    if (/5\d\d|network|fetch failed|internal/i.test(message)) return { code: "ai_unavailable", usageCode: "unavailable" };
    if (/too (large|long)|maximum context|context length|3006|3007/i.test(message)) return { code: "too_large", usageCode: "too_large" };
    return { code: "provider_error", usageCode: "provider_error" };
};

interface Measured {
    inputUnits: number;
    outputUnits: number;
    neurons: number;
    measured: boolean;
}

/** The common path for every call. `measure` turns the response into usage. */
async function call<T>(
    ctx: AiContext,
    request: { role: Role | "document"; model: string; inputs: Record<string, unknown>; estimate: number; unit: UsageRow["unit"] },
    run: (binding: NonNullable<ReturnType<typeof aiBinding>>) => Promise<T>,
    measure: (result: T) => Measured,
): Promise<T> {
    if (!ctx.config.features.enabled) throw new AiError("ai_off", MESSAGES.ai_off);
    const binding = aiBinding(ctx.env);
    if (!binding) throw new AiError("not_configured", MESSAGES.not_configured);
    if (await circuitOpen(ctx.env.DB)) throw new AiError("ai_unavailable", MESSAGES.ai_unavailable);
    await checkBudget(ctx.env.DB, ctx.config, { email: ctx.email, feature: ctx.feature, estimate: request.estimate });
    const task = request.role === "document" ? "document" : ROLE_TASK[request.role];
    const started = Date.now();
    const base = {
        email: ctx.email,
        feature: ctx.feature,
        task,
        provider: "workers-ai",
        model: request.model,
        unit: request.unit,
        jobId: ctx.jobId ?? null,
    };
    let result: T;
    try {
        result = await withTimeout(run(binding), ctx.config.limits.callTimeoutSeconds);
    } catch (error) {
        const { code, usageCode } = classify(error);
        await recordUsage(ctx.env.DB, {
            ...base,
            inputUnits: 0,
            outputUnits: 0,
            neurons: 0,
            measured: false,
            durationMs: Date.now() - started,
            ok: false,
            errorCode: usageCode,
        });
        // The operational log names the model and the outcome, never the person or the content.
        console.log(JSON.stringify({ event: "ai_call_failed", model: request.model, feature: ctx.feature, code: usageCode }));
        throw new AiError(code, MESSAGES[code]);
    }
    const usage = measure(result);
    await recordUsage(ctx.env.DB, { ...base, ...usage, durationMs: Date.now() - started, ok: true });
    return result;
}

// --- Text ------------------------------------------------------------------------------------------

interface TextResponse {
    response?: unknown;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const textOf = (result: TextResponse): string => {
    if (typeof result.response === "string") return result.response;
    if (result.response && typeof result.response === "object") return JSON.stringify(result.response);
    return result.choices?.[0]?.message?.content ?? "";
};

export interface TextRequest {
    role: Role;
    system: string;
    prompt: string;
    maxTokens: number;
}

export async function generateText(ctx: AiContext, request: TextRequest): Promise<{ text: string; model: string }> {
    const model = ctx.config.models[request.role];
    const inputTokens = estimateTokens(request.system.length + request.prompt.length);
    const estimate = estimateTextNeurons(model, inputTokens, request.maxTokens);
    const result = await call<TextResponse>(
        ctx,
        { role: request.role, model, inputs: {}, estimate, unit: "tokens" },
        (ai) =>
            ai.run(
                model,
                {
                    messages: [
                        { role: "system", content: request.system },
                        { role: "user", content: request.prompt },
                    ],
                    max_tokens: request.maxTokens,
                    temperature: 0.2,
                },
                options(ctx.env),
            ) as Promise<TextResponse>,
        (r) => {
            const measured = typeof r?.usage?.prompt_tokens === "number" && typeof r?.usage?.completion_tokens === "number";
            const inputUnits = measured ? r.usage!.prompt_tokens! : inputTokens;
            const outputUnits = measured ? r.usage!.completion_tokens! : estimateTokens(textOf(r ?? {}).length);
            return { inputUnits, outputUnits, neurons: estimateTextNeurons(model, inputUnits, outputUnits), measured };
        },
    );
    return { text: textOf(result ?? {}), model };
}

/** The first JSON object in a model's answer (models sometimes wrap it in prose or a code fence). */
export function firstJsonObject(text: string): unknown {
    const start = text.indexOf("{");
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "\\") i++;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
            try {
                return JSON.parse(text.slice(start, i + 1));
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

/** A schema-validated object from the model, or `malformed_output`. One correction attempt is made. */
export async function generateJson<S extends z.ZodType>(ctx: AiContext, request: TextRequest & { schema: S }): Promise<{ value: z.output<S>; model: string }> {
    const first = await generateText(ctx, request);
    const parsed = request.schema.safeParse(firstJsonObject(first.text));
    if (parsed.success) return { value: parsed.data, model: first.model };
    const retry = await generateText(ctx, {
        ...request,
        prompt: `${request.prompt}\n\nYour previous answer was not valid JSON of the required shape. Answer again with only the JSON object.`,
    });
    const again = request.schema.safeParse(firstJsonObject(retry.text));
    if (again.success) return { value: again.data, model: retry.model };
    console.log(JSON.stringify({ event: "ai_malformed_output", model: retry.model, feature: ctx.feature }));
    throw new AiError("malformed_output", MESSAGES.malformed_output, 502);
}

// --- Documents -------------------------------------------------------------------------------------

/** Text from a PDF or Office document, with Workers AI Markdown Conversion. */
export async function documentToText(ctx: AiContext, file: { name: string; bytes: Uint8Array; type: string }): Promise<string> {
    const model = "workers-ai/tomarkdown";
    const result = await call(
        ctx,
        { role: "document", model, inputs: {}, estimate: 0, unit: "documents" },
        async (ai) => {
            if (!ai.toMarkdown) throw new AiError("not_configured", MESSAGES.not_configured);
            const converted = await ai.toMarkdown(
                { name: file.name, blob: new Blob([file.bytes as BlobPart], { type: file.type }) },
                { conversionOptions: { pdf: { metadata: false } } },
            );
            return Array.isArray(converted) ? converted[0] : converted;
        },
        // Markdown Conversion reports an estimated token count, not Neurons: document conversion of
        // text formats isn't priced per token on the published page, so it's recorded as a document.
        () => ({ inputUnits: 1, outputUnits: 0, neurons: 0, measured: false }),
    );
    if (!result || result.format === "error" || typeof result.data !== "string")
        throw new AiError("provider_error", "That document couldn't be converted to text. It may be scanned, encrypted or damaged.", 422);
    return result.data;
}

export const knownModel = (id: string) => !!modelById(id);
