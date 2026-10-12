import { useMounted } from "@/portal/hooks/use-mounted";
import { formatDateTime, formatRelative } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";

/** A timestamp shown in the wedding's time zone, switching to "2 hours ago" once mounted. */
export const Timestamp = ({ iso, relative = false, className }: { iso: string; relative?: boolean; className?: string }) => {
    const { wedding } = usePortal();
    const mounted = useMounted();
    const absolute = formatDateTime(iso, wedding.timeZone);
    return (
        <time dateTime={iso} title={absolute} className={className}>
            {relative && mounted ? formatRelative(iso, Date.now(), wedding.timeZone) : absolute}
        </time>
    );
};
