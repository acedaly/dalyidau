// Keyboard-first ways in, on every Knowledge page: ⌘K / Ctrl+K opens quick find (Untitled UI's
// command menu, fed by the space's title lookup), and "c" opens quick capture. Neither shortcut
// fires while typing in a field or in the editor, where ⌘K keeps its usual meaning (insert a link).
import { useEffect, useRef, useState } from "react";
import { CalendarDate, Inbox01, Lightning01, Plus, SearchLg } from "@untitledui/icons";
import { Heading as AriaHeading } from "react-aria-components";
import { useHotkeys } from "react-hotkeys-hook";
import type { CommandDropdownMenuItemProps } from "@/components/application/command-menus/base-components/command-menu-item";
import { CommandMenu } from "@/components/application/command-menus/command-menu";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import { PortalDialog } from "@/portal/components/dialog";
import { type KnowledgeSpace, type KnowledgeType, roleAtLeast } from "@/shared/knowledge/types";
import { QuickCapture } from "./quick-capture";
import { TYPE_ICON_COMPONENTS, dailyHref, knowledgeApi, objectHref, spaceHref, titleOf } from "./shared";

interface KnowledgeCommandsProps {
    space: KnowledgeSpace;
    spaces: KnowledgeSpace[];
    types: KnowledgeType[];
    onNewPage: () => void;
}

type Action = { id: string; href?: string; run?: () => void };

export const KnowledgeCommands = ({ space, spaces, types, onNewPage }: KnowledgeCommandsProps) => {
    const [findOpen, setFindOpen] = useState(false);
    const [captureOpen, setCaptureOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<{ id: string; title: string; typeId: string }[]>([]);
    const latest = useRef(0);
    const canEdit = roleAtLeast(space.role, "editor");

    useHotkeys(["meta+k", "ctrl+k"], (event) => {
        event.preventDefault();
        setFindOpen(true);
    });
    useHotkeys("c", (event) => {
        if (!canEdit) return;
        event.preventDefault();
        setCaptureOpen(true);
    });

    useEffect(() => {
        if (!findOpen) return;
        const request = ++latest.current;
        const timer = window.setTimeout(() => {
            knowledgeApi
                .lookup(space.id, query)
                .then(({ results: found }) => request === latest.current && setResults(found))
                .catch(() => undefined);
        }, 120);
        return () => window.clearTimeout(timer);
    }, [findOpen, query, space.id]);

    const actions: Record<string, Action> = {
        today: { id: "today", href: dailyHref(space) },
        capture: { id: "capture", run: () => setCaptureOpen(true) },
        new: { id: "new", run: onNewPage },
        search: { id: "search", href: spaceHref("/portal/knowledge/search", space, { q: query.trim() || null }) },
        inbox: { id: "inbox", href: spaceHref("/portal/knowledge/inbox", space) },
    };

    const objectItems: CommandDropdownMenuItemProps[] = results.map((r) => {
        const type = types.find((t) => t.id === r.typeId);
        return { id: `o:${r.id}`, type: "icon", icon: TYPE_ICON_COMPONENTS[type?.icon ?? "file"], label: titleOf(r.title), description: type?.name };
    });
    const actionItems: CommandDropdownMenuItemProps[] = [
        ...(query.trim() ? [{ id: "search", type: "icon" as const, icon: SearchLg, label: `Search for “${query.trim()}”` }] : []),
        { id: "today", type: "icon", icon: CalendarDate, label: "Today's note" },
        ...(canEdit
            ? [
                  { id: "capture", type: "icon" as const, icon: Lightning01, label: "Quick capture", shortcutKeys: ["c"] },
                  { id: "new", type: "icon" as const, icon: Plus, label: "New page" },
              ]
            : []),
        { id: "inbox", type: "icon", icon: Inbox01, label: "Inbox" },
    ];
    const groups = [
        ...(objectItems.length ? [{ id: "objects", title: query.trim() ? "Matching titles" : "Recently edited", items: objectItems }] : []),
        { id: "actions", title: "Go to", items: actionItems },
    ];

    const choose = (key: string) => {
        setFindOpen(false);
        setQuery("");
        if (key.startsWith("o:")) return window.location.assign(objectHref(key.slice(2)));
        const action = actions[key];
        if (action?.href) window.location.assign(action.href);
        else action?.run?.();
    };

    return (
        <>
            <Button size="sm" color="secondary" iconLeading={SearchLg} onClick={() => setFindOpen(true)} className="max-sm:hidden" aria-keyshortcuts="Meta+K">
                Find
                <kbd className="ml-1 rounded-sm px-1 text-xs font-medium text-quaternary ring-1 ring-secondary ring-inset">⌘K</kbd>
            </Button>
            {canEdit && (
                <Button size="sm" color="secondary" iconLeading={Lightning01} onClick={() => setCaptureOpen(true)} aria-keyshortcuts="C">
                    Capture
                </Button>
            )}

            <CommandMenu
                isOpen={findOpen}
                onOpenChange={(open) => {
                    setFindOpen(open);
                    if (!open) setQuery("");
                }}
                items={groups}
                inputValue={query}
                onInputChange={setQuery}
                filter={false}
                shortcut={null}
                placeholder="Find by title, or choose an action"
                dialogClassName="w-full sm:w-160"
                onSelectionChange={(keys) => {
                    const key = keys === "all" ? undefined : [...keys][0];
                    if (key !== undefined) choose(String(key));
                }}
                emptyState={<Empty icon={SearchLg} title="Nothing matches" description="Press Enter on “Search” to look inside the text too." size="sm" />}
            >
                <AriaHeading slot="title" className="sr-only">
                    Quick find
                </AriaHeading>
                <CommandMenu.Group>
                    <CommandMenu.List>
                        {(group) => <CommandMenu.Section {...group}>{(item) => <CommandMenu.Item key={item.id} {...item} />}</CommandMenu.Section>}
                    </CommandMenu.List>
                </CommandMenu.Group>
            </CommandMenu>

            <PortalDialog
                isOpen={captureOpen}
                onOpenChange={setCaptureOpen}
                title="Quick capture"
                icon={Lightning01}
                description="Put it in the Inbox to sort out later, or add it to today's note. Press Enter to save, Shift+Enter for a new line."
            >
                <QuickCapture space={space} spaces={spaces} bare autoFocus onCaptured={() => setCaptureOpen(false)} />
            </PortalDialog>
        </>
    );
};
