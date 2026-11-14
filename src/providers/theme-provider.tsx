import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
    theme: Theme;
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = (): ThemeContextType => {
    const context = useContext(ThemeContext);

    if (context === undefined) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }

    return context;
};

interface ThemeProviderProps {
    children: ReactNode;
    /**
     * The class to add to the root element when the theme is dark
     * @default "dark-mode"
     */
    darkModeClass?: string;
    /**
     * The default theme to use if no theme is stored in localStorage
     * @default "system"
     */
    defaultTheme?: Theme;
    /**
     * The key to use to store the theme in localStorage
     * @default "ui-theme"
     */
    storageKey?: string;
}

// Storage can be unavailable or refuse (private windows, blocked site data): the theme then simply isn't remembered.
const readStored = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
const writeStored = (key: string, value: string | null) => {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // Not remembered; nothing else depends on it.
    }
};

/**
 * The browser's own chrome (the address bar on a phone) takes its colour from two <meta name="theme-color">
 * tags, one per device colour scheme. When the visitor picks a theme by hand, both are given that theme's
 * colour; when they go back to following the device, each gets its own again.
 */
const syncThemeColor = (theme: Theme) => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    for (const meta of metas) if (!meta.dataset.content) meta.dataset.content = meta.content;
    const chosen = theme === "system" ? null : metas.find((meta) => meta.media.includes(theme));
    for (const meta of metas) meta.content = (chosen ?? meta).dataset.content ?? meta.content;
};

export const ThemeProvider = ({ children, defaultTheme = "system", storageKey = "ui-theme", darkModeClass = "dark-mode" }: ThemeProviderProps) => {
    const [theme, setTheme] = useState<Theme>(() => {
        // Only a theme this site wrote is honoured; anything else (or storage that can't be read) follows the device.
        const saved = typeof window === "undefined" ? null : readStored(storageKey);
        return saved === "light" || saved === "dark" ? saved : defaultTheme;
    });

    useEffect(() => {
        const applyTheme = () => {
            const root = window.document.documentElement;

            if (theme === "system") {
                const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

                root.classList.toggle(darkModeClass, systemTheme === "dark");
                writeStored(storageKey, null);
            } else {
                root.classList.toggle(darkModeClass, theme === "dark");
                writeStored(storageKey, theme);
            }
        };

        applyTheme();
        syncThemeColor(theme);

        // Listen for system theme changes
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

        const handleChange = () => {
            if (theme === "system") {
                applyTheme();
            }
        };

        mediaQuery.addEventListener("change", handleChange);
        return () => mediaQuery.removeEventListener("change", handleChange);
    }, [theme]);

    return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
};
