import { type ReactNode, createContext, useContext } from "react";

// Which design the public page uses, and the private preview's address prefix (Phase 4). The preview
// (/portal/preview) shows the projects-first pages before they're switched on; links between those pages
// keep the prefix, links elsewhere (the blog, About) go to the live site.
interface SiteFrame {
    projects: boolean;
    base: string;
}

const SiteFrameContext = createContext<SiteFrame>({ projects: false, base: "" });

export const SiteFrameProvider = ({ projects, base, children }: SiteFrame & { children: ReactNode }) => (
    <SiteFrameContext.Provider value={{ projects, base }}>{children}</SiteFrameContext.Provider>
);

export const useSiteFrame = () => useContext(SiteFrameContext);

/** A link to one of the redesigned pages (/, /projects, /projects/<slug>), inside the preview when previewing. */
export const usePreviewHref = () => {
    const { base } = useSiteFrame();
    return (path: string) => {
        if (!base) return path;
        if (path === "/") return base;
        if (path === "/projects" || path.startsWith("/projects/")) return `${base}${path}`;
        return path;
    };
};
