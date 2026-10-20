// A printable household asset register (grouped by place), inventory, or insurance claim pack.
// Print it, or use the browser's "Save as PDF". It contains only what the person can see, and says
// "Not shared" or "Not recorded" rather than leaving a gap that looks like zero.
import { Printer } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { formatDateTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { ASSET_STATUS_LABELS, COVERAGE_LABELS, FILE_KIND_LABELS, VALUE_BASIS_LABELS, WARRANTY_KIND_LABELS } from "@/shared/assets/types";
import { fileUrl } from "../assets-api";
import { ASSETS, AssetsHeader, Money, shortDate } from "../shared";

export const AssetsRegisterPage = ({ data }: { data: PageData<"assets-register"> }) => {
    const title = data.kind === "claim" ? "Insurance claim documentation" : data.kind === "inventory" ? "Asset inventory" : "Household asset register";
    const groups = new Map<string, typeof data.assets>();
    for (const a of data.assets) {
        const key = a.locationHidden ? "A place not shared with you" : (a.location?.name ?? "No place recorded");
        groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const byPlace = data.kind === "household" ? [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)) : [["All assets", data.assets] as const];
    return (
        <>
            <div className="print:hidden">
                <AssetsHeader
                    title={title}
                    description="Print this page, or choose Save as PDF in the print dialog."
                    crumbs={[{ label: "Reports", href: `${ASSETS}/reports` }, { label: title }]}
                    actions={
                        <Button size="sm" iconLeading={Printer} onClick={() => window.print()}>
                            Print
                        </Button>
                    }
                />
            </div>
            <article className="flex flex-col gap-6 text-primary">
                <header className="hidden flex-col gap-1 print:flex">
                    <h1 className="text-xl font-semibold">{title}</h1>
                    <p className="text-sm">
                        Prepared {formatDateTime(data.generatedAt)} from Daly Portal · Home & Assets. Values are as recorded, each labelled with where it came
                        from.
                    </p>
                </header>
                {data.kind === "claim"
                    ? data.details.map((d) => (
                          <section
                              key={d.asset.id}
                              className="flex break-inside-avoid flex-col gap-3 rounded-xl p-4 ring-1 ring-secondary print:rounded-none print:p-0 print:ring-0"
                          >
                              <h2 className="text-lg font-semibold">{d.asset.name}</h2>
                              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                                  {[
                                      ["Category", d.asset.categoryLabel],
                                      ["Manufacturer and model", [d.asset.manufacturer ?? d.asset.brand, d.asset.model].filter(Boolean).join(" ") || null],
                                      ["Serial number", d.asset.serialNumber],
                                      ["Registration", d.vehicle?.registration ?? null],
                                      ["VIN", d.vehicle?.vin ?? null],
                                      [
                                          "Purchased",
                                          d.asset.purchaseDate
                                              ? `${shortDate(d.asset.purchaseDate)}${d.asset.purchaseLocation ? `, ${d.asset.purchaseLocation}` : ""}`
                                              : null,
                                      ],
                                      ["Status", ASSET_STATUS_LABELS[d.asset.status]],
                                      ["Insurance record", COVERAGE_LABELS[d.asset.coverage]],
                                  ].map(([label, value]) => (
                                      <div key={label} className="flex gap-2">
                                          <dt className="text-tertiary">{label}:</dt>
                                          <dd>{value ?? <span className="text-quaternary">Not recorded</span>}</dd>
                                      </div>
                                  ))}
                                  <div className="flex gap-2">
                                      <dt className="text-tertiary">Purchase price (actual):</dt>
                                      <dd>
                                          <Money cents={d.asset.purchasePriceCents} hidden={d.asset.financialHidden} />
                                      </dd>
                                  </div>
                                  <div className="flex gap-2">
                                      <dt className="text-tertiary">Replacement value:</dt>
                                      <dd>
                                          <Money cents={d.asset.replacementValue?.amountCents} hidden={d.asset.financialHidden} />
                                          {d.asset.replacementValue && ` (${VALUE_BASIS_LABELS[d.asset.replacementValue.basis]})`}
                                      </dd>
                                  </div>
                              </dl>
                              {d.warranties.length > 0 && (
                                  <p className="text-sm">
                                      Warranties:{" "}
                                      {d.warranties
                                          .map((w) => `${WARRANTY_KIND_LABELS[w.kind]}${w.expiresOn ? ` to ${shortDate(w.expiresOn)}` : ""}`)
                                          .join("; ")}
                                  </p>
                              )}
                              {d.policies && d.policies.length > 0 && (
                                  <p className="text-sm">
                                      Linked policies: {d.policies.map((p) => `${p.provider}${p.reference ? ` (${p.reference})` : ""}`).join("; ")}
                                  </p>
                              )}
                              <p className="text-sm">
                                  Documents:{" "}
                                  {d.files
                                      .filter((f) => f.kind !== "photo")
                                      .map((f) => `${FILE_KIND_LABELS[f.kind]}: ${f.filename}`)
                                      .join("; ") || "none recorded"}
                                  {d.documentsHidden > 0 && ` (${d.documentsHidden} not shared with you)`}
                              </p>
                              {d.files.some((f) => f.kind === "photo") && (
                                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                                      {d.files
                                          .filter((f) => f.kind === "photo")
                                          .slice(0, 8)
                                          .map((f) => (
                                              <img
                                                  key={f.id}
                                                  src={fileUrl(f.id, f.hasThumb)}
                                                  alt={f.caption ?? `Photo of ${d.asset.name}`}
                                                  className="aspect-square w-full rounded object-cover"
                                              />
                                          ))}
                                  </div>
                              )}
                          </section>
                      ))
                    : byPlace.map(([place, list]) => (
                          <section key={place} className="flex flex-col gap-2">
                              <h2 className="text-md font-semibold">{place}</h2>
                              {/* Focusable so the table can be scrolled sideways from the keyboard on a narrow screen. */}
                              <div
                                  className="overflow-x-auto rounded outline-focus-ring focus-visible:outline-2"
                                  tabIndex={0}
                                  role="region"
                                  aria-label={`Assets: ${place}`}
                              >
                                  <table className="w-full text-left text-sm">
                                      <thead className="text-xs text-tertiary">
                                          <tr className="border-b border-secondary">
                                              <th className="py-2 pr-3 font-medium">Asset</th>
                                              <th className="py-2 pr-3 font-medium">Make and model</th>
                                              <th className="py-2 pr-3 font-medium">Serial</th>
                                              <th className="py-2 pr-3 font-medium">Purchased</th>
                                              <th className="py-2 pr-3 font-medium">Price</th>
                                              <th className="py-2 pr-3 font-medium">Replacement</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          {list.map((a) => (
                                              <tr key={a.id} className="break-inside-avoid border-b border-secondary align-top">
                                                  <td className="py-2 pr-3 font-medium">
                                                      {a.name}
                                                      <span className="block text-xs font-normal text-tertiary">{a.categoryLabel}</span>
                                                  </td>
                                                  <td className="py-2 pr-3">{[a.manufacturer ?? a.brand, a.model].filter(Boolean).join(" ")}</td>
                                                  <td className="py-2 pr-3">{a.serialNumber ?? a.vehicle?.registration ?? ""}</td>
                                                  <td className="py-2 pr-3">{shortDate(a.purchaseDate)}</td>
                                                  <td className="py-2 pr-3">
                                                      <Money cents={a.purchasePriceCents} hidden={a.financialHidden} />
                                                  </td>
                                                  <td className="py-2 pr-3">
                                                      <Money cents={a.replacementValue?.amountCents} hidden={a.financialHidden} />
                                                  </td>
                                              </tr>
                                          ))}
                                      </tbody>
                                  </table>
                              </div>
                          </section>
                      ))}
                {!data.assets.length && <p className="text-sm text-tertiary">Nothing to include.</p>}
            </article>
        </>
    );
};
