// Planning hours, opened from Customise Today: when the person is available on each weekday, the
// buffer kept after every event, and whether days off count too. Today's capacity and free time are
// worked out from these; events, leave, public holidays and non-working days are always taken out.
import { useState } from "react";
import { Settings01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PlanningHours } from "@/shared/today/availability";
import { hoursLabel } from "@/shared/today/engine";
import { todayApi } from "./today-api";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const PlanningHoursDialog = ({
    isOpen,
    onOpenChange,
    initial,
    version,
    onSaved,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    initial: PlanningHours;
    version: number;
    onSaved: (hours: PlanningHours, version: number) => void;
}) => {
    const toast = useToast();
    const [draft, setDraft] = useState(initial);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            const result = await todayApi.savePlanningHours(draft, version);
            onSaved(result.preferences, result.version);
            toast.success("Planning hours saved");
            onOpenChange(false);
        } catch (error) {
            toast.error("Couldn't save the planning hours", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Planning hours"
            description="When you're available for appointments. Events, leave, public holidays and non-working days are always taken out."
            icon={Settings01}
            size="lg"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium text-secondary">Planning hours</legend>
                {WEEKDAYS.map((day, i) => {
                    const hours = draft.workingHours[i];
                    const set = (value: PlanningHours["workingHours"][number]) =>
                        setDraft({ ...draft, workingHours: draft.workingHours.map((h, j) => (j === i ? value : h)) });
                    return (
                        <div key={day} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_1fr]">
                            <Toggle size="sm" label={day} isSelected={!!hours} onChange={(on) => set(on ? { start: "09:00", end: "17:00" } : null)} />
                            {hours && (
                                <>
                                    <Input
                                        size="sm"
                                        type="time"
                                        aria-label={`${day} from`}
                                        value={hours.start}
                                        onChange={(v) => v && set({ ...hours, start: v })}
                                    />
                                    <Input
                                        size="sm"
                                        type="time"
                                        aria-label={`${day} until`}
                                        value={hours.end}
                                        onChange={(v) => v && set({ ...hours, end: v })}
                                    />
                                </>
                            )}
                        </div>
                    );
                })}
            </fieldset>
            <Select
                label="Buffer after events"
                value={String(draft.bufferMinutes)}
                onChange={(k) => k && setDraft({ ...draft, bufferMinutes: Number(k) })}
                items={[0, 5, 10, 15, 30].map((m) => ({ id: String(m), label: m ? hoursLabel(m) : "None" }))}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            <Toggle
                label="Count days off too"
                hint="Weekends, public holidays, non-working days and leave. Days without hours of their own use 9 to 5."
                isSelected={draft.planOnDaysOff}
                onChange={(v) => setDraft({ ...draft, planOnDaysOff: v })}
            />
        </PortalDialog>
    );
};
