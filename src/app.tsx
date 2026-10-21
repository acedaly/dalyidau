import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { AboutPage } from "@/pages/about";
import { AmplenotePreviewPage } from "@/pages/amplenote-preview";
import { BlogIndexPage } from "@/pages/blog-index";
import { BlogPostPage } from "@/pages/blog-post";
import { ContactPage } from "@/pages/contact";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";
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
        case "amplenote-preview":
            return <AmplenotePreviewPage />;
        case "about":
            return <AboutPage />;
        case "contact":
            return <ContactPage />;
        default:
            return <NotFoundPage />;
    }
};

export const App = ({ data, path }: PageProps) => (
    <ThemeProvider>
        <a
            href="#main"
            className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary shadow-lg ring-1 ring-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
            Skip to content
        </a>
        <div className="flex min-h-dvh flex-col">
            <SiteHeader path={path} weddingPublished={data.context.weddingPublished} />
            <main id="main" className="flex-1">
                <Page data={data} path={path} />
            </main>
            <SiteFooter />
        </div>
    </ThemeProvider>
);
