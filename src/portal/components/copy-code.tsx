import { Copy01 } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { useToast } from "@/portal/components/toast";

/** An RSVP code or signed invitation URL with a copy button. */
export const CopyCode = ({ code, label = "Copy code" }: { code: string; label?: string }) => {
    const toast = useToast();
    return (
        <span className="inline-flex items-center gap-1">
            <code className="max-w-80 truncate rounded-md bg-secondary px-1.5 py-0.5 font-mono text-sm text-secondary">{code}</code>
            <ButtonUtility
                size="xs"
                color="tertiary"
                icon={Copy01}
                tooltip={label}
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(code);
                        toast.success(label === "Copy code" ? "Code copied" : "Invitation link copied");
                    } catch {
                        toast.error("Couldn't copy", "Select the code and copy it by hand.");
                    }
                }}
            />
        </span>
    );
};
