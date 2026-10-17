// Statistic cards adapted from Untitled UI PRO "metrics" (MetricsIcon/MetricsSimple): same card,
// type scale and change indicator, without the demo actions menu, and with an optional progress
// bar and footer link for portal use.
import type { FC, ReactNode } from "react";
import { MetricChangeIndicator } from "@/components/application/metrics/metrics";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { cx } from "@/utils/cx";

interface MetricCardProps {
    label: string;
    value: ReactNode;
    icon?: FC<{ className?: string }>;
    /** Small supporting line under the value. */
    detail?: ReactNode;
    change?: { value: string; trend: "positive" | "negative" };
    /** 0–100. Renders a progress bar under the value. */
    progress?: number;
    progressLabel?: string;
    footer?: ReactNode;
    className?: string;
}

export const MetricCard = ({ label, value, icon, detail, change, progress, progressLabel, footer, className }: MetricCardProps) => (
    <div className={cx("flex flex-col rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset", className)}>
        <div className="flex flex-1 flex-col gap-4 px-4 py-5 md:px-5">
            <div className="flex items-center gap-3">
                {icon && <FeaturedIcon icon={icon} color="gray" theme="modern" size="md" />}
                <h3 className="text-sm font-medium text-tertiary">{label}</h3>
            </div>
            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-end justify-between gap-2">
                    <p className="text-display-sm font-semibold text-primary tabular-nums">{value}</p>
                    {change && <MetricChangeIndicator type="modern" trend={change.trend} value={change.value} />}
                </div>
                {detail && <div className="text-sm text-tertiary">{detail}</div>}
                {typeof progress === "number" && (
                    <ProgressBar
                        value={Math.max(0, Math.min(100, progress))}
                        labelPosition="right"
                        aria-label={progressLabel ?? label}
                        valueFormatter={() => progressLabel ?? `${Math.round(progress)}%`}
                    />
                )}
            </div>
        </div>
        {footer && <div className="flex items-center justify-end border-t border-secondary px-4 py-3 md:px-5">{footer}</div>}
    </div>
);
