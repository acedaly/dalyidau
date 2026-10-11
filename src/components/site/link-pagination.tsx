import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

/** Page numbers to show, with null for an ellipsis gap. */
export const pageWindow = (current: number, total: number): (number | null)[] => {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set([1, 2, total - 1, total, current - 1, current, current + 1].filter((p) => p >= 1 && p <= total));
    const sorted = [...pages].sort((a, b) => a - b);
    const result: (number | null)[] = [];
    sorted.forEach((page, i) => {
        if (i > 0 && page - sorted[i - 1] > 1) result.push(null);
        result.push(page);
    });
    return result;
};

/**
 * Link-based pagination styled after Untitled UI's "page default" pagination. Real links keep
 * every page crawlable and working without JavaScript.
 */
export const LinkPagination = ({ page, total, href }: { page: number; total: number; href: (page: number) => string }) => {
    if (total <= 1) return null;
    const prev = page > 1 ? href(page - 1) : null;
    const next = page < total ? href(page + 1) : null;

    return (
        <nav aria-label="Pagination" className="flex w-full items-center justify-between gap-3 border-t border-secondary pt-4 md:pt-5">
            <div className="flex flex-1 justify-start">
                {prev ? (
                    <Button href={prev} iconLeading={ArrowLeft} color="secondary" size="sm" rel="prev">
                        <span className="max-md:sr-only">Previous</span>
                    </Button>
                ) : (
                    <span />
                )}
            </div>

            <ol className="hidden justify-center gap-0.5 md:flex">
                {pageWindow(page, total).map((p, i) =>
                    p === null ? (
                        <li key={`gap-${i}`} aria-hidden="true" className="flex size-9 items-center justify-center text-tertiary">
                            &#8230;
                        </li>
                    ) : (
                        <li key={p}>
                            <a
                                href={href(p)}
                                aria-current={p === page ? "page" : undefined}
                                aria-label={`Page ${p}`}
                                className={cx(
                                    "flex size-9 items-center justify-center rounded-lg p-3 text-sm font-medium text-quaternary outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2",
                                    p === page && "bg-primary_hover text-secondary",
                                )}
                            >
                                {p}
                            </a>
                        </li>
                    ),
                )}
            </ol>
            <p className="text-sm text-fg-secondary md:hidden">
                Page <span className="font-medium">{page}</span> of <span className="font-medium">{total}</span>
            </p>

            <div className="flex flex-1 justify-end">
                {next ? (
                    <Button href={next} iconTrailing={ArrowRight} color="secondary" size="sm" rel="next">
                        <span className="max-md:sr-only">Next</span>
                    </Button>
                ) : (
                    <span />
                )}
            </div>
        </nav>
    );
};
