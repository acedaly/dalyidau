import { Moon01, Sun } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { useTheme } from "@/providers/theme-provider";
import { cx } from "@/utils/cx";

/**
 * Switches between light and dark. Both icons are rendered and CSS picks one, so the server
 * markup never depends on the visitor's stored preference.
 */
export const ThemeToggle = ({ className }: { className?: string }) => {
    const { setTheme } = useTheme();

    const toggle = () => {
        const isDark = document.documentElement.classList.contains("dark-mode");
        setTheme(isDark ? "light" : "dark");
    };

    return (
        <AriaButton
            onPress={toggle}
            aria-label="Toggle dark mode"
            className={cx(
                "inline-flex size-10 cursor-pointer items-center justify-center rounded-lg text-fg-quaternary outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2",
                className,
            )}
        >
            <Moon01 aria-hidden="true" className="size-5 dark:hidden" />
            <Sun aria-hidden="true" className="hidden size-5 dark:block" />
        </AriaButton>
    );
};
