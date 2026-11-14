# Running the website from Payload

Everything on daly.id.au is managed at **daly.id.au/admin**. Nothing here needs code, a deploy or a developer.
For how it's built, see [ARCHITECTURE.md](ARCHITECTURE.md); for when something goes wrong, [RECOVERY.md](RECOVERY.md).

## Where things are

| In the menu                 | What it is                                                                 | Public address             |
| --------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| Website → Projects          | The portfolio. Featured projects lead the homepage.                        | `/projects`, `/projects/…` |
| Blog and Media → Blog posts | The writing.                                                               | `/blog`, `/blog/…`         |
| Website → Pages             | Standalone pages. **About** is one of these.                               | `/about`, `/<address>`     |
| Website → Homepage          | The homepage's words (the "Projects homepage" tab is the one that's live). | `/`                        |
| Website → Navigation        | The menu.                                                                  | header and footer          |
| Website → Redirects         | Old addresses you want to send somewhere.                                  |                            |
| Website → Site settings     | Site name, description, email, social links, the Contact page's words.     | `/contact`, everywhere     |
| Blog and Media → Media      | Every image, in one library.                                               |                            |
| Wedding, Administration     | The wedding and its settings: see [PORTAL.md](PORTAL.md).                  |                            |

The dashboard (`/admin`) opens with the wedding, then **Website sync**: one line saying whether the public site
shows what you've published.

## Publishing

- **Save draft** changes nothing public. **Publish** puts it on the site on the next page load. There is no
  build and no wait.
- **Unpublish** (or moving to Trash) takes it off the site. Its address answers "not found" while it's off, and
  works again when you publish it again.
- **Preview** (top of a post, page or project) shows the last saved draft on the site's own page, privately.
  Save first: the preview shows what's saved, not what's typed.
- **Publishing is checked before it's saved.** If something would stop it (an address already in use, an image
  that can't be read, no content), you're told and nothing is saved as published. Fix it and publish again.
- **Changing an address** keeps the old one working: it redirects to the new one by itself.
- **Scheduling isn't supported.** A "Published at" date in the future is just the date shown on the post.

### If a save says the website couldn't be updated

Payload keeps your change; the site still shows the previous version. Press **Save** again in a minute. If it
persists, open the dashboard: **Website sync** lists what's out of step, and **Republish** puts it right. It
only ever makes the site match Payload, and never removes anything Payload has no document for.

## Writing a post

1. Blog posts → Create new. Give it a title; the address fills in from it.
2. Write in **Content**. Headings become the table of contents. Images go in from the toolbar (they come from
   Media, and need alt text).
3. Optional: **Summary** (shown in lists, feeds and search results; left empty, the first words are used),
   **Featured image**, **Category**, **Tags**, **Featured** (pins it as the lead card on the blog).
4. Publish.

Reading time, the table of contents, related posts, the feed and the sitemap update themselves.

## Adding a project

A project page works best when it answers four things, in this order: what it is and why it exists, what you
did, how it's built, and how it turned out. A new project's Description starts with those four headings. Write
under the ones that fit; a suggested heading left with nothing under it isn't published.

| Field                   | What to put there                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Title, Address          | The name, and `daly.id.au/projects/<address>`.                                              |
| Summary                 | One or two sentences. It's the card text and the default search description.                |
| Cover image             | A screenshot or photo, 16:10 looks best. Without one the card shows the project's initials. |
| Description             | The write-up.                                                                               |
| Screenshots             | Up to 24, each with an optional caption.                                                    |
| Website, GitHub, links  | Full `https://` addresses.                                                                  |
| Status                  | Active, Completed, Experimental or Archived (shown as a small label).                       |
| Technologies and topics | Short tags. Projects sharing tags are suggested under each other.                           |
| Featured, Display order | Featured projects lead the homepage. Lower order numbers come first.                        |
| Show on the public site | Untick to keep a published project in Payload but off the site.                             |

Only write what's true and what you're happy to have public. A draft is invisible until you publish it.

## Images

- **Formats:** JPEG, PNG, GIF, WebP or AVIF, up to 15 MB. Anything else is refused.
- **Size:** upload the largest good version you have, up to about 3,000 pixels wide. The site makes smaller
  copies itself (480, 960 and 1,600 pixels wide, in AVIF and WebP) when the image is published, and each
  visitor's browser picks the one that fits. You never need to resize or convert anything yourself.
- **Shape:** project covers and screenshots are shown 16:10 and cropped from the top, so keep the important part
  in the upper area. Post and page images are shown at their own shape. A sharing image is 1200 × 630.
- **Alt text:** say what the image shows, as you would to someone who can't see it. It's required.
- **Animated GIFs** are shown as uploaded (never resized).
- **Deleting an image** that's in use is refused by Payload; take it out of the content first.

## Search engines and link previews

Every post, page and project has a **Search and link previews** group. It's all optional: left empty, the
title, summary and image you've already written are used, which is right for almost everything.

| Field                     | Use it when                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Search title              | The page title is too long or too plain for a search result. About 60 characters shows in full.     |
| Search description        | You want a different line under the title in search results. About 155 characters shows in full.    |
| Sharing title/description | A link pasted into a message should read differently from the search result.                        |
| Sharing image             | You want a specific picture when the link is shared. Otherwise the featured or cover image is used. |
| Canonical address         | It was first published elsewhere, or duplicates another page. Rare.                                 |
| Hide from search engines  | It should be reachable by link but not listed. It's also left out of the sitemap.                   |

The site-wide defaults (site name, description, and the image used when a page has none) are in **Site settings**.
The sitemap (`/sitemap.xml`), the feed (`/feed.xml`) and `robots.txt` are generated; there's nothing to maintain.

## The menu

Website → Navigation lists the menu's own items. The site adds the rest:

- **Projects** always comes first.
- A link to `/blog` called "Blog" is shown as **Writing**. Give it another name to use that instead.
- A link to `/contact` appears in the **footer**, not the header.
- **Wedding** is added to the header while the wedding website is public.
- A link to a page appears only while that page is published.

So the header reads Projects, Writing, About, Wedding, and the footer ends with Contact.

## About and Contact

- **About** is a page (Website → Pages → About): edit and publish it like any other. "End with … buttons" adds
  the links to the projects, the writing and Contact under it.
- **Contact** is built from Site settings: the heading and introduction, the public email (leave it empty to
  hide email everywhere), and the social links. There is no form and nothing is collected.

## Redirects

You rarely need one: renaming a post, page or project keeps its old address working by itself, and those are
listed, read-only, at the bottom of Website → Redirects.

Add one when an address from somewhere else (an old site, a printed link, a typo that got shared) should lead
somewhere. Give the old address (a path, such as `/old-page`), where it goes (a path here or a full `https://`
address), and whether it's permanent (301) or temporary (302). Saving applies it straight away.

A redirect is only used when nothing else answers the address, so it can never hide a live page. Duplicates,
loops and addresses that already lead somewhere are refused when you save, with the reason.

## History and undoing

- **Posts, pages, projects and the Homepage** keep their last 50 versions (the **Versions** tab): compare any two
  and restore one.
- **Navigation, Site settings and Redirects** do too, and each version says who saved it.
- **Restoring** a version publishes it. A version that today's rules would refuse (a menu linking to a page
  since deleted, a redirect from an address a page now uses) can't be restored, and says why.
- **Trash** holds deleted posts, pages and projects until they're deleted for good, which only an owner can do.

## Who can do what

Access to `/admin` is through Cloudflare Access; roles are set in Administration → Users and permissions.
Owners and admins edit the website. Only owners delete for good or remove something from the site that Payload
has no document for. Editors and viewers see the wedding screens their role allows, and nothing of the website.
