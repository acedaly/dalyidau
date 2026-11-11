import { ArrowUpRight } from "@untitledui/icons";
import { usePreviewHref } from "@/providers/site-frame";
import type { ProjectSummary } from "@/shared/site-content";
import { cx } from "@/utils/cx";
import { ProjectCover } from "./project-cover";
import { ProjectStatusLabel, ProjectTags } from "./project-status";

type Heading = "h2" | "h3";

/** The large card for the lead project: screenshot first, words beside it on wide screens. */
export const FeaturedProjectCard = ({ project, headingLevel: H = "h3" }: { project: ProjectSummary; headingLevel?: Heading }) => {
    const href = usePreviewHref()(`/projects/${project.slug}`);
    return (
        <article className="group relative grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-center lg:gap-12">
            <ProjectCover image={project.image} title={project.title} priority sizes="(min-width: 1024px) 760px, 100vw" className="shadow-sm lg:col-span-7" />
            <div className="flex flex-col gap-4 lg:col-span-5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="v2-eyebrow text-xs font-semibold text-brand-secondary">Featured</span>
                    <ProjectStatusLabel status={project.status} />
                </div>
                <H className="v2-display text-display-sm text-primary md:text-display-md">
                    <a href={href} className="rounded-sm outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4">
                        {/* The whole card is the link's target area. */}
                        <span aria-hidden="true" className="absolute inset-0 z-10" />
                        {project.title}
                    </a>
                </H>
                {project.summary && <p className="text-lg leading-relaxed text-tertiary">{project.summary}</p>}
                <ProjectTags tags={project.tags} />
                <span className="mt-2 inline-flex items-center gap-1.5 text-md font-semibold text-primary">
                    Read about it
                    <ArrowUpRight aria-hidden="true" className="size-4 transition duration-150 ease-out motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5" />
                </span>
            </div>
        </article>
    );
};

/** A project in a grid: screenshot, status, name, a line or two, its tags. */
export const ProjectCard = ({ project, headingLevel: H = "h3", className }: { project: ProjectSummary; headingLevel?: Heading; className?: string }) => {
    const href = usePreviewHref()(`/projects/${project.slug}`);
    return (
        <article className={cx("group relative flex flex-col gap-4", className)}>
            <ProjectCover image={project.image} title={project.title} ratio="aspect-[4/3]" sizes="(min-width: 1024px) 400px, (min-width: 768px) 50vw, 100vw" className="transition duration-200 ease-out group-hover:shadow-md" />
            <div className="flex flex-col gap-2">
                <ProjectStatusLabel status={project.status} />
                <H className="v2-display text-xl text-primary">
                    <a href={href} className="rounded-sm outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4">
                        <span aria-hidden="true" className="absolute inset-0 z-10" />
                        {project.title}
                    </a>
                </H>
                {project.summary && <p className="line-clamp-2 text-md text-tertiary">{project.summary}</p>}
                <ProjectTags tags={project.tags.slice(0, 4)} className="mt-1" />
            </div>
        </article>
    );
};
