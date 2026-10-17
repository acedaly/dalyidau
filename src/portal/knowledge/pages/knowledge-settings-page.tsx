// A space's settings, members and audit trail, and creating shared spaces. Personal spaces are
// never shared; a shared space can include anyone who can open Knowledge in the portal.
import { useState } from "react";
import { Plus, ShieldTick, Users01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { type KnowledgeMember, type KnowledgeSpace, SPACE_ROLES, SPACE_ROLE_LABELS, type SpaceRole } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { spaceHref } from "../shared";

const ROLE_ITEMS = SPACE_ROLES.map((id) => ({ id, label: SPACE_ROLE_LABELS[id].label, supportingText: SPACE_ROLE_LABELS[id].description }));

const Panel = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
    <section className="grid gap-4 border-t border-secondary pt-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-8">
        <div>
            <h2 className="text-sm font-semibold text-primary">{title}</h2>
            {description && <p className="text-sm text-tertiary">{description}</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
);

export const KnowledgeSettingsPage = ({ data }: { data: PageData<"knowledge-settings"> }) => {
    const { space, spaces, types } = data;
    const { user } = usePortal();
    const toast = useToast();
    const isOwner = space.role === "owner";
    const [name, setName] = useState(space.name);
    const [timeZone, setTimeZone] = useState(space.timeZone);
    const [members, setMembers] = useState(data.members);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<SpaceRole>("editor");
    const [createOpen, setCreateOpen] = useState(false);
    const [newName, setNewName] = useState("");
    const base = `/api/portal/knowledge/spaces/${space.id}`;

    const saveSpace = async () => {
        try {
            await api("PATCH", base, { name, timeZone });
            toast.success("Space saved");
        } catch (e) {
            toast.error("Couldn't save", errorMessage(e));
        }
    };

    const addMember = async () => {
        try {
            const result = await api<{ members: KnowledgeMember[] }>("POST", `${base}/members`, { email, role });
            setMembers(result.members);
            setEmail("");
        } catch (e) {
            toast.error("Couldn't add them", errorMessage(e));
        }
    };

    const changeRole = async (member: KnowledgeMember, next: SpaceRole) => {
        try {
            const result = await api<{ members: KnowledgeMember[] }>("PATCH", `${base}/members/${encodeURIComponent(member.email)}`, { role: next });
            setMembers(result.members);
        } catch (e) {
            toast.error("Couldn't change their role", errorMessage(e));
        }
    };

    const removeMember = async (member: KnowledgeMember) => {
        try {
            await api("DELETE", `${base}/members/${encodeURIComponent(member.email)}`);
            if (member.email === user.email) window.location.assign("/portal/knowledge");
            else setMembers(members.filter((m) => m.email !== member.email));
        } catch (e) {
            toast.error("Couldn't remove them", errorMessage(e));
        }
    };

    const createSpace = async () => {
        try {
            const { space: created } = await api<{ space: KnowledgeSpace }>("POST", "/api/portal/knowledge/spaces", { name: newName });
            window.location.assign(spaceHref("/portal/knowledge/settings", created));
        } catch (e) {
            toast.error("Couldn't create the space", errorMessage(e));
        }
    };

    return (
        <>
            <KnowledgeHeader
                title="Space settings"
                description={
                    space.kind === "personal"
                        ? "Your personal space. Only you can see it."
                        : `Shared space · you're ${space.role === "owner" ? "an" : "a"} ${space.role}`
                }
                space={space}
                spaces={spaces}
                types={types}
                crumb="Space settings"
                actions={
                    <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setCreateOpen(true)}>
                        New shared space
                    </Button>
                }
            />

            <div className="flex flex-col gap-6">
                <Panel title="Space" description="The name shown in the space switcher, and the time zone used for dates.">
                    <Input label="Name" value={name} onChange={setName} isDisabled={!isOwner} />
                    <Input label="Time zone" hint="An IANA time zone, e.g. Australia/Sydney" value={timeZone} onChange={setTimeZone} isDisabled={!isOwner} />
                    {isOwner && (
                        <div>
                            <Button size="sm" onClick={saveSpace}>
                                Save
                            </Button>
                        </div>
                    )}
                </Panel>

                <Panel title="Members" description="Who can see this space and what they can do. Being a portal owner gives no access to anyone's space.">
                    {space.kind === "personal" ? (
                        <Notice title="Personal spaces aren't shared">Create a shared space to work on knowledge with someone else.</Notice>
                    ) : (
                        <>
                            <ul className="flex flex-col divide-y divide-secondary rounded-xl ring-1 ring-secondary ring-inset">
                                {members.map((member) => (
                                    <li key={member.email} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium text-primary">{member.name ?? member.email}</p>
                                            <p className="truncate text-sm text-tertiary">{member.email}</p>
                                        </div>
                                        {isOwner ? (
                                            <div className="flex items-center gap-2">
                                                <Select
                                                    aria-label={`Role for ${member.email}`}
                                                    size="sm"
                                                    className="w-36"
                                                    value={member.role}
                                                    onChange={(key) => changeRole(member, key as SpaceRole)}
                                                    items={ROLE_ITEMS}
                                                >
                                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                                </Select>
                                                <Button size="sm" color="tertiary-destructive" onClick={() => removeMember(member)}>
                                                    Remove
                                                </Button>
                                            </div>
                                        ) : (
                                            <Badge size="sm" color="gray">
                                                {SPACE_ROLE_LABELS[member.role].label}
                                            </Badge>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {isOwner && (
                                <form
                                    className="flex flex-col gap-3 sm:flex-row sm:items-end"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void addMember();
                                    }}
                                >
                                    <Input
                                        label="Add someone"
                                        type="email"
                                        placeholder="name@example.com"
                                        value={email}
                                        onChange={setEmail}
                                        className="flex-1"
                                        hint="They need to be a portal owner or admin."
                                    />
                                    <Select label="Role" className="sm:w-40" value={role} onChange={(key) => setRole(key as SpaceRole)} items={ROLE_ITEMS}>
                                        {(item) => (
                                            <Select.Item id={item.id} supportingText={item.supportingText}>
                                                {item.label}
                                            </Select.Item>
                                        )}
                                    </Select>
                                    <Button type="submit" iconLeading={Users01} isDisabled={!email.includes("@")} className="sm:mb-6">
                                        Add
                                    </Button>
                                </form>
                            )}
                        </>
                    )}
                </Panel>

                {data.audit && (
                    <Panel title="Audit trail" description="What was changed, by whom and when. It names records by id and never includes what they say.">
                        <ul className="flex flex-col divide-y divide-secondary rounded-xl ring-1 ring-secondary ring-inset">
                            {data.audit.map((entry) => (
                                <li key={entry.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-4">
                                    <ShieldTick aria-hidden="true" className="hidden size-4 shrink-0 text-fg-quaternary sm:block" />
                                    <span className="min-w-0 flex-1">
                                        <span className="font-medium text-secondary">{entry.summary}</span>
                                        {entry.entityType === "object" && entry.entityId && (
                                            <a href={`/portal/knowledge/o/${entry.entityId}`} className="ml-2 font-mono text-xs text-tertiary hover:underline">
                                                {entry.entityId}
                                            </a>
                                        )}
                                    </span>
                                    <span className="truncate text-tertiary">{entry.actor}</span>
                                    <Timestamp iso={entry.at} relative className="shrink-0 text-tertiary" />
                                </li>
                            ))}
                        </ul>
                    </Panel>
                )}
            </div>

            <PortalDialog
                isOpen={createOpen}
                onOpenChange={setCreateOpen}
                title="New shared space"
                icon={Users01}
                description="You'll be its owner. It starts with the standard object types, and you can add members afterwards."
                onSubmit={() => void createSpace()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setCreateOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isDisabled={!newName.trim()}>
                            Create space
                        </Button>
                    </>
                }
            >
                <Input label="Name" value={newName} onChange={setNewName} placeholder="e.g. Household" />
            </PortalDialog>
        </>
    );
};
