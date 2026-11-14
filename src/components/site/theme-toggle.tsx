import { useEffect, useId, useState } from "react";
import { Monitor01, Moon01, Sun } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { useTheme } from "@/providers/theme-provider";
import { cx } from "@/utils/cx";

type Theme = "system" | "light" | "dark";
/**
 * The next theme: from following the device, to the opposite of what it shows now (so the first press always
 * changes something), then to the other one, then back to following the device.
 */
const next = (theme: Theme, deviceIsDark: boolean): Theme => {
    const same = deviceIsDark ? "dark" : "light";
    const opposite = deviceIsDark ? "light" : "dark";
    return theme === "system" ? opposite : theme === opposite ? same : "system";
};
const NAME = { system: "Following your device", light: "Light", dark: "Dark" } as const;

/**
 * Cycles the theme: follow the device, light, dark, and back to following the device (before, a visitor who
 * had picked one could never return to it). Until the page is interactive the sun and moon are both in the
 * markup and CSS picks one, so the server's HTML never depends on the visitor's stored preference.
 */
export const ThemeToggle = ({ className }: { className?: string }) => {
    const { theme, setTheme } = useTheme();
    const id = useId();
    const [ready, setReady] = useState(false);
    const [deviceIsDark, setDeviceIsDark] = useState(false);
    useEffect(() => {
        const query = window.matchMedia("(prefers-color-scheme: dark)");
        const update = () => setDeviceIsDark(query.matches);
        update();
        setReady(true);
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    const upcoming = next(theme, deviceIsDark);

    // A name that stays the same (voice control, and screen readers that don't re-read a changed name), with
    // the state and what the next press does as its description, announced politely when it changes.
    return (
        <>
            <AriaButton
                onPress={() => setTheme(upcoming)}
                aria-label="Theme"
                aria-describedby={ready ? id : undefined}
                className={cx(
                    "inline-flex size-10 cursor-pointer items-center justify-center rounded-lg text-fg-quaternary outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2",
                    className,
                )}
            >
                {ready && theme === "system" ? (
                    <Monitor01 aria-hidden="true" className="size-5" />
                ) : (
                    <>
                        <Moon01 aria-hidden="true" className="size-5 dark:hidden" />
                        <Sun aria-hidden="true" className="hidden size-5 dark:block" />
                    </>
                )}
            </AriaButton>
            <span id={id} role="status" className="sr-only">
                {ready ? `${NAME[theme]}. Press to switch to ${NAME[upcoming].toLowerCase()}.` : ""}
            </span>
        </>
    );
};
