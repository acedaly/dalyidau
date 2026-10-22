// A briefing: facts (each from stored public records, with its link and time), what couldn't be
// seen, and an optional interpretation that's labelled as AI and cites the facts it uses.
import { useState } from "react";
import { FileCheck02, Stars02 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/components/card";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { SOURCE_STATUS_LABELS } from "@/shared/centre/sources";
import type { CentreBriefing, CentreShell } from "@/shared/centre/types";
import { centreApi } from "./centre-api";
import { NatureBadge, When } from "./shared";

const STATUS_TEXT: Record<CentreBriefing["interpretation"]["status"], string> = {
    off: "Interpretation needs Daly Intelligence switched on (Intelligence → AI and storage settings). The facts above are complete without it.",
    not_requested: "No interpretation yet.",
    ready: "",
    unavailable: "The model couldn't be reached; nothing was assumed. The facts stand on their own.",
    budget: "Today's AI budget is used up. The facts stand on their own.",
};

export const BriefingView = ({ briefing: initial, shell, compact = false }: { briefing: CentreBriefing; shell: CentreShell; compact?: boolean }) => {
    const [briefing, setBriefing] = useState(initial);
    const [busy, setBusy] = useState<"ai" | null>(null);
    const toast = useToast();
    const facts = Object.fromEntries(briefing.sections.flatMap((s) => s.facts).map((f) => [f.ref, f]));
    const interpret = async () => {
        setBusy("ai");
        try {
            setBriefing((await centreApi.interpret(briefing.scope, briefing.watchId)).briefing);
        } catch (e) {
            toast.error("Couldn't prepare an interpretation", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    return (
        <Card
            title={briefing.title}
            icon={FileCheck02}
            action={
                <div className="flex flex-wrap gap-2">
                    {shell.aiAvailable && briefing.interpretation.status !== "ready" && (
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Stars02}
                            onClick={() => void interpret()}
                            isLoading={busy === "ai"}
                            showTextWhileLoading
                        >
                            Interpret
                        </Button>
                    )}
                </div>
            }
        >
            <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                <p className="text-xs text-tertiary">
                    Prepared <When iso={briefing.generatedAt} /> from stored public records. Each fact links to its record and shows its own time.
                </p>
                {briefing.sections.length ? (
                    briefing.sections.map((s) => (
                        <section key={s.key} className="flex flex-col gap-1.5">
                            <h3 className="flex items-center gap-2 text-sm font-semibold text-secondary">
                                {s.title}
                                {s.key === "correlations" && <NatureBadge nature="derived" />}
                            </h3>
                            <ul className="flex flex-col gap-1">
                                {s.facts.slice(0, compact ? 3 : 10).map((f) => (
                                    <li key={f.ref} className="text-sm text-tertiary">
                                        <span className="mr-1.5 font-mono text-xs text-quaternary">{f.ref}</span>
                                        {f.url ? (
                                            <a href={f.url} className="text-secondary outline-focus-ring hover:underline focus-visible:outline-2">
                                                {f.text}
                                            </a>
                                        ) : (
                                            <span className="text-secondary">{f.text}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))
                ) : (
                    <p className="text-sm text-tertiary">Nothing to report from the sources that are on.</p>
                )}
                {briefing.gaps.length > 0 && (
                    <p className="text-xs text-tertiary">
                        Not included: {briefing.gaps.map((g) => `${g.dataset} (${SOURCE_STATUS_LABELS[g.status].toLowerCase()})`).join("; ")}.
                    </p>
                )}
                <section aria-label="Interpretation" className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
                    <div className="flex items-center gap-2">
                        <Badge size="sm" type="color" color="purple">
                            <Stars02 aria-hidden="true" className="mr-1 size-3" />
                            AI interpretation, not facts
                        </Badge>
                        {briefing.interpretation.model && <span className="text-xs text-quaternary">{briefing.interpretation.model}</span>}
                    </div>
                    {briefing.interpretation.items.length ? (
                        <ul className="flex flex-col gap-1.5">
                            {briefing.interpretation.items.map((i) => (
                                <li key={i.text} className="text-sm text-secondary">
                                    {i.text}{" "}
                                    <span className="text-xs text-quaternary">
                                        (
                                        {i.refs.map((r, n) => (
                                            <span key={r}>
                                                {n > 0 && ", "}
                                                {facts[r]?.url ? (
                                                    <a href={facts[r].url!} className="hover:underline">
                                                        {r}
                                                    </a>
                                                ) : (
                                                    r
                                                )}
                                            </span>
                                        ))}
                                        )
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">{STATUS_TEXT[briefing.interpretation.status] || "No interpretation."}</p>
                    )}
                </section>
            </div>
        </Card>
    );
};
