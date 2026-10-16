// Personal notes for thank-you cards, one per household ({{personal_note}}). Households that came are
// listed first. Each note saves on its own; an empty note removes it.
import { useEffect, useState } from "react";
import { HeartHand } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";

interface Household {
    id: string;
    line: string;
    attending: number;
}

export const ThankYouNotesDialog = ({
    isOpen,
    onOpenChange,
    households,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    households: Household[];
}) => {
    const toast = useToast();
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [saved, setSaved] = useState<Record<string, string>>({});
    const [search, setSearch] = useState("");
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        api<{ notes: { householdId: string; note: string }[] }>("GET", "/api/portal/wedding/thank-you-notes")
            .then(({ notes: rows }) => {
                const map = Object.fromEntries(rows.map((r) => [r.householdId, r.note]));
                setNotes(map);
                setSaved(map);
            })
            .catch((e) => toast.error("Couldn't load the notes", errorMessage(e)));
    }, [isOpen, toast]);

    const save = async (id: string) => {
        setBusy(id);
        try {
            const result = await api<{ note: string | null }>("PUT", `/api/portal/wedding/thank-you-notes/${id}`, { note: notes[id] ?? "" });
            setSaved({ ...saved, [id]: result.note ?? "" });
            toast.success(result.note ? "Note saved" : "Note removed");
        } catch (e) {
            toast.error("Couldn't save the note", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    const sorted = [...households]
        .filter((h) => !search || h.line.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => Number(b.attending > 0) - Number(a.attending > 0) || a.line.localeCompare(b.line));
    const written = Object.values(saved).filter(Boolean).length;

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Personal thank-you notes"
            description={`A line just for each household, added to their card as {{personal_note}}. ${pluralise(written, "note")} written so far.`}
            icon={HeartHand}
            size="lg"
            footer={
                <Button color="secondary" size="lg" onClick={() => onOpenChange(false)}>
                    Done
                </Button>
            }
        >
            <Input aria-label="Find a household" placeholder="Find a household" value={search} onChange={setSearch} />
            <ul className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
                {sorted.map((h) => {
                    const changed = (notes[h.id] ?? "") !== (saved[h.id] ?? "");
                    return (
                        <li key={h.id} className="flex flex-col gap-2">
                            <TextArea
                                label={h.line}
                                rows={2}
                                hint={h.attending ? `${pluralise(h.attending, "guest")} came` : "Didn't attend"}
                                value={notes[h.id] ?? ""}
                                onChange={(v) => setNotes({ ...notes, [h.id]: v })}
                            />
                            {changed && (
                                <div>
                                    <Button size="sm" color="secondary" onClick={() => save(h.id)} isLoading={busy === h.id} showTextWhileLoading>
                                        Save note
                                    </Button>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </PortalDialog>
    );
};
