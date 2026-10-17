// Capture something without deciding where it goes. "Inbox" makes a new object (the first line is
// the title, the rest the text) to sort out later; "Today" adds it to the end of today's daily
// note, stamped with the time. Enter saves; Shift+Enter starts a new line. Both go through the
// ordinary object APIs: there is no separate capture store.
import { useState } from "react";
import { CalendarDate, Inbox01, Lightning01 } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { type KnowledgeObjectSummary, type KnowledgeSpace, roleAtLeast } from "@/shared/knowledge/types";
import { cx } from "@/utils/cx";
import { documentFromText, knowledgeApi } from "./shared";

export type CaptureTarget = "inbox" | "today";

interface QuickCaptureProps {
    space: KnowledgeSpace;
    /** Offer a choice of space (only those the person can write in). */
    spaces?: KnowledgeSpace[];
    onCaptured?: (object: KnowledgeObjectSummary, target: CaptureTarget) => void;
    defaultTarget?: CaptureTarget;
    autoFocus?: boolean;
    /** Inside a dialog: no card around it. */
    bare?: boolean;
}

export const QuickCapture = ({ space, spaces, onCaptured, defaultTarget = "inbox", autoFocus, bare }: QuickCaptureProps) => {
    const toast = useToast();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [target, setTarget] = useState<CaptureTarget>(defaultTarget);
    const writable = (spaces ?? [space]).filter((s) => roleAtLeast(s.role, "editor"));
    const [spaceId, setSpaceId] = useState(writable.some((s) => s.id === space.id) ? space.id : (writable[0]?.id ?? space.id));

    const capture = async () => {
        const value = text.trim();
        if (!value || busy) return;
        setBusy(true);
        try {
            if (target === "today") {
                const note = await knowledgeApi.appendDaily(spaceId, value);
                onCaptured?.(note.object, target);
                toast.success("Added to today's note");
            } else {
                const [first, ...rest] = value.split(/\r?\n/);
                const created = await knowledgeApi.create(spaceId, {
                    title: first.slice(0, 300),
                    content: documentFromText(rest.join("\n").trim()),
                    inInbox: true,
                });
                onCaptured?.(created.object, target);
                toast.success("Captured to the Inbox");
            }
            setText("");
        } catch (e) {
            toast.error("Couldn't capture that", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className={cx("flex flex-col gap-3", !bare && "rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset")}
            onSubmit={(event) => {
                event.preventDefault();
                void capture();
            }}
        >
            <TextArea
                aria-label="Capture a thought, link or note"
                placeholder={target === "today" ? "Add to today's note…" : "Capture a thought, link or note…"}
                rows={bare ? 4 : 2}
                value={text}
                onChange={setText}
                autoFocus={autoFocus}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void capture();
                    }
                }}
            />
            <div className="flex flex-wrap items-center gap-3">
                <ButtonGroup
                    size="sm"
                    aria-label="Where it goes"
                    selectedKeys={new Set([target])}
                    disallowEmptySelection
                    onSelectionChange={(keys) => {
                        const next = [...keys][0];
                        if (next === "inbox" || next === "today") setTarget(next);
                    }}
                >
                    <ButtonGroupItem id="inbox" iconLeading={Inbox01}>
                        Inbox
                    </ButtonGroupItem>
                    <ButtonGroupItem id="today" iconLeading={CalendarDate}>
                        Today's note
                    </ButtonGroupItem>
                </ButtonGroup>
                {writable.length > 1 && (
                    <Select
                        aria-label="Space"
                        size="sm"
                        className="w-full sm:w-44"
                        value={spaceId}
                        onChange={(key) => key && setSpaceId(String(key))}
                        items={writable.map((s) => ({ id: s.id, label: s.name }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                <Button type="submit" size="sm" iconLeading={Lightning01} isLoading={busy} isDisabled={!text.trim()} className="ml-auto">
                    Capture
                </Button>
            </div>
        </form>
    );
};
