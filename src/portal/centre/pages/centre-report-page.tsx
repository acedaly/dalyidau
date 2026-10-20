// One saved situation report: read it, print it, download it as Markdown or JSON, save it to
// Knowledge (optionally linked to an existing note), or delete it.
import { useState } from "react";
import { BookOpen01, Download01, Printer, Trash01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ConfirmDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { centreApi } from "../centre-api";
import { KnowledgeSaveDialog, downloadText } from "../history-ui";
import { ReportView, reportMarkdown } from "../report-view";
import { CENTRE, CentreHeader, CentreNotices } from "../shared";

export const CentreReportPage = ({ data }: { data: PageData<"centre-report"> }) => {
    const toast = useToast();
    const { report, summary } = data;
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const file = `situation-report-${report.at.slice(0, 16).replace(/[:T]/g, "-")}`;
    return (
        <>
            <div className="print:hidden">
                <CentreHeader
                    title={report.title}
                    crumb="Report"
                    shell={data}
                    actions={
                        <>
                            <Button size="md" color="secondary" iconLeading={Printer} onClick={() => window.print()}>
                                Print
                            </Button>
                            <Button
                                size="md"
                                color="secondary"
                                iconLeading={Download01}
                                onClick={() => downloadText(`${file}.md`, reportMarkdown(report, window.location.origin), "text/markdown")}
                            >
                                Markdown
                            </Button>
                            <Button
                                size="md"
                                color="secondary"
                                iconLeading={Download01}
                                onClick={() => downloadText(`${file}.json`, JSON.stringify(report, null, 2), "application/json")}
                            >
                                JSON
                            </Button>
                            {summary.knowledgeObjectId ? (
                                <Button size="md" color="secondary" iconLeading={BookOpen01} href={`/portal/knowledge/o/${summary.knowledgeObjectId}`}>
                                    In Knowledge
                                </Button>
                            ) : (
                                <Button size="md" color="secondary" iconLeading={BookOpen01} onClick={() => setSaving(true)}>
                                    Save to Knowledge
                                </Button>
                            )}
                            <Button size="md" color="secondary-destructive" iconLeading={Trash01} onClick={() => setDeleting(true)}>
                                Delete
                            </Button>
                        </>
                    }
                />
                <CentreNotices shell={data} />
            </div>
            <h1 className="hidden text-display-xs font-semibold text-primary print:block">{report.title}</h1>
            <Card title={`${summary.facts} facts`}>
                <div className="px-4 py-5 sm:px-6">
                    <ReportView report={report} />
                </div>
            </Card>
            <KnowledgeSaveDialog
                isOpen={saving}
                onOpenChange={setSaving}
                title="Save the report to Knowledge"
                description="A note with every section and fact, with links back here. Saving again returns the same note."
                save={(target) => centreApi.reportToKnowledge(summary.id, target)}
            />
            <ConfirmDialog
                isOpen={deleting}
                onOpenChange={setDeleting}
                title="Delete this report?"
                description="The stored report is removed. A note already saved to Knowledge stays there."
                confirmLabel="Delete report"
                destructive
                onConfirm={async () => {
                    try {
                        await centreApi.deleteReport(summary.id);
                        window.location.href = `${CENTRE}/reports`;
                    } catch (e) {
                        toast.error("Couldn't delete it", errorMessage(e));
                    }
                }}
            />
        </>
    );
};
