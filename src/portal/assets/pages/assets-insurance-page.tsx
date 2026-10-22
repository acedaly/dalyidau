// Insurance: policies, renewals, premium history, the assets each names, claims, and a coverage
// overview. A policy is the household's record of what the documents say. Nothing is shown as
// covered until a person verifies the policy against its documents, and AI suggestions (when on)
// are shown beside the original for checking, never saved by themselves.
import { useEffect, useState } from "react";
import { CheckCircle, Download01, Edit05, File04, Link01, Plus, RefreshCw01, ShieldTick, Stars02, Trash01 } from "@untitledui/icons";
import { FileUpload } from "@/components/application/file-upload/file-upload-base";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import { DataTable } from "@/portal/components/data-table";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { RecordPanel } from "@/portal/components/record-panel";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatMoney } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { annualPremium } from "@/shared/assets/engine";
import {
    type AssetFileView,
    CLAIM_STATUS_LABELS,
    COVERAGE_LABELS,
    FREQUENCY_LABELS,
    PAYMENTS_PER_YEAR,
    POLICY_STATUS_LABELS,
    POLICY_TYPE_LABELS,
    type PolicyProposal,
    type PolicyView,
} from "@/shared/assets/types";
import { assetsApi, fileUrl, reportUrl } from "../assets-api";
import { ClaimForm, PolicyForm, RenewForm } from "../forms";
import { AssetsHeader, CoverageBadge, DateWithDistance, Money, assetHref, prepareFile, shortDate } from "../shared";

const yearly = (p: Pick<PolicyView, "premiumCents" | "paymentFrequency">) =>
    annualPremium(p.premiumCents, p.paymentFrequency ? PAYMENTS_PER_YEAR[p.paymentFrequency] : null);

const PremiumChange = ({ policy }: { policy: PolicyView }) => {
    const previous = policy.premiums.find((p) => p.periodStart !== policy.startsOn);
    const now = yearly(policy);
    const before = previous ? annualPremium(previous.premiumCents, previous.paymentFrequency ? PAYMENTS_PER_YEAR[previous.paymentFrequency] : null) : null;
    if (now === null || before === null) return null;
    const change = now - before;
    const pct = before > 0 ? Math.round((change / before) * 1000) / 10 : null;
    return (
        <span className={change > 0 ? "text-error-primary" : "text-success-primary"}>
            {change >= 0 ? "Up" : "Down"} {formatMoney(Math.abs(change))} a year{pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""} on the previous period
        </span>
    );
};

const PolicyPanel = ({
    policy,
    data,
    onChanged,
    onClose,
}: {
    policy: PolicyView;
    data: PageData<"assets-insurance">;
    onChanged: (p: PolicyView | null) => void;
    onClose: () => void;
}) => {
    const toast = useToast();
    const [files, setFiles] = useState<AssetFileView[]>([]);
    const [dialog, setDialog] = useState<null | "edit" | "renew" | "delete" | "claim" | { prefill: Record<string, string> }>(null);
    const [linkAsset, setLinkAsset] = useState("");
    const [proposal, setProposal] = useState<{ fileId: string; proposal: PolicyProposal } | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        void assetsApi.policy(policy.id).then((r) => setFiles(r.files));
    }, [policy.id]);
    const run = async (label: string, action: () => Promise<{ policy: PolicyView }>) => {
        try {
            const r = await action();
            toast.success(label);
            onChanged(r.policy);
        } catch (e) {
            toast.error("That didn't work", errorMessage(e));
        }
    };
    const upload = async (list: File[]) => {
        setBusy(true);
        for (const file of list) {
            try {
                const prepared = await prepareFile(file, "policy");
                await assetsApi.upload({ ...prepared, kind: "policy", policyId: policy.id });
            } catch (e) {
                toast.error(`Couldn't add ${file.name}`, e instanceof Error ? e.message : errorMessage(e));
            }
        }
        setFiles((await assetsApi.policy(policy.id)).files);
        setBusy(false);
    };
    const extract = async (fileId: string) => {
        setBusy(true);
        try {
            setProposal({ fileId, proposal: (await assetsApi.extractPolicy(policy.id, fileId)).proposal });
        } catch (e) {
            toast.error("No suggestion", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const usable = proposal
        ? Object.fromEntries(
              Object.entries(proposal.proposal.fields)
                  .filter(([, v]) => v && (v.grounded || typeof v.value === "string"))
                  .map(([k, v]) => [
                      k === "premiumCents" ? "premium" : k === "excessCents" ? "excess" : k,
                      k.endsWith("Cents") ? (Number(v!.value) / 100).toFixed(2) : String(v!.value),
                  ]),
          )
        : {};
    return (
        <RecordPanel
            isOpen
            onOpenChange={(o) => !o && onClose()}
            width="lg"
            title={policy.name ?? policy.provider}
            description={`${policy.provider} · ${POLICY_TYPE_LABELS[policy.policyType]} · ${POLICY_STATUS_LABELS[policy.status]}`}
            footer={
                policy.canEdit && (
                    <>
                        {policy.mine && (
                            <Button size="md" color="secondary-destructive" iconLeading={Trash01} onClick={() => setDialog("delete")}>
                                Delete
                            </Button>
                        )}
                        <Button size="md" color="secondary" iconLeading={RefreshCw01} onClick={() => setDialog("renew")}>
                            Renew
                        </Button>
                        <Button size="md" iconLeading={Edit05} onClick={() => setDialog("edit")}>
                            Edit
                        </Button>
                    </>
                )
            }
        >
            <div className="flex flex-col gap-6">
                {policy.verified ? (
                    <Notice title="Verified" color="success">
                        Checked against the documents by {policy.verified.by} on {shortDate(policy.verified.at.slice(0, 10))}. This is your record of the
                        policy; the insurer's wording decides what's covered.
                    </Notice>
                ) : (
                    <Notice
                        title="Not yet verified"
                        color="warning"
                        actions={
                            policy.canEdit && (
                                <Button
                                    size="sm"
                                    iconLeading={CheckCircle}
                                    onClick={() => void run("Verified", () => assetsApi.verifyPolicy(policy.id, policy.version))}
                                >
                                    I've checked it against the documents
                                </Button>
                            )
                        }
                    >
                        Until it's verified, its assets show as "linked policy not yet verified".
                        {policy.unverifiedFields.length > 0 && ` From an AI suggestion, unchecked: ${policy.unverifiedFields.join(", ")}.`}
                    </Notice>
                )}
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    {[
                        ["Policy number", policy.reference],
                        ["Period", policy.startsOn || policy.renewsOn ? `${shortDate(policy.startsOn) || "?"} to ${shortDate(policy.renewsOn) || "?"}` : null],
                        [
                            "Premium",
                            policy.premiumCents !== null
                                ? `${formatMoney(policy.premiumCents)}${policy.paymentFrequency ? ` ${FREQUENCY_LABELS[policy.paymentFrequency].toLowerCase()}` : ""}`
                                : null,
                        ],
                        ["Excess", policy.excessCents !== null ? formatMoney(policy.excessCents) : null],
                        ["Claims contact", [policy.contactPhone, policy.contactEmail].filter(Boolean).join(" · ") || null],
                        ["Added by", policy.mine ? "You" : (policy.owner.name ?? policy.owner.email)],
                    ].map(([label, value]) => (
                        <div key={label}>
                            <dt className="text-tertiary">{label}</dt>
                            <dd className="text-primary">{value ?? <span className="text-quaternary">Not recorded</span>}</dd>
                        </div>
                    ))}
                </dl>
                <PremiumChange policy={policy} />
                {[
                    ["What it covers (your summary)", policy.coverageSummary],
                    ["Limits", policy.coverageLimits],
                    ["Exclusions", policy.exclusions],
                    ["Notes", policy.notes],
                ].map(([label, value]) =>
                    value ? (
                        <div key={label} className="flex flex-col gap-1 text-sm">
                            <span className="font-semibold text-secondary">{label}</span>
                            <p className="whitespace-pre-line text-tertiary">{value}</p>
                        </div>
                    ) : null,
                )}
                <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold text-secondary">Assets it names</h3>
                    {policy.assets.length ? (
                        <ul className="flex flex-col divide-y divide-secondary rounded-lg ring-1 ring-secondary">
                            {policy.assets.map((a) => (
                                <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                                    <a href={assetHref(a.id, "cover")} className="text-primary hover:underline">
                                        {a.name}
                                        {a.agreedValueCents !== null && (
                                            <span className="text-tertiary"> · agreed value {formatMoney(a.agreedValueCents)}</span>
                                        )}
                                    </a>
                                    {policy.canEdit && (
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip="Unlink"
                                            onClick={() => void run("Unlinked", () => assetsApi.unlinkPolicy(policy.id, a.id))}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">No assets linked.</p>
                    )}
                    {policy.hiddenAssetCount > 0 && <p className="text-xs text-tertiary">{policy.hiddenAssetCount} more not shared with you.</p>}
                    {data.assets.length > 0 && (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <NativeSelect
                                label="Link an asset"
                                value={linkAsset}
                                onChange={(e) => setLinkAsset(e.target.value)}
                                options={[
                                    { value: "", label: "Choose an asset" },
                                    ...data.assets.filter((a) => !policy.assets.some((x) => x.id === a.id)).map((a) => ({ value: a.id, label: a.name })),
                                ]}
                            />
                            <Button
                                size="md"
                                color="secondary"
                                iconLeading={Link01}
                                isDisabled={!linkAsset}
                                onClick={() => void run("Linked", () => assetsApi.linkPolicy(policy.id, { assetId: linkAsset })).then(() => setLinkAsset(""))}
                            >
                                Link
                            </Button>
                        </div>
                    )}
                </section>
                <section className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold text-secondary">Policy documents</h3>
                    {files.map((f) => (
                        <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
                            <a href={fileUrl(f.id)} className="text-primary hover:underline">
                                {f.filename}
                            </a>
                            {data.canAi && policy.canEdit && (
                                <Button size="xs" color="secondary" iconLeading={Stars02} isLoading={busy} onClick={() => void extract(f.id)}>
                                    Suggest details
                                </Button>
                            )}
                        </div>
                    ))}
                    {policy.canEdit && (
                        <FileUpload.DropZone
                            hint="PDF or photo of the schedule or certificate, up to 10 MB"
                            accept="application/pdf,image/*"
                            isDisabled={busy}
                            onDropFiles={(l) => void upload(Array.from(l))}
                        />
                    )}
                    {!data.canAi && data.aiNote && files.length > 0 && <p className="text-xs text-tertiary">{data.aiNote}</p>}
                </section>
                {proposal && (
                    <section className="ring-warning_subtle flex flex-col gap-3 rounded-lg p-4 ring-1">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-secondary">
                            <Stars02 aria-hidden="true" className="size-4" /> Suggested from the document
                        </h3>
                        <p className="text-xs text-tertiary">{proposal.proposal.note}</p>
                        <a href={fileUrl(proposal.fileId)} className="text-sm text-brand-secondary hover:underline">
                            Open the original document
                        </a>
                        <ul className="flex flex-col gap-1 text-sm">
                            {Object.entries(proposal.proposal.fields).map(([k, v]) => (
                                <li key={k}>
                                    <span className="text-tertiary">{k}: </span>
                                    <span className="text-primary">{k.endsWith("Cents") ? formatMoney(Number(v!.value)) : String(v!.value)}</span>{" "}
                                    {v!.grounded ? (
                                        <span className="text-xs text-tertiary">“{v!.evidence}”</span>
                                    ) : (
                                        <Badge size="sm" type="color" color="warning">
                                            Not found in the document
                                        </Badge>
                                    )}
                                </li>
                            ))}
                        </ul>
                        {proposal.proposal.coverage.length > 0 && (
                            <div className="text-sm">
                                <p className="font-medium text-secondary">The wording mentions as covered</p>
                                <ul className="list-disc pl-5 text-tertiary">
                                    {proposal.proposal.coverage.map((c, i) => (
                                        <li key={i}>
                                            {c.statement}{" "}
                                            {!c.grounded && (
                                                <Badge size="sm" type="color" color="warning">
                                                    Quote not found
                                                </Badge>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {proposal.proposal.exclusions.length > 0 && (
                            <div className="text-sm">
                                <p className="font-medium text-secondary">The wording mentions as excluded</p>
                                <ul className="list-disc pl-5 text-tertiary">
                                    {proposal.proposal.exclusions.map((c, i) => (
                                        <li key={i}>{c.statement}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                onClick={() =>
                                    setDialog({
                                        prefill: {
                                            ...usable,
                                            ...(proposal.proposal.coverage.length
                                                ? { coverageSummary: proposal.proposal.coverage.map((c) => `- ${c.statement}`).join("\n") }
                                                : {}),
                                            ...(proposal.proposal.exclusions.length
                                                ? { exclusions: proposal.proposal.exclusions.map((c) => `- ${c.statement}`).join("\n") }
                                                : {}),
                                        },
                                    })
                                }
                            >
                                Review and use
                            </Button>
                            <Button size="sm" color="secondary" onClick={() => setProposal(null)}>
                                Discard
                            </Button>
                        </div>
                    </section>
                )}
                <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-secondary">Claims</h3>
                        {policy.canEdit && (
                            <Button size="xs" color="secondary" iconLeading={Plus} onClick={() => setDialog("claim")}>
                                Record a claim
                            </Button>
                        )}
                    </div>
                    {data.claims
                        .filter((c) => c.policyId === policy.id)
                        .map((c) => (
                            <p key={c.id} className="text-sm text-tertiary">
                                {CLAIM_STATUS_LABELS[c.status]} · {c.assetName ?? "Policy"} {c.lodgedOn && `· lodged ${shortDate(c.lodgedOn)}`}
                            </p>
                        ))}
                </section>
            </div>
            {(dialog === "edit" || (dialog && typeof dialog === "object")) && (
                <PolicyForm
                    initial={policy}
                    prefill={dialog === "edit" ? undefined : dialog.prefill}
                    onSaved={(p) => {
                        setDialog(null);
                        setProposal(null);
                        onChanged(p);
                    }}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog === "renew" && (
                <RenewForm
                    policy={policy}
                    onSaved={() =>
                        void assetsApi.policy(policy.id).then((r) => {
                            setDialog(null);
                            onChanged(r.policy);
                        })
                    }
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog === "claim" && (
                <ClaimForm policyId={policy.id} kind="insurance" assets={policy.assets} onSaved={() => setDialog(null)} onClose={() => setDialog(null)} />
            )}
            <ConfirmDialog
                isOpen={dialog === "delete"}
                onOpenChange={(o) => !o && setDialog(null)}
                title="Delete this policy?"
                description="Its documents are deleted and its assets are unlinked. Claims stay, without the policy."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                    await assetsApi.deletePolicy(policy.id);
                    onChanged(null);
                }}
            />
        </RecordPanel>
    );
};

export const AssetsInsurancePage = ({ data }: { data: PageData<"assets-insurance"> }) => {
    const [policies, setPolicies] = useState(data.policies);
    const [open, setOpen] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("policy")));
    const [adding, setAdding] = useState(false);
    const current = policies.find((p) => p.id === open) ?? null;
    return (
        <>
            <AssetsHeader
                title="Insurance"
                description="Your record of each policy and what it names. Only the insurer's wording decides what's covered."
                crumbs={[{ label: "Insurance" }]}
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={Download01} href={reportUrl("renewals")}>
                            Renewals
                        </Button>
                        <Button size="sm" iconLeading={Plus} onClick={() => setAdding(true)}>
                            Add policy
                        </Button>
                    </>
                }
            />
            {policies.length === 0 ? (
                <Empty
                    icon={ShieldTick}
                    title="No policies recorded"
                    description="Add your home, contents, car or caravan policies to track renewals and see which assets they name."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setAdding(true)}>
                            Add a policy
                        </Button>
                    }
                />
            ) : (
                <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {policies.map((p) => (
                        <li key={p.id}>
                            <button
                                type="button"
                                onClick={() => setOpen(p.id)}
                                className="flex w-full cursor-pointer flex-col gap-2 rounded-xl bg-primary p-4 text-left shadow-xs ring-1 ring-secondary outline-focus-ring ring-inset hover:bg-primary_hover focus-visible:outline-2"
                            >
                                <span className="flex items-start justify-between gap-2">
                                    <span className="text-md font-semibold text-primary">{p.name ?? p.provider}</span>
                                    <Badge size="sm" type="pill-color" color={p.verified ? "success" : "warning"}>
                                        {p.verified ? "Verified" : "Not verified"}
                                    </Badge>
                                </span>
                                <span className="text-sm text-tertiary">
                                    {p.provider} · {POLICY_TYPE_LABELS[p.policyType]}
                                    {p.status !== "active" && ` · ${POLICY_STATUS_LABELS[p.status]}`}
                                </span>
                                <span className="text-sm">
                                    {p.renewsOn ? (
                                        <>
                                            Renews <DateWithDistance date={p.renewsOn} today={data.today} />
                                        </>
                                    ) : (
                                        <span className="text-quaternary">No renewal date</span>
                                    )}
                                </span>
                                <span className="text-sm text-tertiary">
                                    <Money cents={yearly(p)} /> a year · {p.assets.length + p.hiddenAssetCount} assets
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <DataTable
                title="Coverage overview"
                description="Which policy records each asset is linked to. “Linked to a verified policy” is the most this can tell you: check the policy for what's covered."
                rows={data.coverage.map((c) => ({ id: c.asset.id, ...c }))}
                searchText={(r) => r.asset.name}
                emptyState={<Empty icon={File04} title="No assets" description="Assets whose insurance you can see appear here." size="sm" />}
                columns={[
                    {
                        id: "asset",
                        label: "Asset",
                        isRowHeader: true,
                        sortValue: (r) => r.asset.name,
                        render: (r) => (
                            <a href={assetHref(r.asset.id, "cover")} className="font-medium text-primary hover:underline">
                                {r.asset.name}
                            </a>
                        ),
                    },
                    { id: "category", label: "Category", className: "max-md:hidden", render: (r) => r.asset.categoryLabel },
                    { id: "state", label: "Insurance record", sortValue: (r) => COVERAGE_LABELS[r.state], render: (r) => <CoverageBadge state={r.state} /> },
                ]}
            />
            {current && (
                <PolicyPanel
                    policy={current}
                    data={data}
                    onChanged={(p) => {
                        if (!p) {
                            setPolicies((list) => list.filter((x) => x.id !== current.id));
                            setOpen(null);
                        } else setPolicies((list) => list.map((x) => (x.id === p.id ? p : x)));
                    }}
                    onClose={() => setOpen(null)}
                />
            )}
            {adding && (
                <PolicyForm
                    onSaved={(p) => {
                        setAdding(false);
                        setPolicies((list) => [...list, p]);
                        setOpen(p.id);
                    }}
                    onClose={() => setAdding(false)}
                />
            )}
            {data.claims.length > 0 && (
                <Card title="Insurance claims" icon={File04}>
                    <ul className="flex flex-col divide-y divide-secondary">
                        {data.claims.map((c) => (
                            <li key={c.id} className="px-4 py-2.5 text-sm sm:px-5">
                                {c.assetName ?? "Policy claim"} · {CLAIM_STATUS_LABELS[c.status]}
                                {c.lodgedOn && ` · lodged ${shortDate(c.lodgedOn)}`}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
        </>
    );
};
