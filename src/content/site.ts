// Site-wide settings. Edit these to change names, descriptions and contact details.
// Only details already public on the previous daly.id.au homepage are filled in.

export const site = {
    name: "Aidan Daly",
    /** Canonical origin, used for share links. The worker uses SITE_URL for everything else. */
    url: "https://daly.id.au",
    shortName: "AD",
    title: "Aidan Daly",
    description: "Aidan Daly. Dubbo, NSW. Training, systems and the occasional side project.",
    location: "Dubbo, NSW",
    locale: "en_AU",
    language: "en-AU",
    blogTitle: "Blog",
    blogDescription: "Notes on training, systems and the occasional side project.",
    /** Public contact email. Set to null to hide it everywhere. */
    email: "hello@daly.id.au" as string | null,
    /** Social profiles to show in the footer and on the contact page. Leave empty to hide. */
    socials: [] as { label: string; href: string; kind: "linkedin" | "github" | "x" | "instagram" | "youtube" }[],
    /** Optional fediverse/Bluesky etc. can be added to socials later. */
    nav: [
        { label: "Home", href: "/" },
        { label: "Blog", href: "/blog" },
        { label: "About", href: "/about" },
        { label: "Contact", href: "/contact" },
    ],
};
