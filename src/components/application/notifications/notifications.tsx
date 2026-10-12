import type { FC } from "react";
import { AlertCircle, CheckCircle, InfoCircle } from "@untitledui/icons";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { CloseButton } from "@/components/base/buttons/close-button";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { cx } from "@/utils/cx";

const iconMap = {
    default: InfoCircle,
    brand: InfoCircle,
    gray: InfoCircle,
    error: AlertCircle,
    warning: AlertCircle,
    success: CheckCircle,
};

interface IconNotificationProps {
    /** Bold heading shown at the top of the toast. */
    title: string;
    /** Body text shown under the notification title. */
    description: string;
    /** Label for the primary action button. The button is only rendered when a label is provided. */
    confirmLabel?: string;
    /** Label for the secondary text button that triggers `onClose`. */
    dismissLabel?: string;
    /** Whether to hide the dismiss text button. The close icon button in the top-right corner is always rendered. */
    hideDismissLabel?: boolean;
    /** Icon rendered inside the featured icon. Falls back to an icon picked from `color`: a check circle for success, an alert circle for error and warning, an info circle otherwise. */
    icon?: FC<{ className?: string }>;
    /** Semantic color of the featured icon, which also picks the fallback icon. `default` renders a gray modern featured icon, the rest an outlined one in the matching color. */
    color?: "default" | "brand" | "gray" | "error" | "warning" | "success";
    /** Completion percentage for a progress bar rendered between the text and the actions, labelled "{value}% uploaded...". Omit it to render no progress bar. */
    progress?: number;
    /** Handler called when the close icon button or the dismiss button is pressed. Typically dismisses the toast. */
    onClose?: () => void;
    /** Handler called when the confirm button is pressed. */
    onConfirm?: () => void;
}

export const IconNotification = ({
    title,
    description,
    confirmLabel,
    dismissLabel = "Dismiss",
    hideDismissLabel,
    icon,
    progress,
    onClose,
    onConfirm,
    color = "default",
}: IconNotificationProps) => {
    const showProgress = typeof progress === "number";

    return (
        <div className="relative z-[var(--z-index)] flex max-w-full flex-col gap-4 rounded-xl bg-primary_alt p-4 shadow-lg ring ring-secondary_alt xs:w-[var(--width)] xs:flex-row">
            <FeaturedIcon
                icon={icon || iconMap[color]}
                color={color === "default" ? "gray" : color}
                theme={color === "default" ? "modern" : "outline"}
                size="md"
            />

            <div className={cx("flex flex-1 flex-col gap-3 md:pr-8", color !== "default" && "md:pt-0.5", showProgress && "gap-4")}>
                <div className="flex flex-col gap-1">
                    <p className="text-sm font-semibold text-fg-primary">{title}</p>
                    <p className="text-sm text-fg-secondary">{description}</p>
                </div>

                {showProgress && <ProgressBar labelPosition="bottom" value={progress} valueFormatter={(value) => `${value}% uploaded...`} />}

                <div className="flex gap-3">
                    {!hideDismissLabel && (
                        <Button onClick={onClose} size="sm" color="link-gray">
                            {dismissLabel}
                        </Button>
                    )}
                    {confirmLabel && (
                        <Button onClick={onConfirm} size="sm" color="link-color">
                            {confirmLabel}
                        </Button>
                    )}
                </div>
            </div>

            <div className="absolute top-2 right-2 flex items-center justify-center">
                <CloseButton onClick={onClose} size="sm" label="Dismiss" />
            </div>
        </div>
    );
};

interface AvatarNotificationProps {
    /** Name of the person the notification is from. Shown in bold beside the date and used as the avatar's alt text. */
    name: string;
    /** Message body shown under the name and date. */
    content: string;
    /** Image URL for the sender's avatar, which always renders with an online status dot. */
    avatar: string;
    /** Timestamp shown in muted text next to the sender's name. */
    date: string;
    /** Label for the primary action button. The button is only rendered when a label is provided. */
    confirmLabel: string;
    /** Label for the secondary text button that triggers `onClose`. */
    dismissLabel?: string;
    /** Whether to hide the dismiss text button. The close icon button in the top-right corner is always rendered. */
    hideDismissLabel?: boolean;
    /** Not rendered by this variant, which always shows the sender's avatar in place of an icon. */
    icon?: FC<{ className?: string }>;
    /** Not rendered by this variant, which has no featured icon to color. */
    color?: "default" | "brand" | "gray" | "error" | "warning" | "success";
    /** Handler called when the close icon button or the dismiss button is pressed. Typically dismisses the toast. */
    onClose?: () => void;
    /** Handler called when the confirm button is pressed. */
    onConfirm?: () => void;
}

export const AvatarNotification = ({
    name,
    content,
    avatar,
    confirmLabel,
    dismissLabel = "Dismiss",
    hideDismissLabel,
    date,
    onClose,
    onConfirm,
}: AvatarNotificationProps) => {
    return (
        <div className="relative z-[var(--z-index)] flex max-w-full flex-col items-start gap-4 rounded-xl bg-primary_alt p-4 shadow-lg ring ring-secondary_alt xs:w-[var(--width)] xs:flex-row">
            <Avatar size="md" src={avatar} alt={name} status="online" />

            <div className="flex flex-col gap-3 pr-8">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-fg-primary">{name}</p>
                        <span className="text-sm text-fg-quaternary">{date}</span>
                    </div>
                    <p className="text-sm text-fg-secondary">{content}</p>
                </div>

                <div className="flex gap-3">
                    {!hideDismissLabel && (
                        <Button onClick={onClose} size="sm" color="link-gray">
                            {dismissLabel}
                        </Button>
                    )}
                    {confirmLabel && (
                        <Button onClick={onConfirm} size="sm" color="link-color">
                            {confirmLabel}
                        </Button>
                    )}
                </div>
            </div>

            <div className="absolute top-2 right-2 flex items-center justify-center">
                <CloseButton onClick={onClose} size="sm" label="Dismiss" />
            </div>
        </div>
    );
};

interface ImageNotificationProps {
    /** Bold heading shown at the top of the toast. */
    title: string;
    /** Body text shown under the notification title. */
    description: string;
    /** Label for the primary action button. The button is only rendered when a label is provided. */
    confirmLabel: string;
    /** Label for the secondary text button that triggers `onClose`. */
    dismissLabel?: string;
    /** Whether to hide the dismiss text button. The close icon button in the top-right corner is always rendered. */
    hideDismissLabel?: boolean;
    /** Image source for the tall thumbnail in the left column, which is only shown from the `md` breakpoint up. */
    imageMobile: string;
    /** Image source for the wide banner above the action buttons, which is only shown below the `md` breakpoint. */
    imageDesktop: string;
    /** Handler called when the close icon button or the dismiss button is pressed. Typically dismisses the toast. */
    onClose?: () => void;
    /** Handler called when the confirm button is pressed. */
    onConfirm?: () => void;
}

export const ImageNotification = ({
    title,
    description,
    confirmLabel,
    dismissLabel = "Dismiss",
    hideDismissLabel,
    imageMobile,
    imageDesktop,
    onClose,
    onConfirm,
}: ImageNotificationProps) => {
    return (
        <div
            style={
                {
                    "--width": "496px",
                } as React.CSSProperties
            }
            className="relative z-[var(--z-index)] flex max-w-full flex-col gap-3 rounded-xl bg-primary_alt p-4 shadow-lg max-md:ring-1 max-md:ring-secondary_alt xs:w-[var(--width)] xs:flex-row xs:gap-0 md:p-0"
        >
            <div className="-my-px hidden w-40 shrink-0 overflow-hidden rounded-l-xl outline-1 -outline-offset-1 outline-black/10 md:block">
                <img aria-hidden="true" src={imageMobile} alt="Image Mobile" className="size-full object-cover" />
            </div>

            <div className="flex flex-col gap-4 rounded-r-xl bg-primary_alt md:gap-3 md:p-4 md:pl-5 md:ring-1 md:ring-secondary_alt">
                <div className="flex flex-col gap-1 pr-8">
                    <p className="text-sm font-semibold text-fg-primary">{title}</p>
                    <p className="text-sm text-fg-secondary">{description}</p>
                </div>

                <div className="h-40 w-full overflow-hidden rounded-md bg-secondary md:hidden">
                    <img src={imageDesktop} alt="Image Desktop" className="size-full object-cover" />
                </div>

                <div className="flex gap-3">
                    {!hideDismissLabel && (
                        <Button onClick={onClose} size="sm" color="link-gray">
                            {dismissLabel}
                        </Button>
                    )}
                    {confirmLabel && (
                        <Button onClick={onConfirm} size="sm" color="link-color">
                            {confirmLabel}
                        </Button>
                    )}
                </div>
            </div>

            <div className="absolute top-2 right-2 flex items-center justify-center">
                <CloseButton onClick={onClose} size="sm" label="Dismiss" />
            </div>
        </div>
    );
};
