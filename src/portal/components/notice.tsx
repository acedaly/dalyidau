// An inline notice in the style of Untitled UI's AlertFloating, without the truncation and
// required actions, for persistent explanations (e.g. "email delivery is off").
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle, InfoCircle } from "@untitledui/icons";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { cx } from "@/utils/cx";

const ICONS = { brand: InfoCircle, gray: InfoCircle, warning: AlertCircle, error: AlertCircle, success: CheckCircle };

export const Notice = ({
    title,
    children,
    color = "gray",
    actions,
    className,
}: {
    title: string;
    children?: ReactNode;
    color?: keyof typeof ICONS;
    actions?: ReactNode;
    className?: string;
}) => (
    <div
        role={color === "error" ? "alert" : "note"}
        className={cx("flex flex-col gap-4 rounded-xl border border-primary bg-primary_alt p-4 shadow-xs sm:flex-row", className)}
    >
        <FeaturedIcon icon={ICONS[color]} color={color} theme={color === "gray" ? "modern" : "outline"} size="md" />
        <div className="flex flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold text-secondary">{title}</p>
                {children && <div className="text-sm text-tertiary">{children}</div>}
            </div>
            {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
        </div>
    </div>
);
