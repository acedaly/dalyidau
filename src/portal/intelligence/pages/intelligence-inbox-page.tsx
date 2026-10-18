// The AI Suggestions Inbox: review, edit, approve (one or several) and dismiss. Approving several at
// once goes in a safe order on the server: new projects and notes first, then the tasks using them.
import { useMemo, useState } from "react";
import { Check, Inbox01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { SuggestionView } from "@/shared/intelligence/types";
import { intelligenceApi } from "../api";
import { AvailabilityNotice, SuggestionCard } from "../shared";

const FILTERS = [
    { id: "pending", label: "To review" },
    { id: "applied", label: "Approved" },
    { id: "dismissed", label: "Dismissed" },
    { id: "all", label: "All" },
] as const;

export const IntelligenceInboxPage = ({ data }: { data: PageData<"intelligence-inbox"> }) => {
    const toast = useToast();
    const [suggestions, setSuggestions] = useState<SuggestionView[]>(data.suggestions);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const visible = useMemo(
        () => (data.filter === "pending" ? suggestions.filter((s) => s.status === "pending" || s.status === "failed" || s.status === "applying") : suggestions),
        [data.filter, suggestions],
    );

    const reload = async () => setSuggestions((await intelligenceApi.suggestions(data.filter)).suggestions);
    const approveSelected = async () => {
        setBusy(true);
        try {
            const result = await intelligenceApi.approveMany([...selected]);
            const failed = result.results.filter((r) => !r.ok);
            if (failed.length) toast.error(`${pluralise(result.approved, "suggestion")} approved, ${failed.length} not`, failed[0].error?.message);
            else toast.success(`${pluralise(result.approved, "suggestion")} approved`);
            setSelected(new Set());
            await reload();
        } catch (e) {
            toast.error("Couldn't approve", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <PageHeader
                title="Suggestions"
                description="Proposed tasks, notes, decisions and links from what you captured. Check each one: it says where it came from."
                breadcrumbs={[{ label: "Intelligence", href: "/portal/intelligence" }, { label: "Suggestions" }]}
            >
                <Tabs selectedKey={data.filter} onSelectionChange={(k) => (window.location.href = `/portal/intelligence/inbox${k === "pending" ? "" : `?filter=${String(k)}`}`)}>
                    <Tabs.List type="underline" size="sm" className="overflow-x-auto">
                        {FILTERS.map((f) => (
                            <Tabs.Item key={f.id} id={f.id}>
                                {f.label}
                            </Tabs.Item>
                        ))}
                    </Tabs.List>
                    {/* The tabs navigate between pages; each needs a panel to point at for assistive technology. */}
                    {FILTERS.map((f) => (
                        <Tabs.Panel key={f.id} id={f.id} aria-label={`${f.label} suggestions`} />
                    ))}
                </Tabs>
            </PageHeader>
            <AvailabilityNotice shell={data} need={[]} />

            {data.filter === "pending" && visible.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" color="secondary" onClick={() => setSelected(selected.size === visible.length ? new Set() : new Set(visible.map((s) => s.id)))}>
                        {selected.size === visible.length ? "Clear selection" : "Select all"}
                    </Button>
                    <Button size="sm" iconLeading={Check} isDisabled={!selected.size} isLoading={busy} onClick={approveSelected}>
                        Approve {selected.size ? pluralise(selected.size, "selected") : "selected"}
                    </Button>
                </div>
            )}

            <section className="overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                {visible.length ? (
                    <ul className="divide-y divide-secondary">
                        {visible.map((s) => (
                            <SuggestionCard
                                key={s.id}
                                suggestion={s}
                                selected={selected.has(s.id)}
                                onSelect={(on) =>
                                    setSelected((current) => {
                                        const next = new Set(current);
                                        if (on) next.add(s.id);
                                        else next.delete(s.id);
                                        return next;
                                    })
                                }
                                onChange={(next) => {
                                    setSuggestions((list) => list.map((x) => (x.id === s.id && next ? next : x)));
                                    if (next && next.status !== "pending") setSelected((current) => new Set([...current].filter((id) => id !== s.id)));
                                }}
                            />
                        ))}
                    </ul>
                ) : (
                    <div className="px-6 py-12">
                        <Empty icon={Inbox01} title={data.filter === "pending" ? "Nothing to review" : "Nothing here"} description="Suggestions appear after you capture something." actions={<Button href="/portal/intelligence/capture">Capture</Button>} />
                    </div>
                )}
            </section>
        </>
    );
};
