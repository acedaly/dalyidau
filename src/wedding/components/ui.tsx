// Small building blocks shared by the wedding website and the RSVP flow. Buttons are Untitled UI's
// Button with the wedding's stationery styling layered on through className (tailwind-merge resolves
// the conflicts), so focus rings, loading states and link behaviour stay Untitled UI's.
import type { ReactNode } from "react";
import { formatDate } from "@/portal/lib/format";
import type { WebsiteMedia } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { Landscape } from "@/wedding/components/ornament";

const buttonBase =
    "rounded-[2px] px-7 py-3.5 text-[0.75rem] font-medium tracking-[0.2em] uppercase shadow-none before:hidden min-h-12 transition duration-200 ease-out";

/** Class names for Untitled UI Buttons on the wedding site. */
export const weddingButton = {
    /** Solid deep forest: RSVP and other primary actions. */
    primary: cx(buttonBase, "bg-forest text-ivory hover:bg-forest-deep hover:-translate-y-px"),
    /** Hairline outline on ivory. */
    outline: cx(buttonBase, "text-forest ring-forest/40 hover:bg-forest hover:text-ivory bg-transparent ring-1"),
    /** Ivory on the forest band. */
    light: cx(buttonBase, "bg-ivory text-forest hover:bg-paper hover:text-forest-deep ring-0 hover:-translate-y-px"),
    /** Understated text link with an underline that grows on hover. */
    link: "rounded-sm p-0 text-[0.8125rem] font-medium tracking-[0.18em] uppercase text-forest underline decoration-forest/30 underline-offset-[6px] transition duration-100 ease-linear hover:decoration-forest",
};

export const paragraphs = (text: string) =>
    text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);

/** Plain text with **bold** marks (as people type them in Say I Do and the portal). Never parsed as HTML. */
export const Emphasis = ({ text }: { text: string }) => (
    <>
        {text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
            i % 2 === 1 ? (
                <strong key={i} className="text-forest font-medium">
                    {part}
                </strong>
            ) : (
                part
            ),
        )}
    </>
);

export const Prose = ({ text, className }: { text: string; className?: string }) => (
    <div className={cx("wedding-prose", className)}>
        {paragraphs(text).map((p, i) => (
            <p key={i}>
                <Emphasis text={p} />
            </p>
        ))}
    </div>
);

export const longDate = (iso: string) => formatDate(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const shortDate = (iso: string) => formatDate(iso, { day: "numeric", month: "long", year: "numeric" });

export const Eyebrow = ({ children, className }: { children: ReactNode; className?: string }) => (
    <p className={cx("wedding-eyebrow text-olive-600", className)}>{children}</p>
);

/** Eyebrow + editorial serif heading. Sizes step down on small screens without becoming cramped. */
export const SectionHeading = ({
    id,
    eyebrow,
    title,
    align = "left",
    size = "lg",
    className,
}: {
    id: string;
    eyebrow?: string;
    title: string;
    align?: "left" | "center";
    size?: "md" | "lg";
    className?: string;
}) => (
    <div className={cx("flex flex-col gap-4", align === "center" && "items-center text-center", className)}>
        {eyebrow && (
            <Eyebrow className="flex items-center gap-3">
                <span aria-hidden="true" className="bg-olive/50 h-px w-8" />
                {eyebrow}
                {align === "center" && <span aria-hidden="true" className="bg-olive/50 h-px w-8" />}
            </Eyebrow>
        )}
        <h2
            id={id}
            className={cx(
                "wedding-script text-forest text-balance",
                size === "lg" ? "text-[3.5rem] sm:text-[4.5rem] lg:text-[5.25rem]" : "text-[3rem] sm:text-[3.75rem]",
            )}
        >
            {title}
        </h2>
    </div>
);

/**
 * A framed photograph. Arch frames echo the invitation; a fine inset rule gives it a printed edge.
 * Without a photo it shows the illustrated landscape, so the composition holds before photos exist.
 */
export const Photo = ({
    image,
    shape = "rect",
    ratio,
    priority = false,
    sizes,
    className,
    imgClassName,
    fallback = "portrait",
}: {
    image: WebsiteMedia | null | undefined;
    shape?: "arch" | "rect" | "none";
    /** CSS aspect-ratio, e.g. "4 / 5". Omit to fill the parent. */
    ratio?: string;
    priority?: boolean;
    sizes?: string;
    className?: string;
    imgClassName?: string;
    fallback?: "portrait" | "wide";
}) => (
    <div
        className={cx(
            "bg-sandstone-light relative isolate overflow-hidden",
            shape === "arch" && "rounded-t-[999px]",
            shape === "rect" && "rounded-[3px]",
            className,
        )}
        style={ratio ? { aspectRatio: ratio } : undefined}
    >
        {image ? (
            <img
                src={image.url}
                alt={image.alt}
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                sizes={sizes}
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : undefined}
                decoding="async"
                className={cx("absolute inset-0 size-full object-cover", imgClassName)}
            />
        ) : (
            <Landscape variant={fallback} className="absolute inset-0" />
        )}
        {shape !== "none" && (
            <span
                aria-hidden="true"
                className={cx(
                    "border-ivory/70 pointer-events-none absolute inset-2.5 border sm:inset-3.5",
                    shape === "arch" ? "rounded-t-[999px]" : "rounded-[2px]",
                )}
            />
        )}
    </div>
);
