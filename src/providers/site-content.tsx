import { type ReactNode, createContext, useContext } from "react";
import { DEFAULT_SITE, type SiteSettings } from "@/shared/site-content";

// The site settings and navigation published from Payload, delivered with each page's data so the
// server render and the browser's hydration use the same values. Outside the public site (the portal)
// the built-in defaults apply.
const SiteContentContext = createContext<SiteSettings>(DEFAULT_SITE);

export const SiteContentProvider = ({ value, children }: { value: SiteSettings | undefined; children: ReactNode }) => (
    <SiteContentContext.Provider value={value ?? DEFAULT_SITE}>{children}</SiteContentContext.Provider>
);

export const useSite = () => useContext(SiteContentContext);
