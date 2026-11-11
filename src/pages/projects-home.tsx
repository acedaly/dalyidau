import { ArrowRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { FeaturedProjectCard, ProjectCard } from "@/components/site/projects/project-card";
import { usePreviewHref } from "@/providers/site-frame";
import type { PageData } from "@/shared/types";
import { formatDate } from "@/utils/format";

type Data = Extract<PageData, { route: "projects-home" }>;

/** The most projects shown on the homepage: one featured, then up to three. The rest are on /projects. */
const ON_HOME = 4;

/**
 * The projects-first homepage (Phase 4): a short introduction, the work (one large project, then a row),
 * a quiet list of recent writing, and a few words about me. Every word comes from Payload.
 */
export const ProjectsHomePage = ({ data }: { data: Data }) => {
    const { content, projects, latest } = data;
    const href = usePreviewHref();
    const [lead, ...rest] = projects.slice(0, ON_HOME);
    const more = projects.length - ON_HOME;

    return (
        <>
            <section aria-labelledby="hero-heading" className="mx-auto max-w-container px-4 pt-14 pb-12 md:px-8 md:pt-24 md:pb-16">
                <div className="max-w-3xl">
                    <h1 id="hero-heading" className="v2-display text-display-md text-primary md:text-display-xl">
                        {content.heroTitle}
                    </h1>
                    <p className="mt-5 max-w-2xl text-lg leading-relaxed text-tertiary md:mt-6 md:text-xl">{content.heroIntro}</p>
                    <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                        <Button href={href("/projects")} size="lg" iconTrailing={ArrowRight}>
                            {content.heroCtaLabel}
                        </Button>
                        {content.showWriting && (
                            <a href="/blog" className="rounded-xs text-md font-semibold text-secondary underline-offset-4 outline-focus-ring hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
                                Or read the writing
                            </a>
                        )}
                    </div>
                </div>
            </section>

            <section id="projects" aria-labelledby="projects-heading" className="mx-auto max-w-container px-4 pb-16 md:px-8 md:pb-24">
                <div className="flex flex-col gap-2 border-t border-secondary pt-8 md:flex-row md:items-end md:justify-between md:pt-10">
                    <div>
                        <h2 id="projects-heading" className="v2-display text-display-xs text-primary md:text-display-sm">
                            {content.projectsHeading}
                        </h2>
                        {content.projectsIntro && <p className="mt-2 max-w-2xl text-md text-tertiary">{content.projectsIntro}</p>}
                    </div>
                    {content.showMoreProjects && projects.length > 0 && (
                        <a href={href("/projects")} className="group inline-flex items-center gap-1.5 rounded-xs text-md font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 max-md:hidden">
                            All projects
                            <ArrowRight aria-hidden="true" className="size-4 transition duration-150 motion-safe:group-hover:translate-x-0.5" />
                        </a>
                    )}
                </div>

                {lead ? (
                    <div className="mt-10 flex flex-col gap-14 md:mt-12 md:gap-20">
                        <FeaturedProjectCard project={lead} />
                        {rest.length > 0 && (
                            <ul className="grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 lg:grid-cols-3">
                                {rest.map((project) => (
                                    <li key={project.slug} className="flex">
                                        <ProjectCard project={project} className="w-full" />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ) : (
                    <p className="mt-10 max-w-xl rounded-xl border border-dashed border-primary px-6 py-10 text-md text-tertiary">
                        Projects are on their way. In the meantime, there's some writing below.
                    </p>
                )}

                {content.showMoreProjects && projects.length > 0 && (
                    <div className="mt-12 flex md:mt-16">
                        <Button href={href("/projects")} color="secondary" size="lg" iconTrailing={ArrowRight} className="max-md:w-full">
                            {more > 0 ? `View all ${projects.length} projects` : "View all projects"}
                        </Button>
                    </div>
                )}
            </section>

            {content.showWriting && latest.length > 0 && (
                <section aria-labelledby="writing-heading" className="border-t border-secondary bg-secondary">
                    <div className="mx-auto grid max-w-container gap-8 px-4 py-14 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-16 md:px-8 md:py-20">
                        <div className="flex flex-col items-start gap-3">
                            <h2 id="writing-heading" className="v2-display text-display-xs text-primary">
                                {content.writingHeading}
                            </h2>
                            <a href="/blog" className="group inline-flex items-center gap-1.5 rounded-xs text-md font-semibold text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2">
                                All writing
                                <ArrowRight aria-hidden="true" className="size-4 transition duration-150 motion-safe:group-hover:translate-x-0.5" />
                            </a>
                        </div>
                        <ul className="divide-y divide-secondary border-y border-secondary">
                            {latest.map((post) => (
                                <li key={post.slug}>
                                    <a href={`/blog/${post.slug}`} className="group flex flex-col gap-1 py-5 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 sm:flex-row sm:items-baseline sm:gap-6">
                                        <time dateTime={post.publishedAt} className="shrink-0 text-sm text-quaternary tabular-nums sm:w-36">
                                            {formatDate(post.publishedAt)}
                                        </time>
                                        <span className="flex flex-col gap-1">
                                            <span className="text-lg font-semibold text-primary group-hover:underline group-hover:underline-offset-4">{post.title}</span>
                                            {post.summary && <span className="line-clamp-2 text-md text-tertiary">{post.summary}</span>}
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>
            )}

            {content.showAbout && (
                <section aria-labelledby="about-heading" className="border-t border-secondary">
                    <div className="mx-auto grid max-w-container gap-6 px-4 py-14 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-16 md:px-8 md:py-20">
                        <h2 id="about-heading" className="v2-display text-display-xs text-primary">
                            {content.aboutHeading}
                        </h2>
                        <div className="flex max-w-2xl flex-col items-start gap-5">
                            <p className="text-lg leading-relaxed text-secondary">{content.aboutText}</p>
                            <a href="/about" className="group inline-flex items-center gap-1.5 rounded-xs text-md font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2">
                                More about me
                                <ArrowRight aria-hidden="true" className="size-4 transition duration-150 motion-safe:group-hover:translate-x-0.5" />
                            </a>
                        </div>
                    </div>
                </section>
            )}
        </>
    );
};
