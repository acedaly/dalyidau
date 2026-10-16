import { useState } from "react";
import {
    ArrowDown,
    ArrowUp,
    Download01,
    Eye,
    LayoutAlt04,
    Mail01,
    MessageChatSquare,
    Plus,
    RefreshCcw01,
    Trash01,
    Upload01,
    UserPlus01,
} from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Select } from "@/components/base/select/select";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { WIDGETS, WidgetLink } from "@/portal/dashboard/widgets";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { DashboardWidget, WidgetSize, WidgetType } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

const SPAN: Record<WidgetSize, string> = {
    sm: "xl:col-span-4",
    md: "md:col-span-2 xl:col-span-8",
    lg: "md:col-span-2 xl:col-span-12",
};

const SIZE_OPTIONS = [
    { id: "sm", label: "One third" },
    { id: "md", label: "Two thirds" },
    { id: "lg", label: "Full width" },
];

export const DashboardPage = ({ data }: { data: PageData<"dashboard"> }) => {
    const portal = usePortal();
    const toast = useToast();
    const [widgets, setWidgets] = useState<DashboardWidget[]>(data.widgets);
    const [draft, setDraft] = useState<DashboardWidget[] | null>(null);
    const [saving, setSaving] = useState(false);

    const ctx = { stats: data.stats, wedding: portal.wedding, flags: portal.flags, can: portal.can, sideLabel: portal.sideLabel };
    const editing = draft !== null;
    const shown = (draft ?? widgets).filter((w) => WIDGETS[w.type]?.available(ctx));
    const unused = (Object.keys(WIDGETS) as WidgetType[]).filter((type) => WIDGETS[type].available(ctx) && !(draft ?? []).some((w) => w.type === type));

    const update = (next: DashboardWidget[]) => setDraft(next);
    const move = (index: number, delta: number) => {
        if (!draft) return;
        const list = [...draft];
        // Indexes refer to the visible list; map back to the full draft.
        const from = draft.indexOf(shown[index]);
        const to = draft.indexOf(shown[index + delta]);
        if (from < 0 || to < 0) return;
        [list[from], list[to]] = [list[to], list[from]];
        update(list);
    };

    const save = async (body: { widgets?: DashboardWidget[]; reset?: boolean }) => {
        setSaving(true);
        try {
            const result = await api<{ widgets: DashboardWidget[] }>("PUT", "/api/portal/dashboard", body);
            setWidgets(result.widgets);
            setDraft(null);
            toast.success(body.reset ? "Dashboard reset" : "Dashboard saved");
        } catch (error) {
            toast.error("Couldn't save the dashboard", errorMessage(error));
        } finally {
            setSaving(false);
        }
    };

    const couple = `${portal.wedding.partnerOne} & ${portal.wedding.partnerTwo}`;

    return (
        <>
            <PageHeader
                title={`Welcome back${portal.user.name ? `, ${portal.user.name.split(" ")[0]}` : ""}`}
                description={`Everything for ${couple}'s wedding at a glance.`}
                breadcrumbs={[{ label: "Wedding Planner" }]}
                actions={
                    editing ? (
                        <>
                            <Button color="tertiary" iconLeading={RefreshCcw01} onClick={() => save({ reset: true })} isDisabled={saving}>
                                Reset to default
                            </Button>
                            <Button color="secondary" onClick={() => setDraft(null)} isDisabled={saving}>
                                Cancel
                            </Button>
                            <Button onClick={() => save({ widgets: draft! })} isLoading={saving} showTextWhileLoading>
                                Save layout
                            </Button>
                        </>
                    ) : (
                        <Button color="secondary" iconLeading={LayoutAlt04} onClick={() => setDraft(widgets)}>
                            Customise
                        </Button>
                    )
                }
            />

            {!editing && (
                <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
                    {portal.can("wedding.guests.edit") && (
                        <>
                            <Button size="sm" color="secondary" iconLeading={UserPlus01} href="/portal/wedding/guests?new=1">
                                Add guest
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Upload01} href="/portal/wedding/guests/import">
                                Import guests
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Mail01} href="/portal/wedding/invitations">
                                Generate invitations
                            </Button>
                        </>
                    )}
                    {portal.can("portal.settings.manage") && portal.flags["module.communications"] && (
                        <Button size="sm" color="secondary" iconLeading={MessageChatSquare} href="/portal/wedding/communications/providers">
                            Send test email
                        </Button>
                    )}
                    <Button size="sm" color="secondary" iconLeading={Eye} href="/portal/wedding/website/preview/rsvp">
                        Preview RSVP
                    </Button>
                    <Button size="sm" color="secondary" href="/portal/wedding/households?status=not_started">
                        Review outstanding replies
                    </Button>
                    {portal.can("wedding.export") && (
                        <Dropdown.Root>
                            <Button size="sm" color="secondary" iconLeading={Download01}>
                                Export reports
                            </Button>
                            <Dropdown.Popover className="w-64">
                                <Dropdown.Menu onAction={(key) => window.location.assign(`/api/portal/export/${String(key)}.csv`)}>
                                    <Dropdown.Item id="guests" label="Guest list" />
                                    <Dropdown.Item id="invitations" label="Households and invitations" />
                                    <Dropdown.Item id="rsvps" label="RSVPs" />
                                    {portal.flags["module.planning"] && <Dropdown.Item id="dietary" label="Dietary requirements (caterer)" />}
                                    {portal.flags["module.planning"] && <Dropdown.Item id="catering" label="Catering list" />}
                                    <Dropdown.Item id="transport" label="Courtesy bus (for the RSL)" />
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown.Root>
                    )}
                </nav>
            )}

            {editing && (
                <div
                    className="flex flex-col gap-3 rounded-xl bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
                    role="region"
                    aria-label="Customise dashboard"
                >
                    <p className="text-sm text-secondary">Reorder, resize or remove widgets, then save. Your layout is personal to you.</p>
                    <Dropdown.Root>
                        <Button size="sm" iconLeading={Plus} isDisabled={unused.length === 0}>
                            Add widget
                        </Button>
                        <Dropdown.Popover className="w-72">
                            <Dropdown.Menu
                                onAction={(key) => {
                                    const type = key as WidgetType;
                                    update([...draft!, { id: `w-${type}-${Date.now().toString(36)}`, type, size: WIDGETS[type].defaultSize }]);
                                }}
                            >
                                {unused.map((type) => (
                                    <Dropdown.Item key={type} id={type} textValue={WIDGETS[type].title}>
                                        <span className="flex flex-col">
                                            <span>{WIDGETS[type].title}</span>
                                            <span className="text-xs font-normal text-tertiary">{WIDGETS[type].description}</span>
                                        </span>
                                    </Dropdown.Item>
                                ))}
                            </Dropdown.Menu>
                        </Dropdown.Popover>
                    </Dropdown.Root>
                </div>
            )}

            {shown.length === 0 ? (
                <div className="rounded-xl border border-dashed border-primary p-10 text-center">
                    <p className="text-md font-semibold text-primary">Your dashboard is empty</p>
                    <p className="mt-1 text-sm text-tertiary">Choose Customise, then Add widget.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-12">
                    {shown.map((widget, index) => {
                        const def = WIDGETS[widget.type];
                        const Body = def.render;
                        return (
                            <section
                                key={widget.id}
                                aria-labelledby={`${widget.id}-title`}
                                className={cx(
                                    "flex flex-col gap-5 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset",
                                    SPAN[widget.size],
                                    editing && "ring-2 ring-brand",
                                )}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <h2 id={`${widget.id}-title`} className="text-md font-semibold text-primary">
                                        {def.title}
                                    </h2>
                                    {editing ? (
                                        <div className="flex shrink-0 items-center gap-1">
                                            <ButtonUtility
                                                size="xs"
                                                color="tertiary"
                                                icon={ArrowUp}
                                                tooltip="Move earlier"
                                                isDisabled={index === 0}
                                                onClick={() => move(index, -1)}
                                            />
                                            <ButtonUtility
                                                size="xs"
                                                color="tertiary"
                                                icon={ArrowDown}
                                                tooltip="Move later"
                                                isDisabled={index === shown.length - 1}
                                                onClick={() => move(index, 1)}
                                            />
                                            <ButtonUtility
                                                size="xs"
                                                color="tertiary"
                                                icon={Trash01}
                                                tooltip="Remove"
                                                onClick={() => update(draft!.filter((w) => w.id !== widget.id))}
                                            />
                                        </div>
                                    ) : (
                                        def.link && <WidgetLink {...def.link} />
                                    )}
                                </div>
                                {editing && (
                                    <Select
                                        aria-label={`Size of ${def.title}`}
                                        size="sm"
                                        items={SIZE_OPTIONS}
                                        value={widget.size}
                                        onChange={(size) => update(draft!.map((w) => (w.id === widget.id ? { ...w, size: size as WidgetSize } : w)))}
                                    >
                                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                    </Select>
                                )}
                                <Body {...ctx} />
                            </section>
                        );
                    })}
                </div>
            )}
        </>
    );
};
