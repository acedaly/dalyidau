// Warranties across every asset, with whether each end date was stated or worked out, and claims.
// The Australian Consumer Law note is always shown: a stated warranty ending isn't the end of a
// consumer's rights.
import { useState } from "react";
import { Certificate01, CheckDone01, Download01, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { CONSUMER_LAW_NOTE } from "@/shared/assets/engine";
import { CLAIM_KIND_LABELS, CLAIM_STATUS_LABELS, WARRANTY_KIND_LABELS, type WarrantyView } from "@/shared/assets/types";
import { assetsApi, reportUrl } from "../assets-api";
import { ClaimForm } from "../forms";
import { AssetsHeader, DateWithDistance, Money, WarrantyBadge, assetHref, shortDate } from "../shared";

export const AssetsWarrantiesPage = ({ data }: { data: PageData<"assets-warranties"> }) => {
    const toast = useToast();
    const [claiming, setClaiming] = useState(false);
    const task = async (w: WarrantyView) => {
        try {
            const r = await assetsApi.task({ refKind: "warranty_expiry", refId: w.id });
            toast.success(r.existing ? "That task already exists" : "Task created");
        } catch (e) {
            toast.error("Couldn't create the task", errorMessage(e));
        }
    };
    return (
        <>
            <AssetsHeader
                title="Warranties"
                description="When each warranty ends, from the dates and lengths you entered."
                crumbs={[{ label: "Warranties" }]}
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={Download01} href={reportUrl("warranties")}>
                            Export
                        </Button>
                        {data.assets.length > 0 && (
                            <Button size="sm" iconLeading={Plus} onClick={() => setClaiming(true)}>
                                Record a claim
                            </Button>
                        )}
                    </>
                }
            />
            <Notice title="Your rights don't end with the warranty">{CONSUMER_LAW_NOTE}</Notice>
            <DataTable<WarrantyView>
                title="Warranties"
                description="Add a warranty from an asset's Warranty & insurance tab."
                rows={data.warranties}
                searchText={(w) => `${w.assetName} ${w.provider ?? ""}`}
                initialSort={{ column: "ends", direction: "ascending" }}
                emptyState={
                    <Empty
                        icon={Certificate01}
                        title="No warranties recorded"
                        description="Open an asset and add its warranty: the length, or the end date if it's stated."
                    />
                }
                columns={[
                    {
                        id: "asset",
                        label: "Asset",
                        isRowHeader: true,
                        sortValue: (w) => w.assetName,
                        render: (w) => (
                            <a href={assetHref(w.assetId, "cover")} className="font-medium text-primary hover:underline">
                                {w.assetName}
                            </a>
                        ),
                    },
                    {
                        id: "kind",
                        label: "Warranty",
                        className: "max-md:hidden",
                        render: (w) => `${WARRANTY_KIND_LABELS[w.kind]}${w.provider ? ` · ${w.provider}` : ""}`,
                    },
                    {
                        id: "ends",
                        label: "Ends",
                        sortValue: (w) => w.expiresOn ?? "9999",
                        render: (w) => (
                            <span className="flex flex-col">
                                <DateWithDistance date={w.expiresOn} today={data.today} />
                                <span className="text-xs text-tertiary">
                                    {w.expiresBasis === "stated"
                                        ? "As stated"
                                        : w.expiresBasis === "calculated"
                                          ? `Start + ${w.months} months`
                                          : "Not enough information"}
                                </span>
                            </span>
                        ),
                    },
                    { id: "state", label: "Status", render: (w) => <WarrantyBadge state={w.state} /> },
                    {
                        id: "task",
                        label: "",
                        render: (w) =>
                            data.canTasks && w.expiresOn && w.state !== "expired" ? (
                                <Button size="xs" color="secondary" iconLeading={CheckDone01} onClick={() => void task(w)}>
                                    Task
                                </Button>
                            ) : null,
                    },
                ]}
            />
            <Card title="Warranty and consumer guarantee claims" icon={Certificate01}>
                {data.claims.length ? (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {data.claims.map((c) => (
                            <li key={c.id} className="flex flex-col px-4 py-2.5 text-sm sm:px-5">
                                <span className="font-medium text-primary">
                                    {c.assetName ?? "An asset"} · {CLAIM_KIND_LABELS[c.kind]} · {CLAIM_STATUS_LABELS[c.status]}
                                </span>
                                <span className="text-xs text-tertiary">
                                    {[c.lodgedOn && `lodged ${shortDate(c.lodgedOn)}`, c.reference, c.outcome].filter(Boolean).join(" · ")}
                                    {c.amountPaidCents !== null && (
                                        <>
                                            {" · paid "}
                                            <Money cents={c.amountPaidCents} />
                                        </>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No claims recorded.</p>
                )}
            </Card>
            {claiming && <ClaimForm assets={data.assets} kind="warranty" onSaved={() => window.location.reload()} onClose={() => setClaiming(false)} />}
        </>
    );
};
