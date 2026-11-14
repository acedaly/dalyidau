import { FeaturedProjectCard, ProjectCard } from "@/components/site/projects/project-card";
import type { PageData } from "@/shared/types";

type Data = Extract<PageData, { route: "projects" }>;

/** Every public project: the featured ones first (largest), then the rest in their display order. */
export const ProjectsIndexPage = ({ data }: { data: Data }) => {
    const featured = data.projects.filter((p) => p.featured);
    const others = data.projects.filter((p) => !p.featured);
    const [lead, ...restFeatured] = featured.length ? featured : [];
    const grid = [...restFeatured, ...others];
    return (
        <div className="mx-auto max-w-container px-4 pt-14 pb-16 md:px-8 md:pt-20 md:pb-24">
            <header className="max-w-3xl">
                <h1 className="v2-display text-display-md text-primary md:text-display-lg">Projects</h1>
                {data.intro && <p className="mt-4 text-lg leading-relaxed text-tertiary md:text-xl">{data.intro}</p>}
                {data.projects.length > 0 && (
                    <p className="mt-3 text-sm text-quaternary">
                        {data.projects.length} {data.projects.length === 1 ? "project" : "projects"}
                    </p>
                )}
            </header>
            {data.projects.length === 0 ? (
                <p className="mt-12 max-w-xl border-t border-secondary pt-8 text-md text-tertiary">
                    Nothing is written up here yet.
                    {data.hasWriting && (
                        <>
                            {" "}
                            The{" "}
                            <a
                                href="/blog"
                                className="font-semibold text-secondary underline underline-offset-4 outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                                writing
                            </a>{" "}
                            is the best place to see what I've been working on in the meantime.
                        </>
                    )}
                </p>
            ) : (
                <div className="mt-12 flex flex-col gap-14 border-t border-secondary pt-12 md:gap-20">
                    {lead && <FeaturedProjectCard project={lead} headingLevel="h2" />}
                    {grid.length > 0 && (
                        <ul className="grid grid-cols-1 gap-x-8 gap-y-12 md:grid-cols-2 lg:grid-cols-3">
                            {grid.map((project) => (
                                <li key={project.slug} className="flex">
                                    <ProjectCard project={project} headingLevel="h2" className="w-full" />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};
