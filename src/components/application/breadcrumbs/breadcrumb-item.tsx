import { type FC, type ReactNode, isValidElement, useContext } from "react";
import { ChevronRight, SlashDivider } from "@untitledui/icons";
import {
    Breadcrumb as AriaBreadcrumb,
    type BreadcrumbProps as AriaBreadcrumbProps,
    Link as AriaLink,
    type LinkProps as AriaLinkProps,
} from "react-aria-components";
import { type BreadcrumbType, BreadcrumbsContext } from "@/components/application/breadcrumbs/breadcrumbs";
import { Avatar } from "@/components/base/avatar/avatar";
import { cx } from "@/utils/cx";
import { isReactComponent } from "@/utils/is-react-component";

const baseStyles = {
    text: {
        root: "",
        icon: "text-fg-quaternary group-hover:text-fg-quaternary_hover",
        label: "text-quaternary group-hover:text-tertiary_hover",
        current: { root: "", icon: "text-fg-brand-primary group-hover:text-fg-brand-primary", label: "text-brand-secondary group-hover:text-brand-secondary" },
    },
    button: {
        root: "p-1 hover:bg-primary_hover",
        icon: "text-fg-quaternary group-hover:text-fg-quaternary_hover",
        label: "px-1 text-quaternary group-hover:text-tertiary_hover",
        current: { root: "bg-primary_hover", icon: "text-fg-quaternary_hover", label: "text-fg-tertiary_hover" },
    },
};

interface BreadcrumbItemBaseProps extends AriaLinkProps {
    icon?: FC<{ className?: string }> | ReactNode;
    type?: "text" | "button";
    current?: boolean;
    children?: ReactNode;
}

const BreadcrumbBase = ({ href, children, icon: Icon, type = "text", current, className, ...otherProps }: BreadcrumbItemBaseProps) => {
    return (
        <AriaLink
            {...otherProps}
            href={href}
            className={(state) =>
                cx(
                    "group inline-flex items-center justify-center gap-1 rounded-md outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2 in-current:max-w-full",
                    baseStyles[type].root,
                    current && baseStyles[type].current.root,
                    (href || otherProps.onClick) && "cursor-pointer",
                    typeof className === "function" ? className(state) : className,
                )
            }
        >
            {isReactComponent(Icon) && (
                <Icon className={cx("size-5 transition-inherit-all", baseStyles[type].icon, current && baseStyles[type].current.icon)} />
            )}
            {isValidElement(Icon) && Icon}

            {children && (
                <span
                    className={cx(
                        "text-sm font-semibold whitespace-nowrap transition-inherit-all in-current:truncate",
                        baseStyles[type].label,
                        current && baseStyles[type].current.label,
                    )}
                >
                    {children}
                </span>
            )}
        </AriaLink>
    );
};

export interface BreadcrumbItemProps extends AriaBreadcrumbProps {
    /** Destination the item links to. Omit for a non-navigating item. */
    href?: string;
    /** Separator drawn after the item. Defaults to the parent `Breadcrumbs` divider. */
    divider?: "chevron" | "slash";
    /** Visual style of the item. Defaults to the parent `Breadcrumbs` type. */
    type?: BreadcrumbType;
    /** Renders the item as an ellipsis ("...") placeholder that stands in for the collapsed middle items. */
    isEllipsis?: boolean;
    /** The item label. */
    children?: ReactNode;
    /** Additional class name for the item wrapper. */
    className?: string;
    /** Leading icon. Pass as a component reference (e.g. `Home01`) or as an element. */
    icon?: FC<{ className?: string }> | ReactNode;
    /** Avatar image URL. Renders an avatar-in-ring instead of the default icon + label. */
    avatarSrc?: string;
    /** Called when the item is pressed. Also used to expand the collapsed items when `isEllipsis` is set. */
    onClick?: () => void;
}

export const BreadcrumbItem = ({
    href,
    icon,
    divider: dividerProp,
    type: typeProp,
    isEllipsis,
    children,
    onClick,
    avatarSrc,
    className,
    ...otherProps
}: BreadcrumbItemProps) => {
    const context = useContext(BreadcrumbsContext);

    // The parent sets the style for the whole trail, but an individual item may
    // override it — a single slash between two crumbs, say.
    const type = typeProp ?? context.type ?? "text";
    const divider = dividerProp ?? context.divider ?? "chevron";

    return (
        <AriaBreadcrumb
            {...otherProps}
            className={cx(
                "flex items-center current:overflow-hidden",
                avatarSrc ? "gap-1.5 md:gap-2" : type === "text" || type === "text-line" ? "gap-1.5 md:gap-2" : "gap-0.5 md:gap-1",
                className,
            )}
        >
            {({ isCurrent }) => (
                <>
                    {avatarSrc ? (
                        <AriaLink
                            href={href}
                            className={({ isPressed, isFocusVisible }) =>
                                cx(
                                    "flex cursor-pointer items-center gap-1.5 rounded-lg outline-0 outline-offset-2 outline-focus-ring",
                                    (isPressed || isFocusVisible) && "outline-2",
                                )
                            }
                        >
                            <div className="flex rounded-lg bg-primary p-0.5 ring-[0.5px] ring-secondary ring-inset">
                                <Avatar size="xs" src={avatarSrc} className="shadow-md" contentClassName="rounded-md before:hidden" />
                            </div>
                            {children && <span className="text-sm font-semibold text-primary">{children}</span>}
                        </AriaLink>
                    ) : isEllipsis ? (
                        <BreadcrumbBase
                            // The label for screen readers.
                            aria-label="See all breadcrumb items"
                            type={type === "text-line" ? "text" : type}
                            onClick={onClick}
                        >
                            ...
                        </BreadcrumbBase>
                    ) : (
                        <BreadcrumbBase href={href} icon={icon} current={isCurrent} type={type === "text-line" ? "text" : type} onClick={onClick}>
                            {children}
                        </BreadcrumbBase>
                    )}

                    {/* Divider */}
                    {!isCurrent &&
                        (divider === "slash" ? (
                            <SlashDivider className="size-4 shrink-0 stroke-[2.25px] text-utility-neutral-300" />
                        ) : (
                            <ChevronRight className="size-4 shrink-0 stroke-[2.25px] text-utility-neutral-300" />
                        ))}
                </>
            )}
        </AriaBreadcrumb>
    );
};
