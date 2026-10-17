// Knowledge home: capture, then pick up where you left off. Deliberately plain: recent work and the
// Inbox first, counts second.
import { ArrowRight, BookOpen01, Inbox01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { type KnowledgeObjectSummary, type KnowledgeType, roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { QuickCapture } from "../quick-capture";
import { TYPE_ICON_COMPONENTS, TypeIconFor, objectHref, spaceHref, titleOf } from "../shared";

const ObjectRows = ({ objects, types }: { objects: KnowledgeObjectSummary[]; types: KnowledgeType[] }) => (
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

const Card = ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
    // Clipped: the empty state's decorative pattern is wider than a narrow card.
    <section className="flex flex-col overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
        <div className="flex items-center justify-between gap-3 border-b border-secondary px-4 py-4 sm:px-5">
            <h2 className="text-md font-semibold text-primary">{title}</h2>
            {action}
        </div>
        {children}
    </section>
);

export const KnowledgeHomePage = ({ data }: { data: PageData<"knowledge-home"> }) => {
    const { space, spaces, types, counts } = data;
    const { user } = usePortal();
    const name = user.name ?? user.email.split("@")[0];
    const canEdit = roleAtLeast(space.role, "editor");

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
            />

            {canEdit && <QuickCapture space={space} />}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
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
                        <div className="px-6 py-12">
                            <Empty
                                icon={BookOpen01}
                                title="Nothing here yet"
                                description="Capture something above, or use New to create a page, person, project or meeting."
                                size="sm"
                            />
                        </div>
                    )}
                </Card>

                <div className="flex flex-col gap-6">
                    <Card
                        title={`Inbox${counts.inbox ? ` (${counts.inbox})` : ""}`}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={spaceHref("/portal/knowledge/inbox", space)}>
                                Process
                            </Button>
                        }
                    >
                        {data.inbox.length ? (
                            <ObjectRows objects={data.inbox} types={types} />
                        ) : (
                            <div className="px-6 py-8">
                                <Empty icon={Inbox01} title="Inbox zero" description="Everything you've captured has been sorted." size="sm" />
                            </div>
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
