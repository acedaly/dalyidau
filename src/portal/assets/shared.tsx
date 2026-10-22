// Pieces every Home & Assets page shares: the header with quick actions, the badges for status,
// warranty, insurance and due dates, money that says "Not recorded" or "Not shared" instead of $0,
// the attention list, cover thumbnails, and preparing files in the browser before upload (photos
// are resized and re-encoded, which drops their location and camera metadata).
import type { ReactNode } from "react";
import { useState } from "react";
import { AlertTriangle, Home02, Lock01, Package, Plus, QrCode02, SearchLg, ShieldTick, Truck01, Users01 } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatMoney } from "@/portal/lib/format";
import type { CategoryGroup } from "@/shared/assets/categories";
import { inDays } from "@/shared/assets/engine";
import {
    ASSET_STATUS_LABELS,
    type AssetStatus,
    type AssetSummary,
    type AssetVisibility,
    type AttentionItem,
    COVERAGE_LABELS,
    type CoverageState,
    type DueState,
    LIMITS,
    VALUE_BASIS_LABELS,
    type ValueView,
    type WarrantyState,
} from "@/shared/assets/types";
import { cx } from "@/utils/cx";
import { type UploadBody, assetsApi, fileUrl } from "./assets-api";

export const ASSETS = "/portal/assets";
export const assetHref = (id: string, tab?: string) => `${ASSETS}/item/${id}${tab ? `?tab=${tab}` : ""}`;
export const locationHref = (id: string) => `${ASSETS}/property/${id}`;

// --- Header ----------------------------------------------------------------------------------------

export const AssetsHeader = ({
    title,
    description,
    crumbs = [],
    actions,
    children,
}: {
    title: string;
    description?: ReactNode;
    crumbs?: { label: string; href?: string }[];
    actions?: ReactNode;
    children?: ReactNode;
}) => (
    <PageHeader
        title={title}
        description={description}
        breadcrumbs={[{ label: "Home & Assets", href: ASSETS }, ...crumbs]}
        actions={
            <>
                <form action={`${ASSETS}/search`} method="get" role="search" className="w-full sm:w-56">
                    <Input name="q" aria-label="Search Home & Assets" placeholder="Search" icon={SearchLg} size="sm" type="search" />
                </form>
                <Button size="sm" color="secondary" iconLeading={QrCode02} href={`${ASSETS}/capture?mode=scan`}>
                    Scan
                </Button>
                {actions ?? (
                    <Button size="sm" iconLeading={Plus} href={`${ASSETS}/capture`}>
                        Add asset
                    </Button>
                )}
            </>
        }
    >
        {children}
    </PageHeader>
);

// --- Money and values ------------------------------------------------------------------------------

/** "Not shared" when hidden, "Not recorded" when missing; never $0 for an unknown amount. */
export const Money = ({ cents, hidden, className }: { cents: number | null | undefined; hidden?: boolean; className?: string }) =>
    hidden ? (
        <span className={cx("inline-flex items-center gap-1 text-tertiary", className)}>
            <Lock01 aria-hidden="true" className="size-3.5" />
            Not shared
        </span>
    ) : cents === null || cents === undefined ? (
        <span className={cx("text-quaternary", className)}>Not recorded</span>
    ) : (
        <span className={cx("tabular-nums", className)}>{formatMoney(cents)}</span>
    );

export const ValueLine = ({ value, hidden }: { value: ValueView | null; hidden?: boolean }) => (
    <span className="inline-flex flex-wrap items-center gap-2">
        <Money cents={value?.amountCents} hidden={hidden} />
        {value && !hidden && (
            <Badge size="sm" type="color" color={value.basis === "formula" ? "purple" : value.basis === "user_estimate" ? "gray" : "brand"}>
                {VALUE_BASIS_LABELS[value.basis]}
            </Badge>
        )}
    </span>
);

// --- Badges ----------------------------------------------------------------------------------------

const STATUS_COLORS: Record<AssetStatus, "gray" | "success" | "warning" | "error" | "blue"> = {
    active: "success",
    in_storage: "gray",
    in_repair: "warning",
    lent: "blue",
    lost: "error",
    stolen: "error",
    sold: "gray",
    disposed: "gray",
    gifted: "gray",
};
export const StatusBadge = ({ status }: { status: AssetStatus }) => (
    <BadgeWithDot size="sm" type="modern" color={STATUS_COLORS[status]}>
        {ASSET_STATUS_LABELS[status]}
    </BadgeWithDot>
);

const WARRANTY_LABELS: Record<WarrantyState, string> = {
    active: "Under warranty",
    expiring: "Warranty ending soon",
    expired: "Warranty ended",
    unknown: "Warranty end not known",
    none: "No warranty recorded",
};
const WARRANTY_COLORS: Record<WarrantyState, "success" | "warning" | "gray"> = {
    active: "success",
    expiring: "warning",
    expired: "gray",
    unknown: "gray",
    none: "gray",
};
export const WarrantyBadge = ({ state }: { state: WarrantyState }) => (
    <Badge size="sm" type="pill-color" color={WARRANTY_COLORS[state]}>
        {WARRANTY_LABELS[state]}
    </Badge>
);

const COVERAGE_COLORS: Record<CoverageState, "success" | "warning" | "error" | "gray"> = {
    verified: "success",
    unverified: "warning",
    lapsed: "error",
    none: "gray",
    hidden: "gray",
};
export const CoverageBadge = ({ state }: { state: CoverageState }) => (
    <span className="inline-flex">
        <Badge size="sm" type="pill-color" color={COVERAGE_COLORS[state]}>
            {state === "verified" && <ShieldTick aria-hidden="true" className="mr-1 size-3" />}
            {COVERAGE_LABELS[state]}
        </Badge>
    </span>
);

const DUE_LABELS: Record<DueState, string> = { overdue: "Overdue", due_soon: "Due soon", upcoming: "Upcoming", unknown: "Not enough information" };
const DUE_COLORS: Record<DueState, "error" | "warning" | "gray" | "blue"> = { overdue: "error", due_soon: "warning", upcoming: "blue", unknown: "gray" };
export const DueBadge = ({ state }: { state: DueState }) => (
    <BadgeWithDot size="sm" type="pill-color" color={DUE_COLORS[state]}>
        {DUE_LABELS[state]}
    </BadgeWithDot>
);

export const VisibilityBadge = ({ visibility }: { visibility: AssetVisibility }) => {
    const Icon = visibility === "private" ? Lock01 : Users01;
    return (
        <span className="inline-flex">
            <Badge size="sm" type="color" color="gray">
                <Icon aria-hidden="true" className="mr-1 size-3" />
                {visibility === "private" ? "Private" : visibility === "selected" ? "Shared with some" : "Household"}
            </Badge>
        </span>
    );
};

/** "12 Mar 2027 (in 140 days)". */
export const DateWithDistance = ({ date, today }: { date: string | null; today: string }) => {
    if (!date) return <span className="text-quaternary">Not recorded</span>;
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    return (
        <span>
            {new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))}
            <span className={cx("ml-1 text-sm", days < 0 ? "text-error-primary" : "text-tertiary")}>({inDays(days)})</span>
        </span>
    );
};

export const shortDate = (date: string | null | undefined) =>
    date ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)) : "";

// --- Icons and thumbnails --------------------------------------------------------------------------

export const GROUP_ICONS: Record<CategoryGroup, typeof Package> = { vehicles: Truck01, home: Home02, equipment: Package, personal: Package, other: Package };

export const AssetThumb = ({ asset, size = "md" }: { asset: Pick<AssetSummary, "coverFileId" | "group" | "name">; size?: "sm" | "md" | "lg" }) => {
    const Icon = GROUP_ICONS[asset.group];
    const box = size === "sm" ? "size-10" : size === "lg" ? "size-24" : "size-14";
    return asset.coverFileId ? (
        <img
            src={fileUrl(asset.coverFileId, true)}
            alt=""
            loading="lazy"
            className={cx(box, "shrink-0 rounded-lg bg-secondary object-cover ring-1 ring-secondary")}
        />
    ) : (
        <span
            aria-hidden="true"
            className={cx(box, "flex shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-quaternary ring-1 ring-secondary")}
        >
            <Icon className="size-5" />
        </span>
    );
};

// --- Attention ---------------------------------------------------------------------------------------

/** What needs attention, each from a record. */
export const AttentionList = ({ items, empty }: { items: AttentionItem[]; empty?: ReactNode }) => {
    if (!items.length) return <>{empty ?? <p className="px-4 py-3 text-sm text-tertiary sm:px-5">Nothing needs attention.</p>}</>;
    return (
        <ul className="flex flex-col divide-y divide-secondary">
            {items.map((item) => (
                <li key={item.key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    {item.state === "overdue" ? (
                        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-error-secondary" />
                    ) : (
                        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-fg-warning-secondary" />
                    )}
                    <a href={item.url} className="min-w-0 text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                        {item.sentence}
                    </a>
                </li>
            ))}
        </ul>
    );
};

// --- Files -----------------------------------------------------------------------------------------

const toBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};

async function encode(bitmap: ImageBitmap, max: number, quality: number): Promise<ArrayBuffer> {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("That photo couldn't be prepared");
    return blob.arrayBuffer();
}

/**
 * A file ready to upload. Photos are drawn onto a canvas at most 2048 px across and saved as JPEG,
 * with a 480 px preview: much smaller, and without the location and camera details the original
 * carried (the Worker strips any that remain). Documents go as they are, within the size limit.
 */
export async function prepareFile(file: File, kind: UploadBody["kind"]): Promise<Pick<UploadBody, "data" | "thumb" | "filename">> {
    const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml";
    if (isImage && typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(file);
            const [full, thumb] = await Promise.all([encode(bitmap, 2048, 0.85), encode(bitmap, 480, 0.8)]);
            bitmap.close();
            return { data: toBase64(full), thumb: toBase64(thumb), filename: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
        } catch {
            // A format this browser can't draw (HEIC on some browsers): send it as it is; the Worker explains.
        }
    }
    if (kind === "photo" && !isImage) throw new Error("Choose a photo (JPEG, PNG or WebP)");
    if (file.size > LIMITS.maxFileBytes) throw new Error(`Files can be up to ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB`);
    return { data: toBase64(await file.arrayBuffer()), filename: file.name };
}

/** Uploads files one by one, with a toast for each problem. Returns what was stored. */
export function useUploader() {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const upload = async (files: File[], target: Omit<UploadBody, "data" | "thumb" | "filename">) => {
        setBusy(true);
        const stored = [];
        try {
            for (const file of files) {
                try {
                    const prepared = await prepareFile(file, target.kind);
                    const result = await assetsApi.upload({ ...target, ...prepared });
                    if (result.duplicate) toast.success("Already here", `${file.name} was already added.`);
                    else if (result.alsoOn.length) toast.success("Added", `The same file is also on ${result.alsoOn.map((a) => a.name).join(", ")}.`);
                    stored.push(result.file);
                } catch (e) {
                    toast.error(`Couldn't add ${file.name}`, e instanceof Error ? e.message : errorMessage(e));
                }
            }
        } finally {
            setBusy(false);
        }
        return stored;
    };
    return { upload, busy };
}
