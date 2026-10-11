import type { ReactNode } from "react";
import { BookOpen01 } from "@untitledui/icons";
import { EmptyState } from "@/components/application/empty-state/empty-state";

export const EmptyPosts = ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
    <EmptyState size="md" className="py-8">
        <EmptyState.Header pattern="circle">
            <EmptyState.FeaturedIcon icon={BookOpen01} color="gray" theme="modern" />
        </EmptyState.Header>
        <EmptyState.Content>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description>{description}</EmptyState.Description>
        </EmptyState.Content>
        {action && <EmptyState.Footer>{action}</EmptyState.Footer>}
    </EmptyState>
);
