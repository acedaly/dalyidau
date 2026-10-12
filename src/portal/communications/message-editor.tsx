// Subject and body fields with a merge-field picker, shared by the template editor and the composer.
import { useRef } from "react";
import { BracketsEllipses } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { MERGE_FIELDS } from "@/shared/portal/merge-fields";
import { smsSegments } from "@/shared/portal/sms";

interface MessageEditorProps {
    subject: string;
    body: string;
    onChange: (next: { subject: string; body: string }) => void;
    fieldError: (field: string) => string | undefined;
    /** Text messages: the subject is only a title for the portal, and the body shows its SMS length. */
    channel?: "email" | "sms";
}

export const MessageEditor = ({ subject, body, onChange, fieldError, channel = "email" }: MessageEditorProps) => {
    const sms = channel === "sms" ? smsSegments(body) : null;
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    // The menu takes focus, so remember where the cursor was when the body lost it.
    const selection = useRef<[number, number] | null>(null);

    // Inserts at the last cursor position in the body, otherwise at the end.
    const insert = (key: string) => {
        const token = `{{${key}}}`;
        if (selection.current) {
            const [start, end] = selection.current;
            onChange({ subject, body: body.slice(0, start) + token + body.slice(end) });
            selection.current = [start + token.length, start + token.length];
        } else onChange({ subject, body: `${body}${body && !body.endsWith(" ") && !body.endsWith("\n") ? " " : ""}${token}` });
    };

    return (
        <div className="flex flex-col gap-4">
            <Input
                label={sms ? "Title" : "Subject"}
                isRequired
                value={subject}
                onChange={(v) => onChange({ subject: v, body })}
                isInvalid={!!fieldError("subject")}
                hint={fieldError("subject") ?? (sms ? "Only you see this; it names the text in your history." : undefined)}
            />
            <div className="flex flex-col gap-1.5">
                <TextArea
                    label="Message"
                    isRequired
                    rows={sms ? 6 : 12}
                    textAreaRef={bodyRef}
                    onBlur={() => {
                        const el = bodyRef.current;
                        if (el) selection.current = [el.selectionStart, el.selectionEnd];
                    }}
                    value={body}
                    onChange={(v) => onChange({ subject, body: v })}
                    isInvalid={!!fieldError("body")}
                    hint={
                        fieldError("body") ??
                        (sms
                            ? `${sms.length} characters · ${sms.segments} SMS part${sms.segments === 1 ? "" : "s"} per guest before merge fields${sms.encoding === "unicode" ? " · emoji or curly quotes make each part shorter" : ""}. Say who it's from, e.g. “Aidan & Amelia here”.`
                            : "Plain text. Merge fields like {{first_name}} are filled in for each guest.")
                    }
                />
                <div className="flex justify-end">
                    <Dropdown.Root>
                        <Button size="sm" color="secondary" iconLeading={BracketsEllipses}>
                            Insert merge field
                        </Button>
                        <Dropdown.Popover placement="bottom end" className="w-56">
                            <Dropdown.Menu onAction={(key) => insert(String(key))}>
                                {MERGE_FIELDS.map((f) => (
                                    <Dropdown.Item key={f.key} id={f.key} label={f.label} addon={`{{${f.key}}}`} />
                                ))}
                            </Dropdown.Menu>
                        </Dropdown.Popover>
                    </Dropdown.Root>
                </div>
            </div>
        </div>
    );
};
