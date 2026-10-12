import type { FC, RefAttributes, SVGProps } from "react";

export type Step = {
    /** Bold label naming the step. */
    title: string;
    /** Supporting line rendered directly beneath the title. */
    description: string;
    /**
     * Whether the line running from this step towards the next one is drawn.
     * Inside `Progress.IconsWithText` it is combined with the component-level `connector`, so `false` only ever hides the trailing step's line — every other
     * step keeps its connector — while `true` adds a line after the last step.
     */
    connector?: boolean;
    /**
     * Where the step sits in the flow. "incomplete" renders a muted, low-contrast marker, "current" highlights the marker and its text, and "complete"
     * replaces the marker's dot with a tick and colors the connector leading out of the step.
     */
    status: "incomplete" | "current" | "complete";
};

export type ComponentType = "icon" | "number" | "featured-icon";

export type IconType = FC<SVGProps<SVGSVGElement> & RefAttributes<SVGSVGElement>> & {
    color?: string;
    size?: number;
};

export type ItemsType<T extends ComponentType> = T extends "featured-icon"
    ? Step & {
          /** Icon drawn inside the step's marker. It is required by the "featured-icon" type and ignored by the dot and number markers. */
          icon: IconType;
      }
    : Step & {
          /** Icon drawn inside the step's marker. It is required by the "featured-icon" type and ignored by the dot and number markers. */
          icon?: IconType;
      };

export type ProgressIconType = ItemsType<"icon">;
export type ProgressFeaturedIconType = ItemsType<"featured-icon">;

export interface CommonProps {
    /** The steps to render, in the order they are shown, each carrying its own status. */
    items: ProgressIconType[];
    /** Scale of the step markers and their text. */
    size?: "sm" | "md";
    /** Whether the steps run across in a row or stack into a single column. */
    orientation?: "vertical" | "horizontal";
    /** Additional CSS classes to apply to the wrapper. */
    className?: string;
}

export type StepBaseProps<T extends ComponentType> = {
    /** Scale of the step marker and its text. */
    size?: "sm" | "md";
    /** Marker style of the step. `Progress.IconsWithText` reads it to pick which step variant to render; the step components themselves ignore it. */
    type?: T;
} & ItemsType<T>;

export interface ProgressIconsCenteredProps<T extends ComponentType> extends Omit<CommonProps, "items"> {
    /** Marker style used for every step: a dot-and-tick circle, a numbered circle, or a featured icon. */
    type?: T;
    /** Whether the lines linking the steps are drawn at all. Setting it to false hides every connector and overrides the per-item `connector` values. */
    connector?: boolean;
    /** The steps to render, in the order they are shown. */
    items: ItemsType<T>[];
}

export interface ProgressMinimalIconsProps extends CommonProps {
    /** Whether to prefix the markers with a "Step x of y" counter, where x is the number of items with a "complete" status. */
    text?: boolean;
}
