// Knowledge home: capture, today's note, then what you're working on. Plain lists rather than
// decorative cards: pinned and recent work on the left, the Inbox, favourites, collections and
// types on the right. A new, empty space gets a short explanation instead of empty boxes.
import type { ReactNode } from "react";
import { ArrowRight, BookOpen01, CalendarDate, FolderClosed, Inbox01, Lightning01, Link03, Pin02, Star01, Users01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { formatDailyTitle } from "@/shared/knowledge/dates";
import { type KnowledgeType, type ObjectRef, roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { QuickCapture } from "../quick-capture";
import { TYPE_ICON_COMPONENTS, TypeIconFor, collectionHref, dailyHref, objectHref, spaceHref, titleOf } from "../shared";

type Row = Pick<ObjectRef, "id" | "title" | "typeId" | "updatedAt"> & { excerpt?: string };

export const ObjectRows = ({ objects, types }: { objects: Row[]; types: KnowledgeType[] }) => (
    <ul className="divide-y divide-secondary">
        {objects.map((o) => (
            <li key={o.id}>
                <a href={objectHref(o.id)} className="flex items-start gap-3 px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5">
                    <TypeIconFor type={types.find((t) => t.id === o.typeId)} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-primary">{titleOf(o.title)}</span>
                        {o.excerpt && <span className="line-clamp-1 text-sm text-tertiary">{o.excerpt}</span>}
                    </span>
                    <Timestamp iso={o.updatedAt} relative className="shrink-0 text-xs text-tertiary" />
                </a>
            </li>
        ))}
    </ul>
);

export const Card = ({ title, icon: Icon, action, children }: { title: string; icon?: typeof Inbox01; action?: ReactNode; children: ReactNode }) => (
    // Clipped: the empty state's decorative pattern is wider than a narrow card.
    <section className="flex flex-col overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
        <div className="flex items-center justify-between gap-3 border-b border-secondary px-4 py-3.5 sm:px-5">
            <h2 className="flex items-center gap-2 text-md font-semibold text-primary">
                {Icon && <Icon aria-hidden="true" className="size-4 text-fg-quaternary" />}
                {title}
            </h2>
            {action}
        </div>
        {children}
    </section>
);

const GettingStarted = ({ space }: { space: PageData<"knowledge-home">["space"] }) => {
    const points: { icon: typeof Inbox01; title: string; text: string }[] = [
        { icon: BookOpen01, title: "Everything is an object", text: "A page, a person, a project or a meeting. Each has a type, and types have properties you can change." },
        { icon: Lightning01, title: "Capture first, sort later", text: "Press C anywhere to jot something into the Inbox or today's note." },
        { icon: Link03, title: "Link as you write", text: "Type [[ to link to another object. Links show up as backlinks on the other side." },
        { icon: FolderClosed, title: "Collections group things", text: "Put objects in as many collections as you like. Nothing is copied." },
        {
            icon: Users01,
            title: space.kind === "personal" ? "This space is yours alone" : "This space is shared",
            text: space.kind === "personal" ? "Nobody else can see it. Create a shared space in Settings to work with someone." : "Everyone in it can see what's here.",
        },
    ];
    return (
        <section aria-labelledby="getting-started" className="rounded-xl bg-secondary_subtle p-5 ring-1 ring-secondary ring-inset sm:p-6">
            <h2 id="getting-started" className="text-md font-semibold text-primary">
                Getting started
            </h2>
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {points.map(({ icon: Icon, title, text }) => (
                    <li key={title} className="flex gap-3">
                        <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-brand-secondary" />
                        <span>
                            <span className="block text-sm font-semibold text-secondary">{title}</span>
                            <span className="block text-sm text-tertiary">{text}</span>
                        </span>
                    </li>
                ))}
            </ul>
            <div className="mt-5 flex flex-wrap gap-3">
                <Button size="sm" iconLeading={CalendarDate} href={dailyHref(space)}>
                    Write today's note
                </Button>
                <Button size="sm" color="secondary" iconLeading={FolderClosed} href={spaceHref("/portal/knowledge/collections", space)}>
                    Make a collection
                </Button>
            </div>
        </section>
    );
};

export const KnowledgeHomePage = ({ data }: { data: PageData<"knowledge-home"> }) => {
    const { space, spaces, types, counts, nav } = data;
    const { user } = usePortal();
    const name = user.name ?? user.email.split("@")[0];
    const canEdit = roleAtLeast(space.role, "editor");
    const isEmpty = counts.active + counts.archived === 0;

    return (
        <>
            <KnowledgeHeader
                title={space.kind === "personal" ? "Knowledge" : space.name}
                description={
                    space.kind === "personal"
                        ? `Welcome back, ${name}. Only you can see this space.`
                        : `A shared space. You're ${space.role === "owner" ? "an" : "a"} ${space.role}.`
                }
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
            />

            {isEmpty && canEdit && <GettingStarted space={space} />}
            {canEdit && <QuickCapture space={space} spaces={spaces} />}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-6">
                    <Card
                        title="Today"
                        icon={CalendarDate}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={dailyHref(space)}>
                                {data.todayNote ? "Open" : "Start writing"}
                            </Button>
                        }
                    >
                        <a href={dailyHref(space)} className="block px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5">
                            <span className="block text-sm font-medium text-primary">{formatDailyTitle(nav.today)}</span>
                            <span className="line-clamp-2 text-sm text-tertiary">
                                {data.todayNote?.excerpt || "Nothing yet today. A daily note is made the moment you write in it."}
                            </span>
                        </a>
                    </Card>

                    {data.pinned.length > 0 && (
                        <Card title="Pinned" icon={Pin02}>
                            <ObjectRows objects={data.pinned} types={types} />
                        </Card>
                    )}

                    <Card
                        title="Recently edited"
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={spaceHref("/portal/knowledge/all", space)}>
                                All knowledge ({counts.active})
                            </Button>
                        }
                    >
                        {data.recent.length ? (
                            <ObjectRows objects={data.recent} types={types} />
                        ) : (
                            <div className="px-6 py-10">
                                <Empty
                                    icon={BookOpen01}
                                    title="Nothing here yet"
                                    description="Capture something above, or use New to create a page, person, project or meeting."
                                    size="sm"
                                />
                            </div>
                        )}
                    </Card>
                </div>

                <div className="flex min-w-0 flex-col gap-6">
                    <Card
                        title={`Inbox${counts.inbox ? ` (${counts.inbox})` : ""}`}
                        icon={Inbox01}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={spaceHref("/portal/knowledge/inbox", space)}>
                                Process
                            </Button>
                        }
                    >
                        {data.inbox.length ? (
                            <ObjectRows objects={data.inbox} types={types} />
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Inbox zero: everything you've captured has been sorted.</p>
                        )}
                    </Card>

                    <Card
                        title="Favourites"
                        icon={Star01}
                        action={
                            nav.favourites.length > 0 && (
                                <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={spaceHref("/portal/knowledge/favourites", space)}>
                                    All
                                </Button>
                            )
                        }
                    >
                        {nav.favourites.length ? (
                            <ObjectRows objects={nav.favourites.slice(0, 6)} types={types} />
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Star an object to keep it here. Favourites are yours only.</p>
                        )}
                    </Card>

                    <Card
                        title="Collections"
                        icon={FolderClosed}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={spaceHref("/portal/knowledge/collections", space)}>
                                All
                            </Button>
                        }
                    >
                        {data.collections.length ? (
                            <ul className="divide-y divide-secondary">
                                {data.collections.map((c) => (
                                    <li key={c.id}>
                                        <a
                                            href={collectionHref(c.id)}
                                            className="flex items-center gap-3 px-4 py-2.5 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5"
                                        >
                                            <FolderClosed aria-hidden="true" className="size-4 text-fg-quaternary" />
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{c.name}</span>
                                            <span className="text-xs text-tertiary tabular-nums">{c.itemCount}</span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Group related objects into collections without copying them.</p>
                        )}
                    </Card>

                    <Card title="Types">
                        <ul className="grid grid-cols-2 gap-2 p-4 sm:p-5">
                            {types
                                .filter((t) => !t.archived)
                                .map((type) => {
                                    const Icon = TYPE_ICON_COMPONENTS[type.icon];
                                    return (
                                        <li key={type.id}>
                                            <a
                                                href={spaceHref("/portal/knowledge/all", space, { type: type.id })}
                                                className="flex items-center gap-2.5 rounded-lg px-3 py-2 ring-1 ring-secondary transition duration-100 ease-linear ring-inset hover:bg-primary_hover"
                                            >
                                                <Icon aria-hidden="true" className="size-4 text-fg-quaternary" />
                                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{type.name}</span>
                                                <span className="text-xs text-tertiary tabular-nums">{type.objectCount}</span>
                                            </a>
                                        </li>
                                    );
                                })}
                        </ul>
                        <p className="border-t border-secondary px-4 py-3 text-xs text-tertiary sm:px-5">
                            {pluralise(counts.archived, "archived object")} · {pluralise(counts.trashed, "object")} in the trash
                        </p>
                    </Card>
                </div>
            </div>
        </>
    );
};
