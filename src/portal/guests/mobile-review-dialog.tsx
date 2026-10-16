// Mobile number review: previews how saved guest and household numbers would be standardised to
// international format (+61412345678) and applies only the ones ticked. Opening it changes nothing.
import { useEffect, useState } from "react";
import { Phone01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import { MOBILE_REVIEW_BATCH, type MobileReview, type MobileReviewRow } from "@/shared/portal/types";

const keyOf = (row: MobileReviewRow) => `${row.kind}:${row.id}`;

const STATUS: Record<MobileReviewRow["status"], { label: string; color: "brand" | "warning" | "error" }> = {
    update: { label: "Standardise", color: "brand" },
    check: { label: "Check first", color: "warning" },
    invalid: { label: "Fix by hand", color: "error" },
};

const ORDER: MobileReviewRow["status"][] = ["check", "update", "invalid"];

export const MobileReviewDialog = ({ isOpen, onOpenChange, onApplied }: { isOpen: boolean; onOpenChange: (open: boolean) => void; onApplied: () => void }) => {
    const toast = useToast();
    const [review, setReview] = useState<MobileReview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);

    const load = (next: MobileReview) => {
        setReview(next);
        // Only clear-cut numbers start ticked; ones read with an assumption wait for a person.
        setChosen(new Set(next.rows.filter((r) => r.status === "update").map(keyOf)));
    };

    useEffect(() => {
        if (!isOpen) return;
        setReview(null);
        setError(null);
        api<MobileReview>("GET", "/api/portal/wedding/mobile-numbers")
            .then(load)
            .catch((e) => setError(errorMessage(e)));
    }, [isOpen]);

    const toggle = (row: MobileReviewRow, on: boolean) =>
        setChosen((current) => {
            const next = new Set(current);
            if (on) next.add(keyOf(row));
            else next.delete(keyOf(row));
            return next;
        });

    const apply = async () => {
        if (!review) return;
        const changes = review.rows.filter((r) => r.proposed && chosen.has(keyOf(r))).map((r) => ({ kind: r.kind, id: r.id, from: r.stored, to: r.proposed! }));
        setBusy(true);
        // The server takes a limited number per request, so a large selection goes in batches. Each
        // batch is applied on its own; if one fails, the ones before it have still been saved.
        let updated = 0;
        let skipped = 0;
        try {
            for (let start = 0; start < changes.length; start += MOBILE_REVIEW_BATCH) {
                const result = await api<{ updated: number; skipped: number; review: MobileReview }>("POST", "/api/portal/wedding/mobile-numbers", {
                    changes: changes.slice(start, start + MOBILE_REVIEW_BATCH),
                    confirmed: true,
                });
                updated += result.updated;
                skipped += result.skipped;
                if (start + MOBILE_REVIEW_BATCH >= changes.length) load(result.review);
            }
            toast.success(
                `Standardised ${pluralise(updated, "number")}`,
                skipped ? `${pluralise(skipped, "number")} changed since the preview and ${skipped === 1 ? "was" : "were"} left alone.` : undefined,
            );
            onApplied();
        } catch (e) {
            toast.error(
                "Couldn't standardise the numbers",
                updated ? `${pluralise(updated, "number")} saved before this. ${errorMessage(e)}` : errorMessage(e),
            );
            if (updated) {
                api<MobileReview>("GET", "/api/portal/wedding/mobile-numbers")
                    .then(load)
                    .catch(() => undefined);
                onApplied();
            }
        } finally {
            setBusy(false);
        }
    };

    const rows = review ? [...review.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)) : [];
    const selectedCount = rows.filter((r) => r.proposed && chosen.has(keyOf(r))).length;

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={(open) => !busy && onOpenChange(open)}
            title="Review mobile numbers"
            description="Texts are sent to numbers in international format (+61412345678). Nothing changes until you choose numbers and select Standardise."
            icon={Phone01}
            size="lg"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Close
                    </Button>
                    {review && review.counts.update + review.counts.check > 0 && (
                        <Button size="lg" onClick={apply} isLoading={busy} showTextWhileLoading isDisabled={selectedCount === 0}>
                            Standardise {pluralise(selectedCount, "number")}
                        </Button>
                    )}
                </>
            }
        >
            {error && (
                <Notice title="Couldn't load the numbers" color="error">
                    {error}
                </Notice>
            )}
            {!review && !error && <p className="text-sm text-tertiary">Checking saved numbers…</p>}
            {review && (
                <>
                    <p className="text-sm text-tertiary" aria-live="polite">
                        {pluralise(review.counts.standard, "number")} already standard · {review.counts.update} to standardise · {review.counts.check} to check
                        · {review.counts.invalid} to fix by hand
                    </p>
                    {rows.length === 0 ? (
                        <Notice title="Every saved number is already in international format" color="success" />
                    ) : (
                        <ul className="flex max-h-[35vh] flex-col divide-y divide-secondary overflow-y-auto rounded-xl border border-secondary sm:max-h-[50vh]">
                            {rows.map((row) => (
                                <li key={keyOf(row)} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="flex min-w-0 items-start gap-3">
                                        {row.proposed ? (
                                            <Checkbox
                                                aria-label={`Standardise ${row.name}'s number`}
                                                isSelected={chosen.has(keyOf(row))}
                                                onChange={(on) => toggle(row, on)}
                                                isDisabled={busy}
                                            />
                                        ) : (
                                            <span className="size-4 shrink-0" aria-hidden="true" />
                                        )}
                                        <div className="flex min-w-0 flex-col gap-0.5">
                                            <p className="text-sm font-medium text-primary">
                                                {row.name}
                                                <span className="font-normal text-tertiary">
                                                    {row.kind === "household" ? " · household contact" : row.household ? ` · ${row.household}` : ""}
                                                </span>
                                            </p>
                                            <p className="text-sm text-tertiary">
                                                <span className="font-mono">{row.stored}</span>
                                                {row.proposed && (
                                                    <>
                                                        {" → "}
                                                        <span className="font-mono text-secondary">{row.proposed}</span>
                                                    </>
                                                )}
                                            </p>
                                            {row.reason && <p className="text-xs text-tertiary">{row.reason}</p>}
                                        </div>
                                    </div>
                                    <Badge size="sm" color={STATUS[row.status].color} type="pill-color">
                                        {STATUS[row.status].label}
                                    </Badge>
                                </li>
                            ))}
                        </ul>
                    )}
                    {review.counts.invalid > 0 && (
                        <p className="text-sm text-tertiary">
                            Numbers marked “Fix by hand” are never changed automatically. Open the guest or household and correct or clear them; until then
                            they're left out of texts.
                        </p>
                    )}
                </>
            )}
        </PortalDialog>
    );
};
