import { ArrowLeft, ArrowUpRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ProjectCard } from "@/components/site/projects/project-card";
import { ProjectCover } from "@/components/site/projects/project-cover";
import { ProjectStatusLabel, ProjectTags } from "@/components/site/projects/project-status";
import { usePreviewHref } from "@/providers/site-frame";
import type { PageData } from "@/shared/types";
import { formatDate } from "@/utils/format";

type Data = Extract<PageData, { route: "project" }>;

/** One project: what it is, how it looks, what it's made with, where to find it. */
export const ProjectPage = ({ data }: { data: Data }) => {
    const { project, related } = data;
    const href = usePreviewHref();
    const links = [
        ...(project.websiteUrl ? [{ label: "Visit the website", url: project.websiteUrl }] : []),
        ...(project.githubUrl ? [{ label: "Source on GitHub", url: project.githubUrl }] : []),
        ...project.links,
    ];
    return (
        <>
            <article className="pt-8 pb-16 md:pt-12 md:pb-24">
                <header className="mx-auto max-w-container px-4 md:px-8">
                    <Button href={href("/projects")} color="link-gray" size="md" iconLeading={ArrowLeft}>
                        All projects
                    </Button>
                    <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-end lg:gap-12">
                        <div className="lg:col-span-8">
                            <ProjectStatusLabel status={project.status} />
                            <h1 className="v2-display mt-3 text-display-md text-primary md:text-display-lg">{project.title}</h1>
                            {project.summary && <p className="mt-4 max-w-3xl text-lg leading-relaxed text-tertiary md:text-xl">{project.summary}</p>}
                        </div>
                        {links.length > 0 && (
                            <ul className="flex flex-wrap gap-3 lg:col-span-4 lg:justify-end" aria-label="Links">
                                {links.map((link, i) => (
                                    <li key={link.url}>
                                        <Button href={link.url} target="_blank" rel="noopener noreferrer" color={i === 0 ? "primary" : "secondary"} size="md" iconTrailing={ArrowUpRight}>
                                            {link.label}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </header>

                <div className="mx-auto mt-10 max-w-container px-4 md:mt-14 md:px-8">
                    <ProjectCover image={project.image} title={project.title} priority sizes="(min-width: 1280px) 1216px, 100vw" className="shadow-sm" />
                </div>

                <div className="mx-auto mt-12 grid max-w-container grid-cols-1 gap-10 px-4 md:mt-16 md:px-8 lg:grid-cols-12 lg:gap-12">
                    <aside className="flex flex-col gap-6 lg:order-2 lg:col-span-4 lg:col-start-9" aria-label="About this project">
                        {project.tags.length > 0 && (
                            <div className="flex flex-col gap-3">
                                <h2 className="v2-eyebrow text-xs font-semibold text-quaternary">Built with</h2>
                                <ProjectTags tags={project.tags} />
                            </div>
                        )}
                        {project.updatedAt && (
                            <div className="flex flex-col gap-1">
                                <h2 className="v2-eyebrow text-xs font-semibold text-quaternary">Last updated</h2>
                                <p className="text-md text-secondary">{formatDate(project.updatedAt)}</p>
                            </div>
                        )}
                    </aside>
                    <div className="lg:order-1 lg:col-span-8">
                        {project.bodyHtml ? (
                            <div className="article-body prose max-w-none md:prose-lg" data-project-body dangerouslySetInnerHTML={{ __html: project.bodyHtml }} />
                        ) : (
                            <p className="text-lg text-tertiary">More about this project soon.</p>
                        )}
                    </div>
                </div>

                {project.gallery.length > 0 && (
                    <section aria-labelledby="gallery-heading" className="mx-auto mt-16 max-w-container px-4 md:mt-24 md:px-8">
                        <h2 id="gallery-heading" className="v2-display text-display-xs text-primary">
                            Screenshots
                        </h2>
                        <ul className="mt-8 grid grid-cols-1 gap-8 md:grid-cols-2">
                            {project.gallery.map((shot) => (
                                <li key={shot.src}>
                                    <figure className="flex flex-col gap-3">
                                        <ProjectCover image={shot} title={project.title} ratio="aspect-[16/10]" sizes="(min-width: 768px) 600px, 100vw" />
                                        {shot.caption && <figcaption className="text-sm text-tertiary">{shot.caption}</figcaption>}
                                    </figure>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </article>

            {related.length > 0 && (
                <section aria-labelledby="related-heading" className="border-t border-secondary bg-secondary">
                    <div className="mx-auto max-w-container px-4 py-14 md:px-8 md:py-20">
                        <h2 id="related-heading" className="v2-display text-display-xs text-primary">
                            More projects
                        </h2>
                        <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 lg:grid-cols-3">
                            {related.map((p) => (
                                <li key={p.slug} className="flex">
                                    <ProjectCard project={p} className="w-full" />
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>
            )}
        </>
    );
};
