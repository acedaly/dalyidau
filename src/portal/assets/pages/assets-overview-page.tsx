// Home & Assets overview: totals (with unvalued assets counted, never zeroed), what needs attention
// in the next 30, 60 or 90 days, reminders, recent repairs and purchases, and items still missing
// proof of purchase or a photo.
import { useMemo, useState } from "react";
import { AlertTriangle, Bell01, CurrencyDollar, File04, Home02, Package, Plus, ShieldTick, Tool02, Truck01, XClose } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import { formatMoney, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { addDays } from "@/shared/calendar/time";
import { assetsApi } from "../assets-api";
import { ASSETS, AssetThumb, AssetsHeader, AttentionList, assetHref, shortDate } from "../shared";

export const AssetsOverviewPage = ({ data }: { data: PageData<"assets-overview"> }) => {
    const { overview: o } = data;
    const toast = useToast();
    const [horizon, setHorizon] = useState<30 | 60 | 90>(data.preferences.today.horizonDays);
    const [notifications, setNotifications] = useState(o.notifications);
    const [showAll, setShowAll] = useState(false);
    const attention = useMemo(
        () => o.attention.filter((i) => i.state === "overdue" || i.date === null || i.date <= addDays(o.today, horizon)),
        [o.attention, o.today, horizon],
    );
    const empty = o.totals.assets === 0 && o.totals.locations === 0;
    const dismiss = async (id: string) => {
        try {
            setNotifications((await assetsApi.dismiss(id)).notifications);
        } catch (e) {
            toast.error("Couldn't dismiss", errorMessage(e));
        }
    };
    const t = o.totals;

    return (
        <>
            <AssetsHeader title="Home & Assets" description="What we own, maintain, insure or will need to replace." />
            {empty ? (
                <Empty
                    icon={Package}
                    title="Nothing recorded yet"
                    description="Start with the things that matter most: a vehicle, the camper, your home or a valuable item. A name and a category is enough."
                    actions={
                        <>
                            <Button size="md" color="secondary" iconLeading={Home02} href={`${ASSETS}/property`}>
                                Add a place
                            </Button>
                            <Button size="md" iconLeading={Plus} href={`${ASSETS}/capture`}>
                                Add an asset
                            </Button>
                        </>
                    }
                />
            ) : (
                <>
                    <section aria-label="Totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <MetricCard
                            label="Assets"
                            value={t.assets}
                            icon={Package}
                            detail={`${pluralise(t.vehicles, "vehicle")} and trailers · ${pluralise(t.locations, "place")}`}
                        />
                        <MetricCard
                            label="Recorded value"
                            value={t.valueCents === null ? "None recorded" : formatMoney(t.valueCents, "AUD", { whole: true })}
                            icon={CurrencyDollar}
                            detail={
                                <>
                                    {t.valued} with a value, {t.unvalued} without
                                    {t.financialHidden > 0 && <>, {t.financialHidden} not shared with you</>}
                                </>
                            }
                        />
                        <MetricCard label="Overdue" value={o.overdue.length} icon={AlertTriangle} detail="Maintenance, renewals and dates already past" />
                        <MetricCard
                            label="Active policies"
                            value={t.policies}
                            icon={ShieldTick}
                            detail={
                                <a href={`${ASSETS}/insurance`} className="hover:underline">
                                    See coverage
                                </a>
                            }
                        />
                    </section>

                    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                        <div className="flex flex-col gap-6 xl:col-span-2">
                            <Card title="Needs attention" icon={AlertTriangle}>
                                <div className="border-b border-secondary px-4 py-3 sm:px-5">
                                    <ButtonGroup
                                        size="sm"
                                        aria-label="How far ahead"
                                        selectionMode="single"
                                        disallowEmptySelection
                                        selectedKeys={new Set([String(horizon)])}
                                        className="max-w-full overflow-x-auto"
                                        onSelectionChange={(keys) => {
                                            const next = [...keys][0];
                                            if (next) setHorizon(Number(next) as 30 | 60 | 90);
                                        }}
                                    >
                                        <ButtonGroupItem id="30">30 days ({o.horizon.days30})</ButtonGroupItem>
                                        <ButtonGroupItem id="60">60 days ({o.horizon.days60})</ButtonGroupItem>
                                        <ButtonGroupItem id="90">90 days ({o.horizon.days90})</ButtonGroupItem>
                                    </ButtonGroup>
                                </div>
                                <AttentionList
                                    items={showAll ? attention : attention.slice(0, 8)}
                                    canTasks={data.canTasks}
                                    empty={<p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing due in the next {horizon} days.</p>}
                                />
                                {attention.length > 8 && !showAll && (
                                    <div className="border-t border-secondary px-4 py-3 sm:px-5">
                                        <Button size="sm" color="link-color" onClick={() => setShowAll(true)}>
                                            Show all {attention.length}
                                        </Button>
                                    </div>
                                )}
                            </Card>

                            <Card title="By category" icon={Package}>
                                <ul className="flex flex-col divide-y divide-secondary">
                                    {o.byCategory.map((c) => (
                                        <li key={c.category} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                                            <a href={`${ASSETS}/all?category=${c.category}`} className="font-medium text-primary hover:underline">
                                                {c.label}
                                            </a>
                                            <span className="flex items-center gap-4 text-tertiary tabular-nums">
                                                <span>{pluralise(c.count, "asset")}</span>
                                                <span className="hidden sm:inline">
                                                    {c.valueCents === null ? "No values" : formatMoney(c.valueCents, "AUD", { whole: true })}
                                                    {c.withoutValue > 0 && c.valueCents !== null ? ` + ${c.withoutValue} unvalued` : ""}
                                                </span>
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </Card>
                        </div>

                        <div className="flex flex-col gap-6">
                            <Card title="Reminders" icon={Bell01}>
                                {notifications.length ? (
                                    <ul className="flex flex-col divide-y divide-secondary">
                                        {notifications.map((n) => (
                                            <li key={n.id} className="flex items-start justify-between gap-2 px-4 py-2.5 sm:px-5">
                                                <a href={n.url} className="text-sm text-primary hover:underline">
                                                    {n.sentence}
                                                </a>
                                                <ButtonUtility size="xs" color="tertiary" tooltip="Dismiss" icon={XClose} onClick={() => void dismiss(n.id)} />
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No reminders. Choose when you're reminded in Settings.</p>
                                )}
                            </Card>
                            <Card title="Recent repairs" icon={Tool02}>
                                {o.recentRepairs.length ? (
                                    <ul className="flex flex-col divide-y divide-secondary">
                                        {o.recentRepairs.map((m) => (
                                            <li key={m.id} className="flex flex-col px-4 py-2.5 sm:px-5">
                                                <a
                                                    href={m.assetId ? assetHref(m.assetId, "maintenance") : `${ASSETS}/property/${m.locationId}`}
                                                    className="text-sm font-medium text-primary hover:underline"
                                                >
                                                    {m.title}
                                                </a>
                                                <span className="text-xs text-tertiary">
                                                    {m.targetName} · {shortDate(m.completedOn)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="px-4 py-3 text-sm text-tertiary sm:px-5">No repairs recorded recently.</p>
                                )}
                            </Card>
                            <Card title="Recent purchases" icon={Truck01}>
                                {o.recentPurchases.length ? (
                                    <ul className="flex flex-col divide-y divide-secondary">
                                        {o.recentPurchases.map((a) => (
                                            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                                                <AssetThumb asset={a} size="sm" />
                                                <div className="flex min-w-0 flex-col">
                                                    <a href={assetHref(a.id)} className="truncate text-sm font-medium text-primary hover:underline">
                                                        {a.name}
                                                    </a>
                                                    <span className="text-xs text-tertiary">{shortDate(a.purchaseDate)}</span>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing bought in the last six months is recorded.</p>
                                )}
                            </Card>
                            <Card title="Needs documents" icon={File04}>
                                {o.needsDocuments.length ? (
                                    <ul className="flex flex-col divide-y divide-secondary">
                                        {o.needsDocuments.map((a) => (
                                            <li key={a.id} className="flex flex-col px-4 py-2.5 sm:px-5">
                                                <a href={assetHref(a.id, "documents")} className="text-sm font-medium text-primary hover:underline">
                                                    {a.name}
                                                </a>
                                                <span className="text-xs text-tertiary">
                                                    {[a.needsDocuments?.proof && "No receipt or invoice", a.needsDocuments?.photo && "No photo"]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Everything has a receipt and a photo.</p>
                                )}
                            </Card>
                        </div>
                    </div>
                </>
            )}
        </>
    );
};
