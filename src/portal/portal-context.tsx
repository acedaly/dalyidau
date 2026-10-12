import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { FlagKey, Flags } from "@/shared/portal/flags";
import type { Permission } from "@/shared/portal/permissions";
import type { PortalContext as PortalContextData, Side, WeddingDetails } from "@/shared/portal/types";

interface PortalContextValue extends PortalContextData {
    can: (permission: Permission) => boolean;
    isOn: (flag: FlagKey) => boolean;
    setFlags: (flags: Flags) => void;
    setWedding: (wedding: WeddingDetails) => void;
    sideLabel: (side: Side) => string;
}

const Context = createContext<PortalContextValue | null>(null);

export const PortalProvider = ({ value, children }: { value: PortalContextData; children: ReactNode }) => {
    const [flags, setFlags] = useState(value.flags);
    const [wedding, setWedding] = useState(value.wedding);
    const can = useCallback((permission: Permission) => value.user.permissions.includes(permission), [value.user]);
    const isOn = useCallback((flag: FlagKey) => flags[flag], [flags]);
    const sideLabel = useCallback(
        (side: Side) => (side === "partner_one" ? wedding.partnerOne : side === "partner_two" ? wedding.partnerTwo : "Both"),
        [wedding],
    );
    const context = useMemo(() => ({ ...value, flags, wedding, can, isOn, setFlags, setWedding, sideLabel }), [value, flags, wedding, can, isOn, sideLabel]);
    return <Context.Provider value={context}>{children}</Context.Provider>;
};

export const usePortal = () => {
    const context = useContext(Context);
    if (!context) throw new Error("usePortal must be used inside PortalProvider");
    return context;
};
