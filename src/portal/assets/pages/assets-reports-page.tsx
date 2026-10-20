// Reports and exports. Every report contains only what you can see: values you can't see say "not
// shared", unrecorded figures are blank (and counted), and nothing is estimated to fill a gap. CSV
// files open in a spreadsheet; the printable register is a page to print or save as a PDF.
import { useState } from "react";
import { Download01, LineChartUp01, Printer, ShieldTick } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Toggle } from "@/components/base/toggle/toggle";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { formatMoney } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { REPORTS, REPORT_LABELS } from "@/shared/assets/types";
import { reportUrl } from "../assets-api";
import { ASSETS, AssetsHeader } from "../shared";

export const AssetsReportsPage = ({ data }: { data: PageData<"assets-reports"> }) => {
    const [all, setAll] = useState(false);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const low = data.preferences.lowValueCents;
    const params: Record<string, string> = all ? { all: "1" } : {};
    return (
        <>
            <AssetsHeader
                title="Reports and export"
                description="Download what you can see, or print a household asset register."
                crumbs={[{ label: "Reports" }]}
            />
            {low > 0 && (
                <Toggle
                    className="w-full"
                    label={`Include items worth less than ${formatMoney(low, "AUD", { whole: true })}`}
                    hint="Your low-value threshold, from Settings. Items without a value are always included."
                    isSelected={all}
                    onChange={setAll}
                />
            )}
            <section aria-label="Reports" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {REPORTS.filter((r) => r !== "claim").map((r) => (
                    <div key={r} className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset">
                        <div className="flex flex-col gap-1">
                            <h2 className="text-md font-semibold text-primary">{REPORT_LABELS[r].label}</h2>
                            <p className="text-sm text-tertiary">{REPORT_LABELS[r].description}</p>
                        </div>
                        <div className="mt-auto flex flex-wrap gap-2">
                            <Button size="sm" color="secondary" iconLeading={Download01} href={reportUrl(r, params)}>
                                CSV
                            </Button>
                            {(r === "household" || r === "inventory") && (
                                <Button size="sm" color="secondary" iconLeading={Printer} href={`${ASSETS}/reports/register?kind=${r}`}>
                                    Printable
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </section>
            <Card title="Insurance claim documentation" icon={ShieldTick}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <p className="text-sm text-tertiary">
                        Choose the assets involved. The pack lists their identifiers, purchase details, values (labelled with where each came from), receipts,
                        photos and linked policies, as recorded. Give your insurer the original documents too.
                    </p>
                    <ul className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                        {data.assets.map((a) => (
                            <li key={a.id}>
                                <Checkbox
                                    label={a.name}
                                    hint={a.locationName ?? undefined}
                                    isSelected={chosen.has(a.id)}
                                    onChange={(on) =>
                                        setChosen((c) => {
                                            const next = new Set(c);
                                            if (on) next.add(a.id);
                                            else next.delete(a.id);
                                            return next;
                                        })
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                    {chosen.size > 0 ? (
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" iconLeading={Printer} href={`${ASSETS}/reports/register?kind=claim&assets=${[...chosen].join(",")}`}>
                                Printable pack ({chosen.size})
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Download01} href={reportUrl("claim", { assets: [...chosen].join(",") })}>
                                CSV
                            </Button>
                        </div>
                    ) : (
                        <p className="text-sm text-tertiary">Choose at least one asset.</p>
                    )}
                </div>
            </Card>
            <p className="flex items-center gap-2 text-sm text-tertiary">
                <LineChartUp01 aria-hidden="true" className="size-4" />
                Every export is recorded in the asset history (who and when, never the contents).
            </p>
        </>
    );
};
