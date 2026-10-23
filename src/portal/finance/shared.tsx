// Pieces every Household Finance page shares: the header, amounts (money in and out, never a bare
// "$0" for something unknown), balance badges that say how sure we are, account and category
// labels, and the category picker.
import type { ReactNode } from "react";
import { Lock01, Plus, Upload01, Users01 } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { PageHeader } from "@/portal/components/page-header";
import { formatDate } from "@/portal/lib/format";
import { CATEGORY_GROUPS, type CategoryDef } from "@/shared/finance/categories";
import type { BalanceView } from "@/shared/finance/ledger";
import { formatAud } from "@/shared/finance/money";
import { ACCOUNT_KIND_LABELS, type AccountKind, BALANCE_STATUS_LABELS, LIABILITY_KINDS } from "@/shared/finance/types";
import { cx } from "@/utils/cx";

export const FINANCE = "/portal/finance";
export const accountHref = (id: string) => `${FINANCE}/accounts/${id}`;
export const importHref = (id: string) => `${FINANCE}/import/${id}`;

export const FinanceHeader = ({
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
        breadcrumbs={[{ label: "Household Finance", href: FINANCE }, ...crumbs]}
        actions={
            actions ?? (
                <>
                    <Button size="sm" color="secondary" iconLeading={Plus} href={`${FINANCE}/accounts?new=1`}>
                        Add account
                    </Button>
                    <Button size="sm" iconLeading={Upload01} href={`${FINANCE}/import`}>
                        Import transactions
                    </Button>
                </>
            )
        }
    >
        {children}
    </PageHeader>
);

export const shortDate = (date: string | null | undefined) => (date ? formatDate(date, { day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * A signed amount: money in with a plus, money out with a minus. Told apart by the sign, not colour
 * (the success green is too light for small text).
 */
export const Amount = ({ cents, className, whole }: { cents: number; className?: string; whole?: boolean }) => (
    <span className={cx("whitespace-nowrap text-primary tabular-nums", className)}>{formatAud(cents, { signed: true, whole })}</span>
);

/** A balance, or "No starting balance" when it can't be known. A liability shows what's owed. */
export const BalanceAmount = ({ balance, kind, className }: { balance: BalanceView; kind: AccountKind; className?: string }) => {
    if (balance.balanceCents === null) return <span className={cx("text-tertiary", className)}>Not known yet</span>;
    const owed = LIABILITY_KINDS.has(kind) && balance.balanceCents < 0;
    return (
        <span className={cx("tabular-nums", className)}>
            {formatAud(owed ? -balance.balanceCents : balance.balanceCents)}
            {owed && <span className="ml-1 text-sm font-normal text-tertiary">owed</span>}
        </span>
    );
};

const STATUS_COLORS: Record<BalanceView["status"], "success" | "gray" | "warning" | "error" | "brand"> = {
    matches_bank: "success",
    reconciled: "success",
    calculated: "gray",
    incomplete: "warning",
    mismatch: "error",
};

/** How sure we are of a balance, in words, with the date and the difference where there was a check. */
export const balanceExplanation = (balance: BalanceView) => {
    switch (balance.status) {
        case "incomplete":
            return "Add a starting balance to work out the balance.";
        case "calculated":
            return "Worked out from the starting balance and imported transactions. Not yet checked against the bank.";
        case "matches_bank":
            return `Matches the bank's balance on ${shortDate(balance.checkedOn)}.`;
        case "reconciled":
            return `Matches the statement on ${shortDate(balance.checkedOn)}.`;
        case "mismatch":
            return `${formatAud(Math.abs(balance.differenceCents ?? 0))} ${(balance.differenceCents ?? 0) > 0 ? "less" : "more"} than the ${balance.checkedAgainst === "statement" ? "statement" : "bank's balance"} on ${shortDate(balance.checkedOn)}. Check for missing or excluded transactions.`;
    }
};

export const BalanceBadge = ({ balance }: { balance: BalanceView }) => (
    <BadgeWithDot size="sm" type="modern" color={STATUS_COLORS[balance.status]}>
        {BALANCE_STATUS_LABELS[balance.status]}
    </BadgeWithDot>
);

export const VisibilityBadge = ({ visibility }: { visibility: "private" | "shared" }) =>
    visibility === "shared" ? (
        <Badge size="sm" type="modern" color="gray">
            <Users01 className="mr-1 size-3" aria-hidden="true" />
            Shared
        </Badge>
    ) : (
        <Badge size="sm" type="modern" color="gray">
            <Lock01 className="mr-1 size-3" aria-hidden="true" />
            Private
        </Badge>
    );

export const kindLabel = (kind: AccountKind) => ACCOUNT_KIND_LABELS[kind];

export const categoryName = (categories: readonly CategoryDef[], id: string | null) =>
    id ? (categories.find((c) => c.id === id)?.name ?? "Unknown category") : "Uncategorised";

/** Category options grouped by their group, with uncategorised (and optionally "any") first. */
export const categoryOptions = (categories: readonly CategoryDef[], options: { current?: string | null; any?: string } = {}) => {
    const list: { label: string; value: string; disabled?: boolean }[] = [];
    if (options.any) list.push({ label: options.any, value: "" });
    else list.push({ label: "Uncategorised", value: "" });
    for (const group of CATEGORY_GROUPS) {
        const inGroup = categories.filter((c) => c.groupId === group.id && (!c.archived || c.id === options.current));
        for (const c of inGroup) list.push({ label: `${group.name} · ${c.name}${c.archived ? " (archived)" : ""}`, value: c.id });
    }
    return list;
};

const NONE = "__uncategorised";

/**
 * Picks a category. React Aria's Select (not NativeSelect, which overrides aria-label), so it can
 * sit unlabelled in a table row with an accessible name.
 */
export const CategorySelect = ({
    categories,
    value,
    onChange,
    label,
    ariaLabel,
    isDisabled,
    size = "sm",
}: {
    categories: readonly CategoryDef[];
    value: string | null;
    onChange: (id: string | null) => void;
    label?: string;
    ariaLabel?: string;
    isDisabled?: boolean;
    size?: "sm" | "md";
}) => {
    const items = categoryOptions(categories, { current: value }).map((o) => ({ id: o.value || NONE, label: o.label }));
    return (
        <Select
            label={label}
            aria-label={label ? undefined : ariaLabel}
            size={size}
            items={items}
            value={value ?? NONE}
            isDisabled={isDisabled}
            onChange={(key) => key !== null && onChange(key === NONE ? null : String(key))}
            popoverClassName="min-w-72"
        >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );
};
