// Adding or editing an account. Only a name and a type are needed. The starting balance is the
// balance before the first transaction you'll import (on a date); without it the balance shows as
// unknown, never $0. No full account numbers: at most the last four digits, to tell cards apart.
import { useState } from "react";
import { Bank } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { centsToDecimal, parseInputCents } from "@/shared/finance/money";
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABELS, type AccountKind, type AccountView, LIABILITY_KINDS } from "@/shared/finance/types";
import { clientKey, financeApi } from "./finance-api";

export const AccountDialog = ({ account, onClose, onSaved }: { account?: AccountView; onClose: () => void; onSaved: (account: AccountView) => void }) => {
    const toast = useToast();
    const editing = !!account;
    const owner = !account || account.mine;
    const [name, setName] = useState(account?.name ?? "");
    const [institution, setInstitution] = useState(account?.institution ?? "NAB");
    const [kind, setKind] = useState<AccountKind>(account?.kind ?? "transaction");
    const [hint, setHint] = useState(account?.numberHint ?? "");
    const [opening, setOpening] = useState(account?.openingBalanceCents != null ? centsToDecimal(account.openingBalanceCents) : "");
    const [openingOn, setOpeningOn] = useState<string | null>(account?.openingBalanceOn ?? null);
    const [shared, setShared] = useState(account ? account.visibility === "shared" : true);
    const [archived, setArchived] = useState(account?.archived ?? false);
    const [key] = useState(clientKey);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const openingCents = opening.trim() ? parseInputCents(opening) : null;
    const openingInvalid = opening.trim() !== "" && openingCents === null;

    const submit = async () => {
        setError(null);
        if (!name.trim()) return setError(new ApiError(422, "validation", "Give the account a name", [{ path: "name", message: "Give the account a name" }]));
        if (openingInvalid) return;
        if ((openingCents === null) !== (openingOn === null))
            return setError(new ApiError(422, "validation", "A starting balance needs its date, and a date needs the balance"));
        setBusy(true);
        try {
            const common = { name: name.trim(), institution: institution.trim() || null, kind, numberHint: hint.trim() || null };
            const managed = { openingBalanceCents: openingCents, openingBalanceOn: openingOn, visibility: shared ? "shared" : "private" };
            const result = editing
                ? await financeApi.updateAccount(account.id, { version: account.version, ...common, ...(owner ? { ...managed, archived } : {}) })
                : await financeApi.createAccount({ ...common, ...managed, clientId: key });
            toast.success(editing ? "Saved" : "Account added");
            onSaved(result.account);
        } catch (e) {
            if (e instanceof ApiError) setError(e);
            else toast.error("Couldn't save", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            title={editing ? `Edit ${account.name}` : "Add an account"}
            description={editing ? undefined : "Only a name and a type are needed. Never enter a full account number or banking password: they aren't needed."}
            icon={Bank}
            size="lg"
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} showTextWhileLoading>
                        {editing ? "Save" : "Add account"}
                    </Button>
                </>
            }
        >
            <FormError message={error && !error.issues.length ? error.message : null} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                    label="Name"
                    value={name}
                    onChange={setName}
                    isRequired
                    placeholder="Everyday"
                    isInvalid={!!error?.issueFor("name")}
                    hint={error?.issueFor("name")}
                />
                <Input label="Bank or provider" value={institution} onChange={setInstitution} placeholder="NAB" />
                <NativeSelect
                    label="Type"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as AccountKind)}
                    options={ACCOUNT_KINDS.map((k) => ({ label: ACCOUNT_KIND_LABELS[k], value: k }))}
                />
                <Input
                    label="Last digits (optional)"
                    value={hint}
                    onChange={(v) => setHint(v.replace(/\D/g, "").slice(0, 4))}
                    inputMode="numeric"
                    hint="Up to four. Used to check a file is for this account."
                    isInvalid={!!error?.issueFor("numberHint")}
                />
            </div>
            {owner ? (
                <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label="Starting balance"
                            value={opening}
                            onChange={setOpening}
                            inputMode="decimal"
                            placeholder={LIABILITY_KINDS.has(kind) ? "-1200.00" : "2500.00"}
                            isInvalid={openingInvalid}
                            hint={
                                LIABILITY_KINDS.has(kind) ? "Money owed is negative, e.g. -1200.00." : "The balance before the first transaction you'll import."
                            }
                        />
                        <DateField
                            label="Balance on"
                            value={openingOn}
                            onChange={setOpeningOn}
                            hint="Transactions on or after this date count towards the balance."
                        />
                    </div>
                    <Toggle
                        className="w-full"
                        label="Shared with the household"
                        hint="Both of us can see it and its transactions, categorise and import. Private accounts are only yours, everywhere: overview, totals, search and export."
                        isSelected={shared}
                        onChange={setShared}
                    />
                    {editing && (
                        <Toggle
                            className="w-full"
                            label="Archived"
                            hint="Hidden from balances and new imports. Its history stays."
                            isSelected={archived}
                            onChange={setArchived}
                        />
                    )}
                </>
            ) : (
                <p className="text-sm text-tertiary">
                    Only {account?.ownerName ?? "the account's owner"} can change its starting balance, sharing or archive it.
                </p>
            )}
        </PortalDialog>
    );
};
