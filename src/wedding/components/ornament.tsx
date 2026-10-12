import { cx } from "@/utils/cx";

/** A hand-drawn eucalyptus sprig used as a divider. Decorative only. */
export const Sprig = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 160 40" fill="none" aria-hidden="true" className={cx("h-8 w-32 text-brand-500", className)}>
        <path d="M8 20 C 40 20, 120 20, 152 20" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        {[
            [32, -1],
            [52, 1],
            [72, -1],
            [92, 1],
            [112, -1],
            [128, 1],
        ].map(([x, dir]) => (
            <ellipse
                key={x}
                cx={x}
                cy={20 + dir * 7}
                rx="7.5"
                ry="4.2"
                transform={`rotate(${dir * -28} ${x} ${20 + dir * 7})`}
                fill="currentColor"
                opacity={0.28 + (x % 3) * 0.08}
            />
        ))}
        <circle cx="80" cy="20" r="2.2" fill="var(--color-clay-400)" />
    </svg>
);

/** A soft arch outline framing the hero names. */
export const Arch = ({ className }: { className?: string }) => (
    <svg
        viewBox="0 0 400 520"
        fill="none"
        aria-hidden="true"
        preserveAspectRatio="none"
        className={cx("pointer-events-none absolute inset-0 size-full text-olive-300", className)}
    >
        <path d="M20 510 V 200 C 20 95, 105 12, 200 12 C 295 12, 380 95, 380 200 V 510" stroke="currentColor" strokeWidth="1.5" />
        <path d="M34 510 V 204 C 34 106, 112 26, 200 26 C 288 26, 366 106, 366 204 V 510" stroke="currentColor" strokeWidth="0.75" opacity="0.6" />
    </svg>
);
