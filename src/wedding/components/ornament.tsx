// Hand-drawn style botanicals and a country landscape, all inline SVG so the site needs no image
// requests for its decoration. Shapes are generated from fixed values, so the server render and
// the browser always agree. Everything here is decorative (aria-hidden).
import { cx } from "@/utils/cx";

type Point = [number, number];

const quad = (p0: Point, c: Point, p1: Point, t: number): Point => [
    (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t ** 2 * p1[0],
    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t ** 2 * p1[1],
];
const quadAngle = (p0: Point, c: Point, p1: Point, t: number) => {
    const dx = 2 * (1 - t) * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]);
    const dy = 2 * (1 - t) * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1]);
    return (Math.atan2(dy, dx) * 180) / Math.PI;
};
const r = (n: number) => Math.round(n * 10) / 10;

/** A long, slightly sickle-shaped eucalyptus leaf pointing along +x. */
const leafPath = (length: number, width: number) =>
    `M0 0 C ${r(length * 0.28)} ${r(-width)} ${r(length * 0.74)} ${r(-width * 0.85)} ${r(length)} ${r(width * 0.15)} C ${r(length * 0.7)} ${r(width * 0.55)} ${r(length * 0.3)} ${r(width * 0.6)} 0 0 Z`;
const ribPath = (length: number, width: number) => `M1 0 Q ${r(length * 0.5)} ${r(-width * 0.2)} ${r(length * 0.94)} ${r(width * 0.12)}`;

interface LeafSpec {
    /** Position along the stem, 0–1. */
    t: number;
    side: 1 | -1;
    length: number;
    /** Extra angle away from the stem, degrees. */
    spread: number;
}

const BRANCH_LEAVES: LeafSpec[] = [
    { t: 0.12, side: -1, length: 34, spread: 52 },
    { t: 0.2, side: 1, length: 40, spread: 62 },
    { t: 0.31, side: -1, length: 44, spread: 48 },
    { t: 0.4, side: 1, length: 46, spread: 58 },
    { t: 0.5, side: -1, length: 42, spread: 44 },
    { t: 0.59, side: 1, length: 40, spread: 54 },
    { t: 0.68, side: -1, length: 36, spread: 42 },
    { t: 0.77, side: 1, length: 32, spread: 48 },
    { t: 0.86, side: -1, length: 26, spread: 36 },
    { t: 0.94, side: 1, length: 20, spread: 30 },
];

/**
 * A trailing eucalyptus branch with a cluster of gumnuts, drawn as fine line work with a light wash.
 * `draw` animates the stem and ribs in like ink (turned off with reduced motion).
 */
export const EucalyptusBranch = ({ className, draw = false, flip = false }: { className?: string; draw?: boolean; flip?: boolean }) => {
    const p0: Point = [10, 70];
    const c: Point = [120, 8];
    const p1: Point = [250, 52];
    const leaves = BRANCH_LEAVES.map((leaf) => {
        const [x, y] = quad(p0, c, p1, leaf.t);
        // Eucalyptus leaves hang: lean every leaf a little towards the ground.
        const angle = quadAngle(p0, c, p1, leaf.t) + leaf.side * leaf.spread + 14;
        return { x, y, angle, ...leaf, width: leaf.length * 0.2 };
    });
    const nut = quad(p0, c, p1, 0.46);
    return (
        <svg
            viewBox="0 0 260 120"
            fill="none"
            aria-hidden="true"
            className={cx("overflow-visible", draw && "wedding-draw", className)}
            style={flip ? { transform: "scaleX(-1)" } : undefined}
        >
            <path d={`M${p0[0]} ${p0[1]} Q ${c[0]} ${c[1]} ${p1[0]} ${p1[1]}`} stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" pathLength={1} />
            {leaves.map((leaf, i) => (
                <g key={i} transform={`translate(${r(leaf.x)} ${r(leaf.y)}) rotate(${r(leaf.angle)}) translate(3 0)`}>
                    <path d={`M-3 0 L0 0`} stroke="currentColor" strokeWidth="0.9" />
                    <path
                        d={leafPath(leaf.length, leaf.width)}
                        fill="currentColor"
                        fillOpacity={0.1 + (i % 3) * 0.05}
                        stroke="currentColor"
                        strokeWidth="0.9"
                    />
                    <path d={ribPath(leaf.length, leaf.width)} stroke="currentColor" strokeWidth="0.6" strokeOpacity="0.7" pathLength={1} />
                </g>
            ))}
            {/* Gumnuts hanging below the middle of the stem. */}
            <g transform={`translate(${r(nut[0])} ${r(nut[1])})`} className="text-clay">
                {[
                    [-9, 26],
                    [0, 31],
                    [9, 25],
                ].map(([dx, dy], i) => (
                    <g key={i}>
                        <path d={`M0 0 Q ${dx * 0.4} ${dy * 0.5} ${dx} ${dy - 5}`} stroke="currentColor" strokeWidth="0.8" pathLength={1} />
                        <path
                            d={`M${dx - 4} ${dy - 5} C ${dx - 4.5} ${dy + 2} ${dx + 4.5} ${dy + 2} ${dx + 4} ${dy - 5} Z`}
                            fill="currentColor"
                            fillOpacity="0.28"
                            stroke="currentColor"
                            strokeWidth="0.8"
                        />
                        <path d={`M${dx - 4} ${dy - 5} L ${dx + 4} ${dy - 5}`} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </g>
                ))}
            </g>
        </svg>
    );
};

/** A short sprig used as a divider between blocks of text. */
export const Sprig = ({ className }: { className?: string }) => {
    const leaves: { x: number; side: 1 | -1; length: number }[] = [
        { x: 36, side: -1, length: 16 },
        { x: 48, side: 1, length: 18 },
        { x: 60, side: -1, length: 19 },
        { x: 100, side: 1, length: 19 },
        { x: 112, side: -1, length: 18 },
        { x: 124, side: 1, length: 16 },
    ];
    return (
        <svg viewBox="0 0 160 32" fill="none" aria-hidden="true" className={cx("text-eucalypt h-7 w-36", className)}>
            <path d="M14 16 H 70 M 90 16 H 146" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
            {leaves.map((leaf) => {
                // Leaves point away from the centre on both halves.
                const outward = leaf.x < 80 ? 180 : 0;
                const angle = outward + leaf.side * (leaf.x < 80 ? -32 : 32);
                return (
                    <path
                        key={leaf.x}
                        d={leafPath(leaf.length, leaf.length * 0.24)}
                        transform={`translate(${leaf.x} 16) rotate(${angle})`}
                        fill="currentColor"
                        fillOpacity="0.16"
                        stroke="currentColor"
                        strokeWidth="0.8"
                    />
                );
            })}
            <circle cx="80" cy="16" r="2.6" className="fill-clay" />
        </svg>
    );
};

/**
 * An abstracted arrangement of wine dahlias, copper banksia, cream blossom and eucalyptus.
 * It is deliberately illustrative rather than a substitute photograph: a graceful, on-brand
 * placeholder until the couple selects portal media, and a recurring motif for invitation panels.
 */
export const NativeArrangement = ({ className, quiet = false }: { className?: string; quiet?: boolean }) => (
    <svg viewBox="0 0 620 760" fill="none" aria-hidden="true" className={cx("overflow-visible", className)}>
        <g opacity={quiet ? 0.34 : 1}>
            {/* loose stems preserve the natural movement of the reference arrangement */}
            <path d="M307 721 C298 570 239 422 117 252" className="stroke-eucalypt" strokeWidth="3" strokeLinecap="round" />
            <path d="M318 721 C330 551 390 383 526 202" className="stroke-olive" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M311 721 C320 565 304 394 278 175" className="stroke-eucalypt" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M330 721 C378 565 450 498 568 435" className="stroke-eucalypt" strokeWidth="2" strokeLinecap="round" />
            <path d="M292 721 C260 585 197 520 69 482" className="stroke-olive" strokeWidth="2" strokeLinecap="round" />

            {/* long eucalyptus leaves */}
            {[
                [102, 236, -42, 76, 22],
                [141, 291, 24, 82, 23],
                [181, 351, -30, 94, 25],
                [451, 306, 34, 88, 24],
                [492, 249, -28, 82, 22],
                [525, 202, 32, 70, 20],
                [94, 474, 20, 86, 23],
                [152, 505, -32, 78, 21],
                [503, 471, 32, 86, 23],
                [552, 437, -22, 74, 20],
                [270, 235, -16, 80, 21],
                [288, 191, 24, 72, 19],
            ].map(([x, y, angle, length, width], i) => (
                <path
                    key={i}
                    d={leafPath(length, width)}
                    transform={`translate(${x} ${y}) rotate(${angle})`}
                    className={i % 3 === 0 ? "fill-olive stroke-olive" : "fill-eucalypt stroke-eucalypt"}
                    fillOpacity={0.42 + (i % 3) * 0.1}
                    strokeWidth="1.2"
                />
            ))}

            {/* wine and terracotta flowers: layered organic discs instead of repeated icons */}
            <g transform="translate(205 350)">
                <circle r="88" className="fill-forest" opacity="0.18" />
                {Array.from({ length: 14 }, (_, i) => (
                    <ellipse
                        key={i}
                        cx="0"
                        cy="-46"
                        rx="19"
                        ry="48"
                        transform={`rotate(${i * 25.714})`}
                        className="fill-forest"
                        opacity={0.78 + (i % 3) * 0.08}
                    />
                ))}
                {Array.from({ length: 10 }, (_, i) => (
                    <ellipse key={i} cx="0" cy="-25" rx="13" ry="29" transform={`rotate(${i * 36 + 10})`} className="fill-terracotta" opacity="0.76" />
                ))}
                <circle r="17" className="fill-clay" opacity="0.9" />
            </g>
            <g transform="translate(423 421) scale(.82)">
                {Array.from({ length: 12 }, (_, i) => (
                    <ellipse key={i} cx="0" cy="-45" rx="20" ry="45" transform={`rotate(${i * 30})`} className="fill-forest" opacity={0.72 + (i % 2) * 0.16} />
                ))}
                <circle r="25" className="fill-terracotta" />
                <circle r="11" className="fill-sandstone" />
            </g>
            <g transform="translate(328 535) scale(.62)">
                {Array.from({ length: 11 }, (_, i) => (
                    <ellipse key={i} cx="0" cy="-43" rx="21" ry="43" transform={`rotate(${i * 32.7})`} className="fill-terracotta" opacity="0.88" />
                ))}
                <circle r="23" className="fill-clay" />
            </g>

            {/* banksia-inspired copper forms */}
            <g transform="translate(372 254) rotate(17)">
                <ellipse cy="0" rx="38" ry="75" className="fill-clay" opacity="0.94" />
                {Array.from({ length: 9 }, (_, i) => (
                    <path key={i} d={`M-31 ${-48 + i * 12} Q0 ${-58 + i * 12} 31 ${-48 + i * 12}`} className="stroke-sandstone" strokeWidth="3" opacity="0.8" />
                ))}
                <path d="M0 73 C-2 105 -8 132 -17 158" className="stroke-olive" strokeWidth="3" />
            </g>
            <g transform="translate(125 423) rotate(-23) scale(.68)">
                <ellipse rx="38" ry="75" className="fill-terracotta" />
                {Array.from({ length: 8 }, (_, i) => (
                    <path
                        key={i}
                        d={`M-31 ${-43 + i * 13} Q0 ${-54 + i * 13} 31 ${-43 + i * 13}`}
                        className="stroke-sandstone"
                        strokeWidth="3"
                        opacity="0.75"
                    />
                ))}
            </g>

            {/* airy cream gum blossom */}
            <g transform="translate(480 345)">
                {Array.from({ length: 18 }, (_, i) => (
                    <path key={i} d="M0 0 Q34 -18 54 1" transform={`rotate(${i * 20})`} className="stroke-paper" strokeWidth="3" strokeLinecap="round" />
                ))}
                <circle r="17" className="fill-sandstone" />
            </g>
            <g transform="translate(274 278) scale(.7)">
                {Array.from({ length: 16 }, (_, i) => (
                    <path key={i} d="M0 0 Q30 -16 48 0" transform={`rotate(${i * 22.5})`} className="stroke-paper" strokeWidth="3" strokeLinecap="round" />
                ))}
                <circle r="14" className="fill-sandstone" />
            </g>

            {/* scattered gumnuts add native texture without turning into a repeating border */}
            {[
                [80, 374],
                [103, 354],
                [518, 540],
                [543, 524],
                [410, 158],
            ].map(([x, y], i) => (
                <g key={i} transform={`translate(${x} ${y}) rotate(${i % 2 ? 18 : -14})`}>
                    <path d="M0 0 C10 13 13 27 12 43" className="stroke-eucalypt" strokeWidth="2" />
                    <path d="M2 38 C2 58 23 58 23 38 Z" className="fill-terracotta stroke-terracotta" strokeWidth="1" />
                    <path d="M2 38 H23" className="stroke-sandstone" strokeWidth="3" strokeLinecap="round" />
                </g>
            ))}
        </g>
    </svg>
);

/** Clumps of foliage for the gum tree: [x, y, width, height] in the tree's 200×260 box. */
const CLUMPS: [number, number, number, number][] = [
    [30, 104, 46, 20],
    [62, 70, 54, 24],
    [104, 52, 58, 26],
    [138, 80, 48, 22],
    [96, 96, 40, 16],
    [160, 104, 30, 13],
];

/**
 * A gum tree: a pale, forked trunk with an open, umbrella-like canopy built from small leaf
 * clusters. Each clump is drawn as one flat shape so overlaps don't darken into blobs.
 */
const GumTree = ({ x, y, scale = 1, tone = 1 }: { x: number; y: number; scale?: number; tone?: number }) => (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
        <path
            d="M90 262 C 92 230 93 200 92 176 C 91 160 84 146 70 128 L 74 125 C 88 140 95 152 98 166 C 102 150 112 136 128 118 L 132 121 C 118 140 106 158 102 178 C 101 206 102 232 106 262 Z"
            fill="rgb(222 213 196)"
        />
        <path
            d="M70 128 C 60 118 48 112 36 110 M 128 118 C 134 104 132 92 140 84 M 92 176 C 98 140 102 108 106 62"
            stroke="rgb(222 213 196)"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
        />
        <path d="M100 262 C 98 230 98 204 99 180" stroke="rgb(196 184 163)" strokeWidth="2" fill="none" opacity="0.6" />
        {CLUMPS.map(([cx, cy, w, h], i) => (
            <g key={i} className={i % 3 === 1 ? "fill-eucalypt" : "fill-forest"} opacity={(i % 3 === 1 ? 0.95 : 0.78) * tone}>
                {Array.from({ length: 9 }, (_, j) => {
                    // Deterministic scatter: leaf clusters spread across the clump, flatter at the edges.
                    const a = (j / 9) * Math.PI * 2 + i;
                    const d = 0.25 + ((j * 7 + i * 3) % 5) / 8;
                    return (
                        <ellipse
                            key={j}
                            cx={r(cx + Math.cos(a) * w * 0.5 * d)}
                            cy={r(cy + Math.sin(a) * h * 0.5 * d)}
                            rx={r(w * (0.2 + (j % 3) * 0.05))}
                            ry={r(h * (0.28 + (j % 2) * 0.08))}
                        />
                    );
                })}
            </g>
        ))}
    </g>
);

/**
 * An illustrated country landscape (sky, sun, ranges, paddock and gums) in the wedding palette.
 * Used wherever a photo hasn't been uploaded yet, so frames never look empty or broken.
 */
export const Landscape = ({
    className,
    variant = "portrait",
    sky = true,
}: {
    className?: string;
    variant?: "portrait" | "wide";
    /** Off when the landscape sits directly on the page, so the paper shows through instead of a painted sky. */
    sky?: boolean;
}) => {
    const wide = variant === "wide";
    return (
        <svg
            viewBox={wide ? "0 0 800 450" : "0 0 400 500"}
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
            className={cx("block size-full", className)}
        >
            <defs>
                <linearGradient id={`sky-${variant}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="rgb(233 222 202)" />
                    <stop offset="0.6" stopColor="rgb(244 236 222)" />
                    <stop offset="1" stopColor="rgb(240 230 212)" />
                </linearGradient>
            </defs>
            {sky && <rect width="100%" height="100%" fill={`url(#sky-${variant})`} />}
            {wide ? (
                <>
                    <circle cx="640" cy="215" r="58" className="fill-clay" opacity="0.22" />
                    <path
                        d="M0 270 C 120 230 230 250 340 236 C 450 222 560 250 660 232 C 720 222 770 228 800 236 V 450 H 0 Z"
                        className="fill-eucalypt"
                        opacity="0.4"
                    />
                    <path d="M0 304 C 140 282 260 300 400 286 C 540 272 660 296 800 282 V 450 H 0 Z" className="fill-olive" opacity="0.38" />
                    <path d="M0 340 C 180 326 360 346 520 332 C 640 322 730 334 800 330 V 450 H 0 Z" className="fill-sandstone" />
                    <path d="M0 384 C 200 372 420 392 800 376 V 450 H 0 Z" className="fill-sandstone" opacity="0.7" />
                    <GumTree x={70} y={110} scale={0.95} />
                    <GumTree x={600} y={196} scale={0.48} tone={0.8} />
                    <GumTree x={700} y={214} scale={0.36} tone={0.7} />
                    <path d="M0 360 H 800" className="stroke-olive" strokeWidth="0.8" opacity="0.4" />
                </>
            ) : (
                <>
                    <circle cx="282" cy="196" r="44" className="fill-clay" opacity="0.22" />
                    <path d="M0 300 C 70 270 140 288 210 276 C 280 264 340 282 400 272 V 500 H 0 Z" className="fill-eucalypt" opacity="0.4" />
                    <path d="M0 336 C 90 318 180 334 260 322 C 320 314 370 322 400 318 V 500 H 0 Z" className="fill-olive" opacity="0.38" />
                    <path d="M0 372 C 120 360 250 378 400 362 V 500 H 0 Z" className="fill-sandstone" />
                    <path d="M0 420 C 140 410 280 428 400 414 V 500 H 0 Z" className="fill-sandstone" opacity="0.65" />
                    <GumTree x={-6} y={140} scale={1.08} />
                    <GumTree x={270} y={236} scale={0.42} tone={0.8} />
                </>
            )}
        </svg>
    );
};

/** A round, stamp-like mark with text set around the edge, e.g. "First in · First served". */
export const Stamp = ({ text, className, children }: { text: string; className?: string; children?: React.ReactNode }) => (
    <svg viewBox="0 0 120 120" aria-hidden="true" className={cx("text-clay", className)}>
        <defs>
            <path id="stamp-ring" d="M60 60 m -44 0 a 44 44 0 1 1 88 0 a 44 44 0 1 1 -88 0" />
        </defs>
        <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" strokeWidth="0.9" />
        <circle cx="60" cy="60" r="33" fill="none" stroke="currentColor" strokeWidth="0.7" />
        <text fill="currentColor" fontSize="9.4" letterSpacing="3.1" style={{ fontFamily: "var(--font-wedding-body)", fontWeight: 500 }}>
            <textPath href="#stamp-ring">{text.toUpperCase()}</textPath>
        </text>
        {children}
    </svg>
);
