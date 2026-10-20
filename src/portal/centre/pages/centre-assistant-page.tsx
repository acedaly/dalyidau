// The Intelligence Centre assistant: ask about what the Centre collected. Every answer is built from
// stored records through a fixed set of analysis tools; the facts are shown with their nature,
// time and link. With Daly Intelligence on, a written answer may be added: it's an AI
// interpretation of those facts, labelled as such, never an official assessment.
import { useState } from "react";
import { MessageChatSquare, Send01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { NativeSelect } from "@/components/base/select/select-native";
import { TextArea } from "@/components/base/textarea/textarea";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import type { AssistantAnswer } from "@/shared/centre/assistant";
import { SOURCE_STATUS_LABELS, type SourceStatus } from "@/shared/centre/sources";
import { centreApi } from "../centre-api";
import { NatureChip } from "../history-ui";
import { CentreHeader, CentreNotices, When } from "../shared";

const params = () => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search));

export const CentreAssistantPage = ({ data }: { data: PageData<"centre-assistant"> }) => {
    const [question, setQuestion] = useState("");
    const [watchId, setWatchId] = useState(() => params().get("watch") ?? "");
    const [recordId] = useState(() => (/^icr_[a-z0-9]{14}$/.test(params().get("record") ?? "") ? params().get("record") : null));
    const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ask = async (q = question) => {
        if (q.trim().length < 3) return;
        setBusy(true);
        setError(null);
        try {
            setAnswer((await centreApi.ask({ question: q.trim(), watchId: watchId || null, recordId })).answer);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <CentreHeader
                title="Assistant"
                crumb="Assistant"
                shell={data}
                description="Ask about what the Centre collected. Answers come only from stored public records, with their sources, times and gaps."
            />
            <CentreNotices shell={data} />
            {!data.aiAvailable && (
                <Notice title="Answering from built-in question types">
                    AI isn't switched on for the assistant, so questions are understood from their words and answered with the matching facts. Everything still
                    works; there's just no written summary.
                </Notice>
            )}
            <Card title="Ask" icon={MessageChatSquare}>
                <form
                    className="flex flex-col gap-4 px-4 py-4 sm:px-5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void ask();
                    }}
                >
                    <FormError message={error} />
                    <TextArea
                        label="Question"
                        value={question}
                        onChange={setQuestion}
                        rows={3}
                        maxLength={500}
                        placeholder="What changed in my watch area over the past 24 hours?"
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <NativeSelect
                            label="About a watch area (optional)"
                            value={watchId}
                            onChange={(e) => setWatchId(e.target.value)}
                            options={[{ label: "Decide from the question", value: "" }, ...data.watches.map((w) => ({ label: w.name, value: w.id }))]}
                        />
                        {recordId && <p className="self-end text-sm text-tertiary">Asking about the record you came from.</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button size="md" type="submit" iconLeading={Send01} isLoading={busy} showTextWhileLoading>
                            Ask
                        </Button>
                    </div>
                    <div className="flex flex-col gap-2">
                        <p className="text-xs font-medium text-tertiary">Try</p>
                        <div className="flex flex-wrap gap-2">
                            {data.examples.map((ex) => (
                                <Button key={ex} size="sm" color="secondary" onClick={() => (setQuestion(ex), void ask(ex))}>
                                    {ex}
                                </Button>
                            ))}
                        </div>
                    </div>
                </form>
            </Card>
            {answer && (
                <>
                    <Card title="Answer">
                        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge size="sm" type="color" color={answer.mode === "ai" ? "purple" : "gray"}>
                                    {answer.mode === "ai" ? "Understood by AI" : "Built-in question type"}
                                </Badge>
                                <span className="text-sm text-tertiary">Tool: {answer.toolLabel}</span>
                            </div>
                            {answer.looked.length > 0 && <p className="text-xs text-tertiary">Looked at: {answer.looked.join(" · ")}</p>}
                            <p className="text-md font-medium text-primary">{answer.lead}</p>
                            {answer.answer.items.length > 0 && (
                                <section className="flex flex-col gap-2 rounded-xl bg-secondary p-4" aria-label="AI interpretation">
                                    <Badge size="sm" type="color" color="purple">
                                        AI interpretation of the facts below, not facts and not official
                                    </Badge>
                                    <ul className="flex flex-col gap-1 text-sm text-secondary">
                                        {answer.answer.items.map((i) => (
                                            <li key={i.text}>
                                                {i.text} <span className="text-xs text-quaternary">[{i.refs.join(", ")}]</span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                            {(answer.answer.status === "unavailable" || answer.answer.status === "budget") && (
                                <p className="text-sm text-tertiary">
                                    {answer.answer.status === "budget" ? "The AI budget for today is used up" : "The AI answer isn't available right now"}; the
                                    facts are below.
                                </p>
                            )}
                        </div>
                    </Card>
                    <Card title={`${answer.facts.length} facts`}>
                        {answer.facts.length ? (
                            <ul className="divide-y divide-secondary">
                                {answer.facts.map((f) => (
                                    <li key={f.ref} className="flex gap-3 px-4 py-2.5 sm:px-5">
                                        <span className="shrink-0 font-mono text-xs text-quaternary">{f.ref}</span>
                                        <div className="flex min-w-0 flex-col gap-1">
                                            <p className="text-sm text-secondary">
                                                {f.url ? (
                                                    <a href={f.url} className="hover:underline">
                                                        {f.text}
                                                    </a>
                                                ) : (
                                                    f.text
                                                )}
                                            </p>
                                            <p className="flex flex-wrap items-center gap-2 text-xs text-quaternary">
                                                <NatureChip nature={f.nature} />
                                                {f.at && <When iso={f.at} />}
                                            </p>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No stored records answer this.</p>
                        )}
                    </Card>
                    <Card title="Freshness and limits">
                        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                            {answer.freshness.length > 0 && (
                                <ul className="flex flex-col gap-1 text-sm">
                                    {answer.freshness.map((s) => (
                                        <li key={s.sourceId} className="flex flex-wrap gap-x-2 text-tertiary">
                                            <span className="text-secondary">{s.dataset}</span>
                                            <span>{SOURCE_STATUS_LABELS[s.status as SourceStatus] ?? s.status}</span>
                                            {s.lastSuccessAt && <When iso={s.lastSuccessAt} label="retrieved" />}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-tertiary">
                                {answer.limitations.map((l) => (
                                    <li key={l}>{l}</li>
                                ))}
                            </ul>
                        </div>
                    </Card>
                </>
            )}
        </>
    );
};
