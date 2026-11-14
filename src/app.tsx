import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { CmsPage } from "@/pages/about";
import { BlogIndexPage } from "@/pages/blog-index";
import { BlogPostPage } from "@/pages/blog-post";
import { ContactPage } from "@/pages/contact";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";
import { ProjectPage } from "@/pages/project-page";
import { ProjectsHomePage } from "@/pages/projects-home";
import { ProjectsIndexPage } from "@/pages/projects-index";
import { SiteContentProvider } from "@/providers/site-content";
import { SiteFrameProvider } from "@/providers/site-frame";
import { ThemeProvider } from "@/providers/theme-provider";
import type { PageProps } from "@/shared/types";

const Page = ({ data }: PageProps) => {
    switch (data.route) {
        case "home":
            return <HomePage data={data} />;
        case "blog":
            return <BlogIndexPage data={data} />;
        case "post":
            return <BlogPostPage data={data} />;
        case "page":
            return <CmsPage page={data.page} />;
        case "projects-home":
            return <ProjectsHomePage data={data} />;
        case "projects":
            return <ProjectsIndexPage data={data} />;
        case "project":
            return <ProjectPage data={data} />;
        case "contact":
            return <ContactPage />;
        default:
            return <NotFoundPage />;
    }
};

export const App = ({ data, path }: PageProps) => (
    <SiteContentProvider value={data.context.site}>
        <SiteFrameProvider projects={data.context.design === "projects"} base={data.context.base ?? ""}>
            <ThemeProvider>
                <a
                    href="#main"
                    className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary shadow-lg ring-1 ring-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
                >
                    Skip to content
                </a>
                {data.context.preview && (
                    <p role="status" className="bg-warning-secondary px-4 py-2 text-center text-sm font-medium text-primary">
                        Draft preview: only you can see this.{" "}
                        {data.context.preview.published ? "The published page stays as it is until you publish." : "It isn’t on the website yet."}
                    </p>
                )}
                <div className="flex min-h-dvh flex-col">
                    <SiteHeader path={path} weddingPublished={data.context.weddingPublished} />
                    <main id="main" className="flex-1">
                        <Page data={data} path={path} />
                    </main>
                    <SiteFooter />
                </div>
            </ThemeProvider>
        </SiteFrameProvider>
    </SiteContentProvider>
);
