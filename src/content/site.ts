// The site's built-in content now lives in src/shared/site-content.ts (defaults) and is edited in
// Payload (docs/PAYLOAD-FRONTEND-PLAN.md). This file keeps the old import path for code outside the
// public pages (the portal and the Worker's own error pages), which always use the defaults.
export { DEFAULT_SITE as site } from "../shared/site-content";

/** The kinds of things the blog covers (used only by the unused features section). */
export const topics = [
    { title: "Leadership and learning", description: "What I'm picking up about leading people, and about getting better at things." },
    { title: "Building useful things", description: "Technology, small tools and the odd experiment that turned out to be handy." },
    { title: "Projects", description: "Things I'm working on, from the first idea to wherever they end up." },
    { title: "Life and ideas", description: "Experiences, observations and thoughts I'm still turning over." },
];
