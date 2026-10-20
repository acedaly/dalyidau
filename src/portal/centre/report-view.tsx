// A situation report as people read it: eleven sections of facts, each labelled by its nature and
// linked to its record, the optional AI narrative kept apart and labelled as interpretation, the
// limitations and the sources with their collection times. Prints cleanly.
import { Badge } from "@/components/base/badges/badges";
import type { SituationReport } from "@/shared/centre/reports";
import { NatureChip } from "./history-ui";
import { When } from "./shared";

export const ReportView = ({ report }: { report: SituationReport }) => (
    <article className="flex flex-col gap-6 print:gap-4">
        <header className="flex flex-col gap-1">
            <p className="text-sm text-tertiary">
                {report.scopeLabel} · generated <When iso={report.generatedAt} />
                {report.historical && (
                    <>
                        {" "}
                        · describes <When iso={report.at} /> as the Centre knew it then
                    </>
                )}{" "}
                · changes since <When iso={report.periodFrom} />
            </p>
            {report.historical && (
                <Badge size="sm" type="color" color="warning">
                    Historical report from stored versions
                </Badge>
            )}
        </header>
        {report.narrative.items.length > 0 && (
            <section className="flex flex-col gap-2 rounded-xl bg-secondary p-4 print:bg-primary print:ring-1 print:ring-secondary" aria-label="AI narrative">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-secondary">Narrative</h2>
                    <Badge size="sm" type="color" color="purple">
                        AI interpretation, not facts
                    </Badge>
                </div>
                <ul className="flex flex-col gap-1 text-sm text-secondary">
                    {report.narrative.items.map((i) => (
                        <li key={i.text}>
                            {i.text} <span className="text-xs text-quaternary">[{i.refs.join(", ")}]</span>
                        </li>
                    ))}
                </ul>
                {report.narrative.model && <p className="text-xs text-quaternary">Written by {report.narrative.model} from the numbered facts below only.</p>}
            </section>
        )}
        {report.sections.map((s, i) => (
            <section key={s.key} className="flex break-inside-avoid flex-col gap-2" aria-labelledby={`report-${s.key}`}>
                <h2 id={`report-${s.key}`} className="text-md font-semibold text-primary">
                    {i + 1}. {s.title}
                </h2>
                {s.facts.length ? (
                    <ul className="flex flex-col divide-y divide-secondary rounded-lg ring-1 ring-secondary">
                        {s.facts.map((f) => (
                            <li key={f.ref} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
                                <span className="shrink-0 font-mono text-xs text-quaternary">{f.ref}</span>
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
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
                    <p className="text-sm text-tertiary">{s.empty ?? "Nothing to report."}</p>
                )}
            </section>
        ))}
        <section className="flex break-inside-avoid flex-col gap-2">
            <h2 className="text-md font-semibold text-primary">Limitations</h2>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-tertiary">
                {report.limitations.map((l) => (
                    <li key={l}>{l}</li>
                ))}
            </ul>
            <div className="flex flex-col gap-0.5 text-xs text-quaternary">
                {[...new Set(report.sources.map((s) => s.attribution).filter(Boolean))].map((a) => (
                    <p key={a}>{a}</p>
                ))}
            </div>
        </section>
    </article>
);

/** The report as Markdown, for download. */
export function reportMarkdown(report: SituationReport, origin: string): string {
    const lines = [
        `# ${report.title}`,
        "",
        `${report.scopeLabel}. Generated ${report.generatedAt}${report.historical ? `; describes ${report.at} as the Centre knew it then` : ""}.`,
        "",
    ];
    if (report.narrative.items.length) {
        lines.push("## Narrative (AI interpretation, not facts)", "");
        for (const i of report.narrative.items) lines.push(`- ${i.text} [${i.refs.join(", ")}]`);
        lines.push("");
    }
    report.sections.forEach((s, n) => {
        lines.push(`## ${n + 1}. ${s.title}`, "");
        if (!s.facts.length) lines.push(s.empty ?? "Nothing to report.");
        for (const f of s.facts) lines.push(`- **${f.ref}** (${f.nature}${f.at ? `, ${f.at}` : ""}) ${f.text}${f.url ? ` <${origin}${f.url}>` : ""}`);
        lines.push("");
    });
    lines.push("## Limitations", "", ...report.limitations.map((l) => `- ${l}`), "", ...[...new Set(report.sources.map((s) => s.attribution).filter(Boolean))]);
    return lines.join("\n");
}
