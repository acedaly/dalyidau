import { useEffect, useState } from "react";
import type { TocEntry } from "@/shared/types";
import { cx } from "@/utils/cx";

/** Highlights the section currently in view once hydrated. */
const useActiveHeading = (ids: string[]) => {
    const [active, setActive] = useState<string | null>(null);
    useEffect(() => {
        if (!ids.length || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
                if (visible[0]) setActive(visible[0].target.id);
            },
            { rootMargin: "-80px 0px -70% 0px" },
        );
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) observer.observe(el);
        }
        return () => observer.disconnect();
    }, [ids.join("|")]);
    return active;
};

export const TableOfContents = ({ toc, className }: { toc: TocEntry[]; className?: string }) => {
    const active = useActiveHeading(toc.map((t) => t.id));
    return (
        <nav aria-labelledby="toc-heading" className={className}>
            <p id="toc-heading" className="text-sm font-semibold text-brand-secondary">
                On this page
            </p>
            <ol className="mt-3 flex flex-col gap-0.5 border-l border-secondary">
                {toc.map((entry) => (
                    <li key={entry.id}>
                        <a
                            href={`#${entry.id}`}
                            aria-current={active === entry.id ? "location" : undefined}
                            className={cx(
                                "-ml-px block border-l py-1.5 text-sm outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2",
                                entry.level === 3 ? "pl-7" : "pl-4",
                                active === entry.id
                                    ? "border-fg-brand-primary_alt font-semibold text-brand-secondary"
                                    : "border-transparent font-medium text-tertiary hover:text-secondary",
                            )}
                        >
                            {entry.text}
                        </a>
                    </li>
                ))}
            </ol>
        </nav>
    );
};
