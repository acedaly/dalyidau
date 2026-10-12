import { Copy01 } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { useToast } from "@/portal/components/toast";

/** An RSVP code (or any short secret) with a copy button. */
export const CopyCode = ({ code }: { code: string }) => {
    const toast = useToast();
    return (
        <span className="inline-flex items-center gap-1">
            <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-sm text-secondary">{code}</code>
            <ButtonUtility
                size="xs"
                color="tertiary"
                icon={Copy01}
                tooltip="Copy code"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(code);
                        toast.success("Code copied");
                    } catch {
                        toast.error("Couldn't copy", "Select the code and copy it by hand.");
                    }
                }}
            />
        </span>
    );
};
