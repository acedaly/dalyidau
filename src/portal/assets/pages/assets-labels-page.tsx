// Printable QR labels. Each code is only the asset's portal address with its label version: no
// serial number, location or value, and no access by itself. The name can be left off the label for
// things you'd rather not advertise.
import { useState } from "react";
import { Printer, QrCode02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { qrUrl } from "../assets-api";
import { ASSETS, AssetsHeader } from "../shared";

export const AssetsLabelsPage = ({ data }: { data: PageData<"assets-labels"> }) => {
    const [names, setNames] = useState(true);
    const [size, setSize] = useState<"small" | "large">("small");
    return (
        <>
            <div className="print:hidden">
                <AssetsHeader
                    title="Print QR labels"
                    description="Stick a label on each item. Scanning it opens the asset after signing in; it reveals nothing to anyone else."
                    crumbs={[{ label: "All assets", href: `${ASSETS}/all` }, { label: "Labels" }]}
                    actions={
                        <Button size="sm" iconLeading={Printer} onClick={() => window.print()}>
                            Print
                        </Button>
                    }
                />
                <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
                    <Toggle className="w-full sm:w-auto" label="Print each asset's name" isSelected={names} onChange={setNames} />
                    <NativeSelect
                        label="Label size"
                        value={size}
                        onChange={(e) => setSize(e.target.value as typeof size)}
                        options={[
                            { value: "small", label: "Small (about 3 cm)" },
                            { value: "large", label: "Large (about 5 cm)" },
                        ]}
                        className="sm:w-56"
                    />
                </div>
            </div>
            {data.assets.length ? (
                <ul
                    className={`grid gap-4 ${size === "small" ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 print:grid-cols-6" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-4"}`}
                >
                    {data.assets.map((a) => (
                        <li
                            key={a.id}
                            className="flex break-inside-avoid flex-col items-center gap-1 rounded-lg border border-dashed border-secondary p-2 text-center print:border-primary"
                        >
                            <img src={qrUrl(a.id)} alt={`QR code for ${a.name}`} className={size === "small" ? "size-28" : "size-44"} />
                            {names && <span className="line-clamp-2 text-xs font-medium text-primary">{a.name}</span>}
                            <span className="text-[10px] text-tertiary">Daly · label {a.labelVersion}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <Empty icon={QrCode02} title="No assets to label" description="Choose assets in All assets, then Print labels." />
            )}
        </>
    );
};
