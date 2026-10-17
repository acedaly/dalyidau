// Choose an object in the same space by typing part of its title. Untitled UI's ComboBox, fed by
// the space's lookup endpoint.
import type { Key } from "react";
import { useEffect, useRef, useState } from "react";
import { Select } from "@/components/base/select/select";
import type { KnowledgeType } from "@/shared/knowledge/types";
import { TYPE_ICON_COMPONENTS, knowledgeApi, titleOf } from "./shared";

interface ObjectPickerProps {
    spaceId: string;
    types: KnowledgeType[];
    label?: string;
    placeholder?: string;
    /** Only offer objects of these types. */
    typeIds?: string[] | null;
    /** Ids not to offer (already chosen, or the object itself). */
    exclude?: string[];
    onPick: (object: { id: string; title: string; typeId: string }) => void;
    size?: "sm" | "md";
    isDisabled?: boolean;
}

export const ObjectPicker = ({
    spaceId,
    types,
    label,
    placeholder = "Search by title",
    typeIds,
    exclude = [],
    onPick,
    size = "sm",
    isDisabled,
}: ObjectPickerProps) => {
    const [input, setInput] = useState("");
    const [results, setResults] = useState<{ id: string; title: string; typeId: string }[]>([]);
    const latest = useRef(0);
    const picker = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const request = ++latest.current;
        const timer = window.setTimeout(() => {
            knowledgeApi
                .lookup(spaceId, input)
                .then(({ results: found }) => {
                    if (request === latest.current) setResults(found);
                })
                .catch(() => undefined);
        }, 150);
        return () => window.clearTimeout(timer);
    }, [spaceId, input]);

    const items = results
        .filter((r) => !exclude.includes(r.id) && (!typeIds || typeIds.includes(r.typeId)))
        .map((r) => {
            const type = types.find((t) => t.id === r.typeId);
            return { id: r.id, label: titleOf(r.title), supportingText: type?.name, icon: TYPE_ICON_COMPONENTS[type?.icon ?? "file"] };
        });

    const pick = (key: Key | null) => {
        const found = results.find((r) => r.id === key);
        if (!found) return;
        onPick(found);
        setInput("");
        // This is an action picker, not a persistent selected value. Close it after the action so
        // the now-empty focus-triggered popover does not leave the rest of the page inert.
        window.requestAnimationFrame(() => picker.current?.querySelector("input")?.blur());
    };

    return (
        <Select.ComboBox
            ref={picker}
            aria-label={label ? undefined : placeholder}
            label={label}
            size={size}
            shortcut={false}
            placeholder={placeholder}
            inputValue={input}
            onInputChange={setInput}
            onSelectionChange={pick}
            selectedKey={null}
            items={items}
            isDisabled={isDisabled}
            allowsEmptyCollection
        >
            {(item) => (
                <Select.Item id={item.id} supportingText={item.supportingText} icon={item.icon}>
                    {item.label}
                </Select.Item>
            )}
        </Select.ComboBox>
    );
};
