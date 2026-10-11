import type { ReactNode } from "react";
import { BookOpen01 } from "@untitledui/icons";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";

export const EmptyPosts = ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
    <div className="mx-auto flex max-w-md flex-col items-center rounded-2xl border border-dashed border-primary px-6 py-12 text-center">
        <FeaturedIcon icon={BookOpen01} color="gray" theme="modern" size="lg" />
        <h2 className="mt-4 text-lg font-semibold text-primary">{title}</h2>
        <p className="mt-1 text-md text-tertiary">{description}</p>
        {action && <div className="mt-6">{action}</div>}
    </div>
);
