import { Mail01, Rss01 } from "@untitledui/icons";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { site } from "@/content/site";

export const ContactPage = () => {
    const channels = [
        site.email && {
            icon: Mail01,
            title: "Email",
            description: "The best way to reach me. I read everything, though replies can take a little while.",
            href: `mailto:${site.email}`,
            label: site.email,
        },
        {
            icon: Rss01,
            title: "Follow the blog",
            description: "Get new articles in your feed reader as soon as they're published.",
            href: "/feed.xml",
            label: "Subscribe via RSS",
        },
        ...site.socials.map((social) => ({
            icon: Mail01,
            title: social.label,
            description: `Find me on ${social.label}.`,
            href: social.href,
            label: social.href.replace(/^https?:\/\/(www\.)?/, ""),
        })),
    ].filter(Boolean) as { icon: typeof Mail01; title: string; description: string; href: string; label: string }[];

    return (
        <div className="mx-auto max-w-container px-4 pt-12 pb-16 md:px-8 md:pt-20 md:pb-24">
            <div className="mx-auto max-w-3xl text-center">
                <p className="text-sm font-semibold text-brand-secondary md:text-md">Contact</p>
                <h1 className="mt-3 text-display-md font-semibold text-primary md:text-display-lg">Get in touch</h1>
                <p className="mt-4 text-lg text-tertiary md:mt-6 md:text-xl">Questions, ideas or just saying hello. Here's where to find me.</p>
            </div>
            <ul className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-6 md:mt-16 md:grid-cols-2 md:gap-8">
                {channels.map((channel) => (
                    <li key={channel.href} className="flex flex-col items-start gap-5 rounded-2xl bg-secondary p-6 md:p-8">
                        <FeaturedIcon icon={channel.icon} color="brand" theme="modern" size="lg" />
                        <div className="flex flex-col gap-1">
                            <h2 className="text-lg font-semibold text-primary md:text-xl">{channel.title}</h2>
                            <p className="text-md text-tertiary">{channel.description}</p>
                        </div>
                        <a
                            href={channel.href}
                            className="text-md font-semibold break-all text-brand-secondary outline-focus-ring hover:text-brand-secondary_hover focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            {channel.label}
                        </a>
                    </li>
                ))}
            </ul>
        </div>
    );
};
