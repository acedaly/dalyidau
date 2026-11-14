import { type ReactNode, createContext, useContext } from "react";
import { variantSrcSet } from "@/shared/image-variants";

// Which design the public page uses, and the private preview's address prefix (Phase 4). The preview
// (/portal/preview) shows the projects-first pages before they're switched on; links between those pages
// keep the prefix, links elsewhere (the blog, About) go to the live site.
interface SiteFrame {
    projects: boolean;
    base: string;
    /** The site makes smaller copies of its images; components offer them in `srcset`. */
    imageVariants?: boolean;
}

const SiteFrameContext = createContext<SiteFrame>({ projects: false, base: "" });

export const SiteFrameProvider = ({ projects, base, imageVariants, children }: SiteFrame & { children: ReactNode }) => (
    <SiteFrameContext.Provider value={{ projects, base, imageVariants }}>{children}</SiteFrameContext.Provider>
);

/** The `srcset` for one of the site's images, when smaller copies are on offer (undefined otherwise). */
export const useImageSrcSet = () => {
    const { imageVariants } = useSiteFrame();
    return (image: { src: string; width?: number | null } | null | undefined) => (imageVariants && image ? variantSrcSet(image.src, image.width) : undefined);
};

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
