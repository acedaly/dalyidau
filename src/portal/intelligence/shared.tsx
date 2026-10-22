// Shared pieces of the Intelligence pages: the availability notice, said plainly, so a page never
// looks broken when a feature is simply off.
import { Button } from "@/components/base/buttons/button";
import { Notice } from "@/portal/components/notice";
import type { IntelligenceShell } from "@/shared/intelligence/types";

export const AvailabilityNotice = ({ shell, need }: { shell: IntelligenceShell; need: (keyof IntelligenceShell["status"]["available"])[] }) => {
    const { status } = shell;
    if (need.every((k) => status.available[k])) {
        if (status.circuitOpen)
            return (
                <Notice title="Workers AI isn't responding" color="warning">
                    New AI work is paused for a few minutes. Nothing you've saved is affected.
                </Notice>
            );
        return null;
    }
    const reason = !status.features.enabled
        ? "Intelligence is switched off for this portal."
        : !status.bindings.ai
          ? "Workers AI isn't connected to this portal yet."
          : "This feature is switched off.";
    return (
        <Notice
            title="Not available right now"
            color="gray"
            actions={
                shell.canManage ? (
                    <Button size="sm" color="link-color" href="/portal/intelligence/settings">
                        Intelligence settings
                    </Button>
                ) : undefined
            }
        >
            {reason} {shell.canManage ? "Owners and admins can change this in Intelligence settings." : "An owner or admin can switch it on."} Everything else
            works as usual.
        </Notice>
    );
};
