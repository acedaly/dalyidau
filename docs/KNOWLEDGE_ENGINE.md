# Daly Knowledge

A private knowledge application at `/portal/knowledge`: structured objects (pages, people, projects, meetings, decisions…), custom types and properties, a rich-text editor with `[[` links and backlinks, full-text search, revision history, archive and recoverable trash. It replaces Capacities as the place notes live. AI is optional and is not part of the current release.

**Status:** Milestone 1 (secure foundation) and the first usable part of Milestone 2 (application, CRUD, editor, search) are built and tested. **Not deployed.** Migration `0013_knowledge_engine.sql` hasn't been applied to any remote database. See [Decisions for the owner](#decisions-for-the-owner).

The repository is public: no real notes, exports or attachments are ever committed. Tests and fixtures use invented data only.

---

## Review of the PR #22 foundation

PR #22 proposed the schema and a delivery plan. This branch builds on it (its commits are kept) and revises `0013` before it is ever applied:

| Finding in #22                                                                                                                                                                                                                                    | Change                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Backups would break for the whole database.** `wrangler d1 export` refuses any database containing a virtual table ("cannot export databases with Virtual Tables (fts5)"), so `npm run db:backup` would fail for the blog and wedding data too. | The FTS index is a pure derivative with no triggers or external content. `scripts/db-backup.mjs` exports ordinary tables one by one when virtual tables exist, appends indexes, triggers and views, and recreates and rebuilds the index. Tested end to end. |
| External-content FTS keyed on `knowledge_objects`' implicit `rowid`: an export and re-import can renumber rowids and silently corrupt the index.                                                                                                  | The FTS rowid is `knowledge_objects.search_rowid`, an ordinary column that survives export.                                                                                                                                                                  |
| Relations, tags, revisions and attachments referenced objects by id alone, so the database would accept a link between two people's spaces.                                                                                                       | Every child row carries `space_id`, with composite foreign keys onto `(space_id, id)`. The database itself refuses cross-space references (tested).                                                                                                          |
| No audit table. The portal-wide `audit_log` is readable by every portal editor, so knowledge audit entries there would leak private titles.                                                                                                       | `knowledge_audit`, readable only by a space's owners and immutable. Entries never contain titles, text or values.                                                                                                                                            |
| `body_md` as the stored format, with no editor chosen.                                                                                                                                                                                            | A documented, allow-listed JSON format (`daly.doc.v1`, below), validated on the Worker, which derives plain text and links from it. Markdown is an export format.                                                                                            |
| Nothing prevented two personal spaces being created by concurrent first visits.                                                                                                                                                                   | Partial unique index on `personal_owner`; provisioning is race-safe (tested).                                                                                                                                                                                |
| `knowledge_attachments` with no code to delete R2 objects on permanent deletion.                                                                                                                                                                  | Deferred to Milestone 4, where it ships with its R2 code. Every table in `0013` is used and tested.                                                                                                                                                          |

---

## How it fits together

```
src/shared/knowledge/      Shared by Worker and browser: content format, properties, types
worker/knowledge/
  access.ts                Space membership: the only way to reach a space, object or result
  api.ts                   /api/portal/knowledge/* router
  objects.ts               Object engine: CRUD, versions, revisions, tags, links, trash
  search.ts                FTS5 query building, search, index statements and rebuild
  types.ts spaces.ts       Object types; spaces and members
  audit.ts                 knowledge_audit
  pages.ts                 First-render data for each page
src/portal/knowledge/      Pages, editor (lazy-loaded), property fields, pickers, autosave
migrations/0013_…          Schema
scripts/lib/virtual-tables.mjs   FTS rebuild for backups
```

The application is registered in `src/shared/portal/applications.ts` (`knowledge`, permission `knowledge.use`). Pages render in the browser from data the Worker embeds, like the rest of the portal.

## Who can see what

1. **Cloudflare Access** and the portal's JWT check, unchanged ([PORTAL.md](PORTAL.md#set-up-cloudflare-access)).
2. **Portal role → `knowledge.use`**: owners and admins can open Knowledge. Editors and viewers of the wedding planner can't, and get no personal space.
3. **Space membership** decides everything inside. Each person gets a personal space on their first visit that only they can see: **being a portal owner gives no access to anyone else's space**. Shared spaces have Owner, Editor and Viewer members.

| Space role | Can                                                                                  |
| ---------- | ------------------------------------------------------------------------------------ |
| Owner      | Everything, including members, permanent deletion and the audit trail.               |
| Editor     | Create, edit, organise, archive, trash and restore objects; create and change types. |
| Viewer     | Read and search.                                                                     |

Enforcement, all on the Worker and covered by `test/knowledge.test.ts`:

- Every space, object, revision, relation and type is looked up **joined to the caller's membership row**. A non-member gets 404, never 403, so ids can't be probed. Search and `[[` lookups only ever query the caller's own space ids.
- Identities, owners and space ids from the browser are never trusted: the actor is the verified Access identity, and an object's space comes from the database.
- Both ends of every relation, every reference property and every type reference must be in the same space, checked in code and enforced by composite foreign keys.
- Writes need a same-origin `Origin` and a JSON body, and cross-site reads are refused (the portal's existing CSRF rules).
- Personal spaces can't be shared. Shared spaces can only add people who can already open Knowledge, and always keep at least one owner.
- Knowledge never appears on public, blog or wedding routes, or in the wedding JSON export.

Not imported without data-governance approval: confidential NSW RFS operational information. No Incident or Shift type is seeded.

## Data model

| Table                                       | Holds                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge_spaces`, `knowledge_memberships` | Spaces (personal or shared, with a time zone) and who belongs to them                                                                                        |
| `knowledge_object_types`                    | Types and their property schema (`schema_json`); archived, never deleted while in use                                                                        |
| `knowledge_objects`                         | Title, document, derived `body_text`, properties, status (`active`/`archived`/`trashed`), Inbox flag, version, source ids for imports                        |
| `knowledge_revisions`                       | Snapshots of title, document, properties and type                                                                                                            |
| `knowledge_relations`                       | Typed, directed links. `origin` is `content` (a link in the text), `property` (a reference property) or `manual`. Backlinks are the same rows read by target |
| `knowledge_tags`, `knowledge_object_tags`   | Tags per space                                                                                                                                               |
| `knowledge_audit`                           | The space's audit trail                                                                                                                                      |
| `knowledge_fts`                             | FTS5 index over title, text and tags (derived)                                                                                                               |

Ids are prefixed random strings (`ksp_`, `kty_`, `kob_`, `krv_`, `krl_`, `ktg_`) and never change.

## Content format

Documents are stored as **`daly.doc.v1`**: the ProseMirror JSON that the editor (Tiptap) produces, restricted to this list. `normaliseDocument` in `src/shared/knowledge/content.ts` validates every document on the Worker. It refuses unknown nodes and marks (nothing is silently lost), drops unknown attributes, and caps size (50,000 nodes, 40 levels, 1 MB request).

| Kind   | Allowed                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocks | `paragraph`, `heading` (`level` 1–6), `blockquote`, `bulletList`, `orderedList` (`start`, `type`), `listItem`, `taskList`, `taskItem` (`checked`), `codeBlock` (`language`), `horizontalRule`, `table`, `tableRow`, `tableHeader`, `tableCell` (`colspan`, `rowspan`, `colwidth`) |
| Inline | `text`, `hardBreak`, `objectLink` (`id`, `label`)                                                                                                                                                                                                                                 |
| Marks  | `bold`, `italic`, `underline`, `strike`, `code`, `link` (`href`: `https://`, `http://`, `mailto:` or a path on this site, never `//host` or `javascript:`)                                                                                                                        |

- **Links to objects** are `objectLink` nodes, typed as `[[`, or ordinary links to `/portal/knowledge/o/<id>`. The Worker extracts both on every save and rebuilds that object's `content` relations, which is what makes backlinks. Links to objects in other spaces are kept in the text but create no relation.
- **Plain text** (`body_text`) is derived for search and previews. Control characters are stripped.
- **Nothing is ever rendered as raw HTML.** The editor renders the JSON through its schema. Search highlights come back as two marker characters (`HIGHLIGHT_START`, `HIGHLIGHT_END`) that the page turns into `<mark>` elements.
- **Not yet supported:** images and attachments (Milestone 4, as R2-backed nodes; images by external URL will never be allowed, since they'd leak when a note is opened).

## Properties

Types define properties in `schema_json`: text, long text, number, currency (integer cents with an ISO currency), date, date and time (stored in UTC), checkbox, single select, multi-select, URL, email, phone, person (an object of the `person` type) and object reference (optionally limited to one type, one or many). Rules (`src/shared/knowledge/properties.ts`, enforced on the Worker):

- Values are validated against the object's type on every write. Unknown keys are refused.
- Defaults apply on create. Required properties are enforced on create and can never be cleared afterwards. Adding a required property to an existing type doesn't block edits to older objects.
- Reference properties must point at live objects in the same space, of the right type, and produce `property` relations named after the property (so a meeting's participants show up as backlinks on each person).
- Editing a type never deletes stored values. Removing a property hides it, and its values stay on objects. A property's key and kind can't change once saved; add a new property instead. Select options keep their ids when relabelled.

## Saving, versions and history

- Every save carries the version the editor started from. If anyone saved in between, nothing is written and the response is 409 with the current version. The editor stops saving, keeps the person's changes and offers **Keep my changes** (saved on top; theirs stays in the history) or **Discard mine**.
- Each write is a single D1 batch: the object, revision, search index, rebuilt links, tags and audit entry commit together or not at all.
- **Revisions**: one per editing session. Autosaves from one open page (a random session id) within 10 minutes update that session's latest revision. Another tab, device or person always starts a new one, and so does any save without a session id. Restoring a revision saves it as a new version; history is never rewritten.
- **Trash**: trashing hides an object from lists, search, lookups and backlinks, and it can be restored at any time. Permanent deletion needs the space owner, the object to be in the trash already, and the typed confirmation `DELETE`. It removes the object, its history and links in one batch.

## Search

SQLite FTS5 (`unicode61`, diacritics folded, prefix indexes) over title, text and tags, ranked by BM25 with titles weighted most (title 10, tags 4, text 1).

- What people type is never passed through as FTS syntax. Words become quoted prefix terms that must all match; text in double quotes is a phrase (`ftsQuery`, tested against FTS operators and SQL in the query).
- Filters: space (or all of the caller's spaces), type, tag, status (active, archived, any non-trashed) and updated date.
- `[[` lookups use a title match within one space.
- The index is written in the same batch as each change. `KNOWLEDGE_FTS_REBUILD` rebuilds it from scratch; `npm run db:verify` warns if any object is missing from it.

## Backups and restore

See [DATABASE.md](DATABASE.md#backups). In short: `npm run db:backup` still produces one restorable `.sql` file. With the FTS table present, it exports the ordinary tables one by one, then appends indexes, triggers, views and the statements that recreate and refill the index. The script then restores it into a throwaway database and checks every table's row count, every schema object, foreign keys and that the index covers every object. Tested locally against a database with knowledge data. R2 attachments don't exist yet; when they do (Milestone 4), backups must cover them too.

## API

All under `/api/portal/knowledge`, all requiring Access, `knowledge.use` and membership. Writes need a same-origin JSON request.

| Method and path                                                                       | What                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /spaces`, `POST /spaces`                                                         | Your spaces (creating your personal space on first use); create a shared space                     |
| `PATCH /spaces/:space`                                                                | Name, time zone (owner)                                                                            |
| `GET/POST /spaces/:space/members`, `PATCH/DELETE /spaces/:space/members/:email`       | Members (owner to change)                                                                          |
| `GET /spaces/:space/audit`                                                            | Audit trail (owner)                                                                                |
| `GET/POST /spaces/:space/types`, `PATCH /types/:id`                                   | Types; `PATCH` takes `version`, and `archived` to archive                                          |
| `GET /spaces/:space/objects`                                                          | `view` (all, inbox, archived, trashed), `type`, `tag`, `sort`, `limit` (≤ 200), `offset`           |
| `POST /spaces/:space/objects`                                                         | Create: `typeId`, `title`, `content`, `properties`, `tags`, `inInbox`                              |
| `POST /spaces/:space/objects/bulk`                                                    | `ids` (≤ 200) and `action`: archive, unarchive, trash, restore, file (out of the Inbox)            |
| `GET /spaces/:space/lookup?q=`, `GET /spaces/:space/tags`                             | Titles for `[[`; tags in use                                                                       |
| `GET /objects/:id`, `PATCH /objects/:id`                                              | Object with links, backlinks and referenced titles; update with `version` (and optional `session`) |
| `POST /objects/:id/status/:action`                                                    | archive, unarchive, trash, restore                                                                 |
| `POST /objects/:id/delete`                                                            | `{ "confirm": "DELETE" }`, owner, from the trash only                                              |
| `GET /objects/:id/revisions`, `GET …/revisions/:rev`, `POST …/revisions/:rev/restore` | History; restore takes the current `version`                                                       |
| `POST /objects/:id/relations`, `DELETE /relations/:id`                                | Manual typed links (`targetId`, `relationType`)                                                    |
| `GET /search?q=`                                                                      | `space`, `type`, `tag`, `status`, `from`, `to`, `limit`                                            |

## What's in the app now

- **Home**: quick capture, recently edited, the Inbox, types with counts.
- **Inbox**: captured items (first line as title). **Done processing** files them, one at a time or in bulk.
- **All knowledge, Archive, Trash**: filter by type and tag, sort, bulk archive, trash and restore, load more.
- **Object page**: editable title; editor with toolbar, `/` commands (headings, lists, checklist, quote, code, divider, table, link), `[[` links with "Create…", Markdown shortcuts, undo and redo; autosave and conflict handling; type, properties, tags, links (add typed links by hand), backlinks, "New note linking here", history with preview and restore, archive, trash and permanent delete.
- **Search**: ranked, highlighted, filterable, all spaces or one, keyboard navigation.
- **Object types**: create and edit types and properties, reorder, archive.
- **Space settings**: name and time zone, members and roles, new shared space, audit trail.
- Works on phones: the Playwright tests run on Pixel 7 emulation as well as desktop, and fail on any horizontal overflow or any serious or critical axe accessibility issue on a Knowledge page.

## Not done yet

| Area                                          | Milestone | Notes                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daily notes                                   | 3         | Add a `daily_date` column with a unique index per space, created on demand in the space's time zone.                                                                                                                                                               |
| Collections, favourites, saved views          | 3         | New tables. Collections reference objects without copying them.                                                                                                                                                                                                    |
| Templates                                     | 3         | A template document and properties per type.                                                                                                                                                                                                                       |
| Related-content suggestions, orphan discovery | 3         | The relations table supports both. Orphans are objects with no relations in either direction.                                                                                                                                                                      |
| Attachments and images                        | 4         | Private R2 keys (`knowledge/<space>/<object>/<uuid>`), authenticated download routes that check membership, size limits, MIME sniffing, no SVG or HTML inline. Permanent deletion removes the R2 objects. Backups must include R2.                                 |
| Capacities import                             | 4         | Inspect a real export first. Preview, type and property mapping, `source_system`/`source_id` for idempotency (already in the schema), link reconstruction, a reconciliation report. Never deletes anything in Capacities.                                          |
| Export                                        | 4         | JSON (lossless) plus Markdown per object, with an attachment manifest. Restore tested from the export.                                                                                                                                                             |
| Semantic search                               | 5         | Vectorize behind a flag, off by default: chunk `body_text`, embed on change, merge with FTS, filter by the caller's spaces, cite sources.                                                                                                                          |
| AI                                            | 5         | A provider-independent interface; read-only MCP tools (search, get, related) scoped to the caller's spaces; writes only through a server-side, metered model API with previews and confirmation; a monthly spend limit. Nothing runs or costs anything by default. |

Known limitations of this release:

- Lists show up to 200 objects at a time, with Load more. Search returns the best 50.
- Links between spaces aren't supported (by design for now).
- Collaborative real-time editing isn't supported. Simultaneous edits are detected and never silently overwritten, but they aren't merged.
- The editor bundle (about 190 KB gzipped) loads only on object pages.

## Decisions for the owner

1. **Close PR #22 in favour of this PR?** This branch contains #22's commits plus the revised migration.
2. **Approve applying `0013` to staging, then production.** It's additive (new tables only). Merging to `main` deploys and migrates automatically, and the deploy token has been failing since 14 Oct. Take `npm run db:backup -- --env production` first; the updated backup script is required from then on.
3. **Who gets Knowledge.** Currently portal owners and admins (`knowledge.use`). Note that the second portal owner gets their own private space, and neither owner can see the other's.
4. **Editor dependency:** Tiptap 3.31.4 (MIT), pinned exactly. The Untitled UI PRO text editor component uses it too.
5. **RFS data:** confirm the data-governance position before any NSW RFS material is entered or imported.
