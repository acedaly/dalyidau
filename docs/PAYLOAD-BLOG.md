# The blog in Payload

Payload is where blog posts are written, edited and kept (`/admin/collections/posts`, owners and admins only). The public blog (`/blog`, each post, `/feed.xml`, `/rss.xml`, `/sitemap.xml`, categories, tags, search, SEO tags) is rendered exactly as before, by the same code, from the same `posts` table. Payload is a third publisher into that table, alongside the retired Capacities and Amplenote publishers.

## How publishing works

- **Publish** (or **Publish changes**): the post's main document is written into `posts` with `source = 'payload'` (`worker/blog/payload-publisher.ts`). Its images are copied into the public `dalyidau-media` bucket under their content hash, recorded in `media` and served from `/media/<hash>.<ext>`. The content version is bumped, so the edge cache shows the change at once.
- **Save draft**: nothing public changes. The hook re-reads the main document, which a draft save doesn't touch.
- **Unpublish**: the post leaves the site and its old addresses stop redirecting. It stays in Payload.
- **Change the slug**: the old address redirects (301) to the new one.
- **Move to Trash** (owners only): the post leaves the site, as on unpublish, and can be restored from Trash. **Delete permanently** is for owners only.
- **Fails closed**: a missing title or content, an invalid slug, a slug another post uses, an unreadable featured image, or a row owned by another publisher refuses the save with a message. Nothing is half-written.

The rich text (Lexical) is rendered node by node, and **every string is escaped**: headings (with ids and the table of contents), paragraphs, bold/italic/underline/strike/code/sub/sup, links (http(s), mailto and site paths only; `javascript:`, `data:` and protocol-relative links are dropped, external links open in a new tab with `noopener`), lists and checklists, quotes, code blocks, horizontal rules and images. An unknown node contributes only its escaped text. The markup uses the classes in `src/styles/article.css` (`worker/lib/article-html.ts`).

## Import

Data migration `poc/payload/src/migrations/20261111_070000_blog_import.ts` (`src/blog-import.ts`) runs once, when Payload first starts after the deploy:

- Each post in `posts` with source `capacities` or `amplenote` becomes a published Payload document with the same id (`publicId`), slug, title, subtitle, summary, category, tags, dates and featured image.
- Its **stored HTML is kept byte for byte** (`legacy.bodyHtml`), and the site keeps showing it until someone writes new content in the editor. The content hash is the same, so the row isn't even rewritten (`test/payload-blog.test.ts`, `e2e-platform/blog.mjs`).
- The row is claimed for Payload (`source = 'payload'`), so the retired publishers can never overwrite or delete it. The Capacities sync now guards every write and delete with `source = 'capacities'`.
- The row as it was is kept on the document (`legacy.originalRow`).
- **Nothing is deleted.** Running it again skips posts already imported. If a create fails, that row is given back to its publisher and the migration stops.

**Undo:** the migration's `down` puts every imported row back exactly as it was (source included) and leaves Payload's copies in place. Production D1 Time Travel and the pre-deploy backups are the second line.

## Access

Only Cloudflare Access identities reach Payload (`docs/PAYLOAD-CUTOVER-PLAN.md`). Owners and admins can read, create, edit, publish and unpublish posts; only owners can move them to Trash or delete them permanently; editors, viewers and anyone without an identity are refused. Payload media can be uploaded by owners and admins only.

## Tests

- `test/payload-blog.test.ts` (in `npm test`): escaping, publishing, feed/sitemap/category/tag, images, slug redirects, fail-closed cases, and an imported Capacities post that stays byte-identical and can't be touched by the Capacities sync.
- `poc/payload/e2e-platform/blog.mjs`: the same end to end against the real Payload, including roles, draft saves and the import.
