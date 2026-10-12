// Site-wide settings. Edit these to change names, descriptions and contact details.
// Keep personal details out of here: no town, region, address or phone number.

export const site = {
    name: "Aidan Daly",
    /** Canonical origin, used for share links. The worker uses SITE_URL for everything else. */
    url: "https://daly.id.au",
    shortName: "AD",
    title: "Aidan Daly",
    description:
        "Aidan Daly's little corner of the internet: what I'm thinking, what I'm learning, and the occasional project or idea worth putting into words.",
    locale: "en_AU",
    language: "en-AU",
    blogTitle: "Blog",
    blogDescription: "What I'm thinking about, what I'm learning, and the occasional project or idea worth putting into words.",
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

/** The kinds of things the blog covers. Shown on the homepage. */
export const topics = [
    { title: "Leadership and learning", description: "What I'm picking up about leading people, and about getting better at things." },
    { title: "Building useful things", description: "Technology, small tools and the odd experiment that turned out to be handy." },
    { title: "Projects", description: "Things I'm working on, from the first idea to wherever they end up." },
    { title: "Life and ideas", description: "Experiences, observations and thoughts I'm still turning over." },
];
