// Modal dialogs in Untitled UI's layout (featured icon, title, supporting text, actions), built on
// the PRO modal primitives. Controlled: pass isOpen and onOpenChange.
import type { FC, FormEvent, ReactNode } from "react";
import { useState } from "react";
import { AlertTriangle } from "@untitledui/icons";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { CloseButton } from "@/components/base/buttons/close-button";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { cx } from "@/utils/cx";

interface PortalDialogProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: ReactNode;
    icon?: FC<{ className?: string }>;
    iconColor?: "brand" | "gray" | "error" | "warning" | "success";
    children?: ReactNode;
    footer?: ReactNode;
    size?: "sm" | "md" | "lg" | "xl";
    /** When set, the body is a form and Enter submits it. */
    onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}

const widths = { sm: "sm:max-w-100", md: "sm:max-w-136", lg: "sm:max-w-180", xl: "sm:max-w-240" };

export const PortalDialog = ({
    isOpen,
    onOpenChange,
    title,
    description,
    icon,
    iconColor = "brand",
    children,
    footer,
    size = "md",
    onSubmit,
}: PortalDialogProps) => {
    const body = (
        <>
            <div className="relative flex flex-col gap-4 px-4 pt-5 sm:px-6 sm:pt-6">
                {icon && <FeaturedIcon icon={icon} color={iconColor} theme="light" size="lg" />}
                <div className="flex flex-col gap-1 pr-8">
                    <h2 className="text-md font-semibold text-primary" slot="title">
                        {title}
                    </h2>
                    {description && <div className="text-sm text-tertiary">{description}</div>}
                </div>
                <CloseButton size="lg" className="absolute top-3 right-3" onClick={() => onOpenChange(false)} label="Close" />
            </div>
            {children && <div className="flex flex-col gap-4 px-4 pt-5 sm:px-6">{children}</div>}
            {footer && <div className="flex flex-col-reverse gap-3 p-4 pt-6 sm:flex-row sm:justify-end sm:px-6 sm:pt-8 sm:pb-6">{footer}</div>}
        </>
    );

    return (
        <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
            <Modal className={cx(widths[size])}>
                <Dialog aria-label={title}>
                    {onSubmit ? (
                        <form
                            noValidate
                            className="w-full"
                            onSubmit={(event) => {
                                event.preventDefault();
                                onSubmit(event);
                            }}
                        >
                            {body}
                        </form>
                    ) : (
                        <div className="w-full">{body}</div>
                    )}
                </Dialog>
            </Modal>
        </ModalOverlay>
    );
};

interface ConfirmDialogProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => Promise<void> | void;
}

/** Confirmation for destructive or irreversible actions. Stays open with a spinner while working. */
export const ConfirmDialog = ({ isOpen, onOpenChange, title, description, confirmLabel, destructive = false, onConfirm }: ConfirmDialogProps) => {
    const [busy, setBusy] = useState(false);
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={(open) => !busy && onOpenChange(open)}
            title={title}
            description={description}
            icon={AlertTriangle}
            iconColor={destructive ? "error" : "warning"}
            size="sm"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        color={destructive ? "primary-destructive" : "primary"}
                        size="lg"
                        isLoading={busy}
                        showTextWhileLoading
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await onConfirm();
                                onOpenChange(false);
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        />
    );
};
