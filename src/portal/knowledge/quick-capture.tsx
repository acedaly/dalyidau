// Capture something without deciding where it goes: it lands in the Inbox. The first line becomes
// the title and the rest the text. Enter saves; Shift+Enter starts a new line.
import { useState } from "react";
import { Lightning01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { TextArea } from "@/components/base/textarea/textarea";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { KnowledgeObjectSummary, KnowledgeSpace } from "@/shared/knowledge/types";
import { documentFromText, knowledgeApi } from "./shared";

export const QuickCapture = ({ space, onCaptured }: { space: KnowledgeSpace; onCaptured?: (object: KnowledgeObjectSummary) => void }) => {
    const toast = useToast();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);

    const capture = async () => {
        const value = text.trim();
        if (!value || busy) return;
        const [first, ...rest] = value.split(/\r?\n/);
        setBusy(true);
        try {
            const created = await knowledgeApi.create(space.id, {
                title: first.slice(0, 300),
                content: documentFromText(rest.join("\n").trim()),
                inInbox: true,
            });
            setText("");
            onCaptured?.(created.object);
            toast.success("Captured to the Inbox");
        } catch (e) {
            toast.error("Couldn't capture that", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset sm:flex-row sm:items-start"
            onSubmit={(event) => {
                event.preventDefault();
                void capture();
            }}
        >
            <TextArea
                aria-label="Capture a thought, link or note"
                placeholder="Capture a thought, link or note…"
                rows={2}
                value={text}
                onChange={setText}
                className="flex-1"
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void capture();
                    }
                }}
            />
            <Button type="submit" size="md" iconLeading={Lightning01} isLoading={busy} isDisabled={!text.trim()} className="sm:mt-0.5">
                Capture
            </Button>
        </form>
    );
};
