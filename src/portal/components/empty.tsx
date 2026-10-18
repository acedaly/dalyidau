// Empty and loading states for the portal, built on Untitled UI's EmptyState.
import type { FC, ReactNode } from "react";
import { EmptyState } from "@/components/application/empty-state/empty-state";
import { cx } from "@/utils/cx";

interface EmptyProps {
    icon: FC<{ className?: string }>;
    title: string;
    description: ReactNode;
    actions?: ReactNode;
    size?: "sm" | "md";
}

// The header's decorative circles are wider than a phone; clipping them at the full width of the
// container keeps them on wide screens and stops them widening (and zooming out) a narrow page.
export const Empty = ({ icon, title, description, actions, size = "md" }: EmptyProps) => (
    <div className="w-full overflow-x-clip">
        <EmptyState size={size}>
            <EmptyState.Header pattern="circle">
                <EmptyState.FeaturedIcon icon={icon} color="gray" theme="modern" />
            </EmptyState.Header>
            <EmptyState.Content>
                <EmptyState.Title>{title}</EmptyState.Title>
                <EmptyState.Description>{description}</EmptyState.Description>
            </EmptyState.Content>
            {actions && <EmptyState.Footer>{actions}</EmptyState.Footer>}
        </EmptyState>
    </div>
);

/** Placeholder block for content that renders only in the browser (charts) or is loading. */
export const Skeleton = ({ className }: { className?: string }) => (
    <div aria-hidden="true" className={cx("animate-pulse rounded-md bg-secondary", className)} />
);

/** A card-shaped skeleton matching MetricCard and chart cards. */
export const CardSkeleton = ({ className }: { className?: string }) => (
    <div aria-hidden="true" className={cx("flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset", className)}>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-24 w-full" />
    </div>
);
