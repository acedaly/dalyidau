import { useState } from "react";
import { Plus, ShieldTick, UserPlus01 } from "@untitledui/icons";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormError, useSubmit } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { initials } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import { ROLES, ROLE_LABELS, type Role } from "@/shared/portal/permissions";
import type { PortalUserRecord } from "@/shared/portal/types";

type Row = PortalUserRecord & { id: string };

export const PeoplePanel = ({ initial }: { initial: PortalUserRecord[] }) => {
    const { user } = usePortal();
    const toast = useToast();
    const [users, setUsers] = useState<PortalUserRecord[]>(initial);
    const [editing, setEditing] = useState<PortalUserRecord | null>(null);
    const [open, setOpen] = useState(false);
    const [removing, setRemoving] = useState<PortalUserRecord | null>(null);
    const [draft, setDraft] = useState({ email: "", name: "", role: "editor" as Role, active: true });

    const openDialog = (record: PortalUserRecord | null) => {
        setEditing(record);
        setDraft({
            email: record?.email ?? "",
            name: record?.name ?? "",
            role: record && record.role !== "owner" ? record.role : "editor",
            active: record?.active ?? true,
        });
        setOpen(true);
    };

    const save = useSubmit(() => api<{ user: PortalUserRecord }>("POST", "/api/portal/users", draft), {
        success: editing ? "Access updated" : "Person added",
        onSuccess: ({ user: saved }) => {
            setUsers((list) => (list.some((u) => u.email === saved.email) ? list.map((u) => (u.email === saved.email ? saved : u)) : [...list, saved]));
            setOpen(false);
        },
    });

    const columns: DataColumn<Row>[] = [
        {
            id: "person",
            label: "Person",
            isRowHeader: true,
            sortValue: (u) => u.email,
            render: (u) => (
                <div className="flex items-center gap-3">
                    <Avatar size="md" initials={initials(u.name ?? u.email)} />
                    <div className="min-w-0">
                        <p className="font-medium text-primary">
                            {u.name ?? u.email.split("@")[0]}
                            {u.email === user.email && <span className="ml-1.5 text-xs font-normal text-tertiary">(you)</span>}
                        </p>
                        <p className="text-tertiary">{u.email}</p>
                    </div>
                </div>
            ),
        },
        {
            id: "role",
            label: "Role",
            sortValue: (u) => ROLES.indexOf(u.role),
            render: (u) => (
                <div className="flex flex-wrap items-center gap-2">
                    <Badge size="sm" type="pill-color" color={u.role === "owner" ? "brand" : "gray"}>
                        {ROLE_LABELS[u.role].label}
                    </Badge>
                    {u.fromConfig && (
                        <Badge size="sm" type="modern" color="gray">
                            Configured
                        </Badge>
                    )}
                </div>
            ),
        },
        {
            id: "status",
            label: "Status",
            sortValue: (u) => (u.active ? 0 : 1),
            render: (u) => (
                <BadgeWithDot size="sm" color={u.active ? "success" : "gray"}>
                    {u.active ? "Active" : "No access"}
                </BadgeWithDot>
            ),
            className: "max-md:hidden",
        },
        {
            id: "seen",
            label: "Last seen",
            sortValue: (u) => u.lastSeenAt,
            render: (u) => (u.lastSeenAt ? <Timestamp iso={u.lastSeenAt} relative /> : "Never"),
            className: "max-lg:hidden",
        },
    ];

    return (
        <div className="flex flex-col gap-6">
            <Notice color="brand" title="Access needs two things">
                Cloudflare Access decides who can sign in (by email). The role here decides what they can do once inside. Someone needs both: add them to the
                Access policy and give them a role here. Owners listed in PORTAL_OWNER_EMAILS can't be changed from the portal.
            </Notice>
            <DataTable
                title="People"
                rows={users.map((u) => ({ ...u, id: u.email }))}
                columns={columns}
                onRowAction={(row) => !row.fromConfig && row.email !== user.email && openDialog(row)}
                actions={
                    <Button size="sm" iconLeading={UserPlus01} onClick={() => openDialog(null)}>
                        Add person
                    </Button>
                }
                emptyState={<Empty icon={ShieldTick} title="No one yet" description="Owners appear here once PORTAL_OWNER_EMAILS is set." />}
            />
            <section aria-labelledby="roles-heading" className="flex flex-col gap-3">
                <h3 id="roles-heading" className="text-sm font-semibold text-secondary">
                    What each role can do
                </h3>
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {ROLES.map((role) => (
                        <div key={role} className="rounded-xl p-4 ring-1 ring-secondary">
                            <dt className="text-sm font-semibold text-primary">{ROLE_LABELS[role].label}</dt>
                            <dd className="mt-1 text-sm text-tertiary">{ROLE_LABELS[role].description}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <PortalDialog
                isOpen={open}
                onOpenChange={setOpen}
                title={editing ? `Access for ${editing.email}` : "Add a person"}
                description="Use the exact email address they sign in to Cloudflare Access with."
                icon={editing ? ShieldTick : Plus}
                onSubmit={save.submit}
                footer={
                    <>
                        {editing && (
                            <Button color="tertiary-destructive" size="lg" onClick={() => setRemoving(editing)} className="sm:mr-auto">
                                Remove
                            </Button>
                        )}
                        <Button color="secondary" size="lg" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="lg" isLoading={save.busy} showTextWhileLoading>
                            Save
                        </Button>
                    </>
                }
            >
                <FormError message={save.error && !save.fieldError("email") ? save.error.message : null} />
                <Input
                    label="Email"
                    type="email"
                    isRequired
                    isDisabled={!!editing}
                    value={draft.email}
                    onChange={(v) => setDraft({ ...draft, email: v })}
                    isInvalid={!!save.fieldError("email")}
                    hint={save.fieldError("email")}
                />
                <Input label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                <Select
                    label="Role"
                    items={ROLES.filter((r) => r !== "owner").map((r) => ({ id: r, label: ROLE_LABELS[r].label, supportingText: ROLE_LABELS[r].description }))}
                    value={draft.role}
                    onChange={(v) => setDraft({ ...draft, role: v as Role })}
                    hint={ROLE_LABELS[draft.role].description}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Toggle
                    label="Active"
                    hint="Turn off to suspend access without deleting the record."
                    isSelected={draft.active}
                    onChange={(v) => setDraft({ ...draft, active: v })}
                />
            </PortalDialog>

            <ConfirmDialog
                isOpen={!!removing}
                onOpenChange={(o) => !o && setRemoving(null)}
                title={`Remove ${removing?.email}?`}
                description="They lose access to the portal immediately, even if Cloudflare Access still lets them sign in."
                confirmLabel="Remove"
                destructive
                onConfirm={async () => {
                    if (!removing) return;
                    try {
                        await api("DELETE", `/api/portal/users/${encodeURIComponent(removing.email)}`);
                        setUsers((list) => list.filter((u) => u.email !== removing.email));
                        setOpen(false);
                        toast.success("Access removed");
                    } catch (e) {
                        toast.error("Couldn't remove", errorMessage(e));
                    }
                }}
            />
        </div>
    );
};
