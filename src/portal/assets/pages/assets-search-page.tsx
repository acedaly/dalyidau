// Search across Home & Assets (assets, maintenance, documents, places), through its own access
// rules: nothing shows up that you couldn't open.
import { File04, Home02, Package, SearchLg, Tool02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Card } from "@/portal/components/card";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { FILE_KIND_LABELS } from "@/shared/assets/types";
import { fileUrl } from "../assets-api";
import { ASSETS, AssetThumb, AssetsHeader, assetHref, locationHref, shortDate } from "../shared";

export const AssetsSearchPage = ({ data }: { data: PageData<"assets-search"> }) => {
    const r = data.results;
    const total = r.assets.length + r.maintenance.length + r.files.length + r.locations.length;
    return (
        <>
            <AssetsHeader title="Search" description="Assets, maintenance, documents and places." crumbs={[{ label: "Search" }]} />
            <form action={`${ASSETS}/search`} method="get" role="search" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Input name="q" label="Search for" defaultValue={data.q} icon={SearchLg} className="sm:w-96" type="search" />
                <Button size="md" type="submit">
                    Search
                </Button>
            </form>
            {data.q.length < 2 ? (
                <p className="text-sm text-tertiary">Type at least two letters: a name, a model, a serial number, a registration, a tag or a place.</p>
            ) : total === 0 ? (
                <Empty icon={SearchLg} title="Nothing found" description={`Nothing you can open matches “${data.q}”.`} />
            ) : (
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                    {r.assets.length > 0 && (
                        <Card title={`Assets (${r.assets.length})`} icon={Package}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {r.assets.map((a) => (
                                    <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                                        <AssetThumb asset={a} size="sm" />
                                        <div className="flex min-w-0 flex-col">
                                            <a href={assetHref(a.id)} className="truncate text-sm font-medium text-primary hover:underline">
                                                {a.name}
                                            </a>
                                            <span className="truncate text-xs text-tertiary">
                                                {[a.categoryLabel, a.manufacturer, a.model, a.serialNumber, a.vehicle?.registration]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                    {r.maintenance.length > 0 && (
                        <Card title={`Maintenance (${r.maintenance.length})`} icon={Tool02}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {r.maintenance.map((m) => (
                                    <li key={m.id} className="flex flex-col px-4 py-2.5 sm:px-5">
                                        <a
                                            href={m.assetId ? assetHref(m.assetId, "maintenance") : locationHref(m.locationId!)}
                                            className="text-sm font-medium text-primary hover:underline"
                                        >
                                            {m.title}
                                        </a>
                                        <span className="text-xs text-tertiary">
                                            {m.targetName} · {shortDate(m.completedOn ?? m.dueOn) || m.status}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                    {r.files.length > 0 && (
                        <Card title={`Documents (${r.files.length})`} icon={File04}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {r.files.map((f) => (
                                    <li key={f.id} className="flex flex-col px-4 py-2.5 sm:px-5">
                                        <a href={fileUrl(f.id)} className="text-sm font-medium text-primary hover:underline">
                                            {f.caption ?? f.filename}
                                        </a>
                                        <span className="text-xs text-tertiary">
                                            {FILE_KIND_LABELS[f.kind]}
                                            {f.assetName ? ` · ${f.assetName}` : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                    {r.locations.length > 0 && (
                        <Card title={`Places (${r.locations.length})`} icon={Home02}>
                            <ul className="flex flex-col divide-y divide-secondary">
                                {r.locations.map((l) => (
                                    <li key={l.id} className="px-4 py-2.5 sm:px-5">
                                        <a href={locationHref(l.id)} className="text-sm font-medium text-primary hover:underline">
                                            {l.name}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </Card>
                    )}
                </div>
            )}
        </>
    );
};
