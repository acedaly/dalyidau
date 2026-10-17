// The pop-up list for "/" commands and "[[" links, styled like Untitled UI's dropdown menus. Tiptap's
// suggestion plugin owns when it opens and where it sits (props.mount); this renders the list and
// handles the keyboard.
import type { FC, HTMLAttributes, Ref } from "react";
import { useEffect, useImperativeHandle, useState } from "react";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { cx } from "@/utils/cx";

export interface MenuItem {
    id: string;
    title: string;
    hint?: string;
    icon?: FC<HTMLAttributes<HTMLOrSVGElement>>;
}

interface ListHandle {
    onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

interface ListProps extends SuggestionProps<MenuItem, MenuItem> {
    label: string;
    empty: string;
    ref?: Ref<ListHandle>;
}

const SuggestionList = ({ items, command, label, empty, loading, ref }: ListProps) => {
    const [index, setIndex] = useState(0);
    useEffect(() => setIndex(0), [items]);

    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }) => {
            if (event.key === "ArrowDown") {
                setIndex((i) => (items.length ? (i + 1) % items.length : 0));
                return true;
            }
            if (event.key === "ArrowUp") {
                setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                if (!items[index]) return false;
                command(items[index]);
                return true;
            }
            return false;
        },
    }));

    return (
        <div
            role="listbox"
            aria-label={label}
            className="z-50 max-h-80 w-72 overflow-y-auto rounded-lg bg-primary py-1 shadow-lg ring-1 ring-secondary_alt outline-hidden"
        >
            {items.length === 0 ? (
                <p className="px-3.5 py-2 text-sm text-tertiary">{loading ? "Searching…" : empty}</p>
            ) : (
                items.map((item, i) => {
                    const Icon = item.icon;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            role="option"
                            aria-selected={i === index}
                            // Keep focus in the editor; choosing must not blur it.
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => command(item)}
                            // Movement, not mouseenter: a list that opens under a resting pointer mustn't change the choice.
                            onMouseMove={() => i !== index && setIndex(i)}
                            className={cx(
                                "mx-1.5 flex w-[calc(100%-0.75rem)] cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition duration-100 ease-linear",
                                i === index ? "bg-primary_hover" : "",
                            )}
                        >
                            {Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />}
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-secondary">{item.title}</span>
                                {item.hint && <span className="block truncate text-xs text-tertiary">{item.hint}</span>}
                            </span>
                        </button>
                    );
                })
            )}
        </div>
    );
};

/** The suggestion plugin's render() for a list labelled `label`. */
export const renderSuggestionList =
    (label: string, empty: string): NonNullable<SuggestionOptions<MenuItem, MenuItem>["render"]> =>
    () => {
        let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
        let unmount: (() => void) | null = null;
        return {
            onStart: (props) => {
                renderer = new ReactRenderer(SuggestionList, { props: { ...props, label, empty }, editor: props.editor });
                unmount = props.mount(renderer.element as HTMLElement);
            },
            onUpdate: (props) => renderer?.updateProps({ ...props, label, empty }),
            onKeyDown: (props) => {
                if (props.event.key === "Escape") {
                    unmount?.();
                    unmount = null;
                    return true;
                }
                return renderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
                unmount?.();
                renderer?.destroy();
                renderer = null;
                unmount = null;
            },
        };
    };
