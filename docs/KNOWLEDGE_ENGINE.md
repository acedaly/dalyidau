# Daly Knowledge

A private knowledge application at `/portal/knowledge`: structured objects (pages, people, projects, meetings, decisions…), custom types and properties, a rich-text editor with `[[` links and backlinks, full-text search, revision history, archive and recoverable trash. It replaces Capacities as the place notes live. AI is optional and is not part of the current release.

**Status:** Milestones 1–3 and portable export are built and tested: the secure object engine, editor and search; daily notes; collections; favourites and pins; saved views; templates; related-content discovery; and JSON, Markdown and ZIP export. **Not deployed.** Migrations `0013_knowledge_engine.sql` and `0014_knowledge_organising.sql` have not been applied to any remote database. See [Decisions for the owner](#decisions-for-the-owner).

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
  daily.ts collections.ts  Daily notes, collections, pins and personal favourites
  templates.ts views.ts    Templates and validated saved views
  related.ts export.ts     Bounded discovery and portable export
  search.ts                FTS5 query building, search, index statements and rebuild
  types.ts spaces.ts       Object types; spaces and members
  audit.ts                 knowledge_audit
  pages.ts                 First-render data for each page
src/portal/knowledge/      Pages, editor (lazy-loaded), property fields, pickers, autosave
migrations/0013_… 0014_…   Object engine and Milestone 3 schema
scripts/lib/virtual-tables.mjs   FTS rebuild for backups
```

The application is registered in `src/shared/portal/applications.ts` (`knowledge`, permission `knowledge.use`). Pages render in the browser from data the Worker embeds, like the rest of the portal.

## Who can see what

1. **Cloudflare Access** and the portal's JWT check, unchanged ([PORTAL.md](PORTAL.md#set-up-cloudflare-access)).
2. **Portal role → `knowledge.use`**: owners and admins can open Knowledge. Editors and viewers of the wedding planner can't, and get no personal space.
3. **Space membership** decides everything inside. Each person gets a personal space on their first visit that only they can see: **being a portal owner gives no access to anyone else's space**. Shared spaces have Owner, Editor and Viewer members.

| Space role | Can                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Owner      | Everything, including members, full-space export, permanent deletion and the audit trail.                                             |
| Editor     | Create, edit, organise, archive, trash and restore objects; manage types, templates, collections, shared pins and shared saved views. |
| Viewer     | Read, search, export an object they can read, and manage only their own favourites and private saved views.                           |

Enforcement, all on the Worker and covered by `test/knowledge.test.ts`:

- Every space, object, revision, relation and type is looked up **joined to the caller's membership row**. A non-member gets 404, never 403, so ids can't be probed. Search and `[[` lookups only ever query the caller's own space ids.
- Identities, owners and space ids from the browser are never trusted: the actor is the verified Access identity, and an object's space comes from the database.
- Both ends of every relation, every reference property and every type reference must be in the same space, checked in code and enforced by composite foreign keys.
- Writes need a same-origin `Origin` and a JSON body, and cross-site reads are refused (the portal's existing CSRF rules).
- Personal spaces can't be shared. Shared spaces can only add people who can already open Knowledge, and always keep at least one owner.
- Knowledge never appears on public, blog or wedding routes, or in the wedding JSON export.

Not imported without data-governance approval: confidential NSW RFS operational information. No Incident or Shift type is seeded.

## Data model

| Table                                                 | Holds                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge_spaces`, `knowledge_memberships`           | Spaces (personal or shared, with a time zone) and who belongs to them                                                                                        |
| `knowledge_object_types`                              | Types and their property schema (`schema_json`); archived, never deleted while in use                                                                        |
| `knowledge_objects`                                   | Title, document, derived `body_text`, properties, status, Inbox flag, optional daily date, version, source ids for imports                                   |
| `knowledge_revisions`                                 | Snapshots of title, document, properties and type                                                                                                            |
| `knowledge_relations`                                 | Typed, directed links. `origin` is `content` (a link in the text), `property` (a reference property) or `manual`. Backlinks are the same rows read by target |
| `knowledge_tags`, `knowledge_object_tags`             | Tags per space                                                                                                                                               |
| `knowledge_audit`                                     | The space's audit trail                                                                                                                                      |
| `knowledge_fts`                                       | FTS5 index over title, text and tags (derived)                                                                                                               |
| `knowledge_collections`, `knowledge_collection_items` | Named, ordered groupings; objects are referenced, never copied                                                                                               |
| `knowledge_pins`, `knowledge_favourites`              | Shared space-home pins and per-user shortcuts                                                                                                                |
| `knowledge_saved_views`                               | Strictly validated filter definitions, either private to one user or shared with a space                                                                     |
| `knowledge_templates`                                 | Versioned starting documents, titles and property defaults associated with an object type                                                                    |

Ids are prefixed random strings (`ksp_`, `kty_`, `kob_`, `krv_`, `krl_`, `ktg_`, `kcl_`, `kvw_`, `ktp_`) and never change.

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

## Daily notes and organisation

- A daily note is an ordinary searchable, versioned object with a fixed `daily_date`. A partial unique index permits exactly one per space and date. It is created only when first used; concurrent requests return the same note. “Today”, previous/next navigation and `{date}` template substitution use the space's IANA time zone, including Australian daylight-saving transitions.
- Collections hold ordered references to objects without copying them. Objects can be in several collections; deleting a collection removes only its membership rows. Composite foreign keys and server checks reject cross-space membership.
- Space-home pins are shared and editor-managed. Favourites are personal, available to every member, and are read through current membership so revoked access cannot disclose stale favourites. Trashed objects are hidden from both; archived objects remain intentionally reachable.
- Saved views store only a server-validated `ListFilters` shape—never SQL, column names or arbitrary expressions. Private views belong to their creator; shared views require an editor to manage. Saves and renames use optimistic versions.
- Templates copy an allow-listed document, title and schema-validated property defaults into a new object. Reference properties are not allowed as defaults. Templates and created objects are independent, archived templates cannot be used, only one live default exists per type, and stale saves return 409.

## Related content and discovery

Related suggestions combine bounded queries for shared tags, shared collections, co-links and FTS title similarity. Direct links, trashed objects and anything outside the object's space are excluded. Results are deduplicated, capped at eight and include plain-language reasons. Discover provides three bounded orphan views: completely unlinked, no backlinks and no outgoing links; daily notes are excluded because they are intentionally date-centred.

No embeddings, Workers AI, Vectorize or external service is used. Ordinary D1 indexes and the existing FTS5 table do the work, so Milestone 3 adds no recurring service cost.

### Related tasks (from Daly Tasks)

Object pages show a **Tasks** section for people who can also open Tasks: tasks and Tasks projects that reference this object, from `GET /api/portal/tasks/knowledge/:objectId` (`src/portal/knowledge/related-tasks.tsx`). Knowledge itself isn't changed: Tasks stores only object ids, the Tasks API answers 404 unless the reader can read the object here, and then lists only tasks and projects the reader is a member of in Tasks, so a note shared with someone never shows them another person's private tasks. "Add linked task" opens Quick Add with this page pre-linked. Details: [TASKS_PROJECTS.md](TASKS_PROJECTS.md#tasks--knowledge).

## Portable export

- Any member may export an object they can read as Markdown or structured JSON. The JSON preserves its stable id, type and schema, full `daly.doc.v1` document, properties, tags, relations, linked-object labels, timestamps, status, source metadata and optional revisions.
- A space owner may export the entire space as structured JSON or a ZIP containing `manifest.json`, a README and one readable Markdown file per object. The manifest includes stable ids, objects, types and schemas, tags, relationships, collections and ordering, pins, templates, visible saved views, the exporter's own favourites, dates, members of shared spaces and the private Knowledge audit trail. Revision history is optional. Other users' private views and favourites are deliberately excluded.
- ZIP names are generated from sanitised titles plus stable ids. The writer rejects absolute paths, traversal segments, duplicate names, control characters and platform-reserved path characters. Downloads are `private, no-store`, `nosniff`, sandboxed and audited.
- `npm run knowledge:check-export -- <file.zip|file.json>` verifies format/version, ZIP CRCs and safe names, reference integrity, and that every object has Markdown. `test/knowledge-export.test.ts` additionally restores an export into an isolated empty local database, rebuilds FTS5, re-exports it and compares the portable data. There is intentionally no production restore endpoint.
- Browser exports are bounded before data is loaded: at most 100,000 included records and approximately 20 MB of stored source JSON/text; an object export may include at most 5,000 revisions. Larger spaces receive a 413 and should use the verified database-backup workflow. The limit keeps JSON parsing and ZIP assembly inside Workers memory without adding storage or a paid job service.

## Backups and restore

See [DATABASE.md](DATABASE.md#backups). In short: `npm run db:backup` still produces one restorable `.sql` file. With the FTS table present, it exports the ordinary tables one by one, then appends indexes, triggers, views and the statements that recreate and refill the index. The script then restores it into a throwaway database and checks every table's row count, every schema object, foreign keys and that the index covers every object.

`npm run test:backup` was run on 17 October 2026 against invented blog, wedding and Knowledge data. It applied `0014` over a populated `0013` database, populated every Milestone 3 table, ran the real backup script, restored twice, rebuilt FTS5, recovered search results and relations, preserved blog/wedding row counts and rechecked cross-space and daily-note constraints. R2 attachments don't exist yet; Milestone 4 must extend this workflow before attachments ship.

## API

All under `/api/portal/knowledge`, all requiring Access, `knowledge.use` and membership. Writes need a same-origin JSON request.

| Method and path                                                                       | What                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /spaces`, `POST /spaces`                                                         | Your spaces (creating your personal space on first use); create a shared space                     |
| `PATCH /spaces/:space`                                                                | Name, time zone (owner)                                                                            |
| `GET/POST /spaces/:space/members`, `PATCH/DELETE /spaces/:space/members/:email`       | Members (owner to change)                                                                          |
| `GET /spaces/:space/audit`                                                            | Audit trail (owner)                                                                                |
| `GET/POST /spaces/:space/types`, `PATCH /types/:id`                                   | Types; `PATCH` takes `version`, and `archived` to archive                                          |
| `GET /spaces/:space/objects`                                                          | List with type, tag, link, created/updated date and status filters; bounded pagination             |
| `POST /spaces/:space/objects`                                                         | Create, optionally from a selected or the type's default template                                  |
| `POST /spaces/:space/objects/bulk`                                                    | `ids` (≤ 200) and `action`: archive, unarchive, trash, restore, file (out of the Inbox)            |
| `GET /spaces/:space/lookup?q=`, `GET /spaces/:space/tags`                             | Titles for `[[`; tags in use                                                                       |
| `GET /objects/:id`, `PATCH /objects/:id`                                              | Object with links, backlinks and referenced titles; update with `version` (and optional `session`) |
| `POST /objects/:id/status/:action`                                                    | archive, unarchive, trash, restore                                                                 |
| `POST /objects/:id/delete`                                                            | `{ "confirm": "DELETE" }`, owner, from the trash only                                              |
| `GET /objects/:id/revisions`, `GET …/revisions/:rev`, `POST …/revisions/:rev/restore` | History; restore takes the current `version`                                                       |
| `POST /objects/:id/relations`, `DELETE /relations/:id`                                | Manual typed links (`targetId`, `relationType`)                                                    |
| `GET /objects/:id/related`                                                            | Bounded, explained related-content suggestions                                                     |
| `POST /objects/:id/favourite`, `POST /objects/:id/pin`                                | Personal favourite or editor-managed shared pin                                                    |
| `GET /favourites`                                                                     | Caller’s live favourites across spaces they can still access                                       |
| `GET/POST /spaces/:space/daily/:date`, `POST …/daily/append`                          | Read/create one daily note; append quick-captured text                                             |
| `GET/POST /spaces/:space/collections`, `GET/PATCH/DELETE /collections/:id`            | Collection list and lifecycle                                                                      |
| `POST/DELETE /collections/:id/items…`, `POST …/move`, `POST …/pin`                    | Add, remove, order and pin collection items                                                        |
| `GET/POST /spaces/:space/views`, `PATCH/DELETE /views/:id`                            | Validated private/shared saved views, with optimistic versions                                     |
| `GET/POST /spaces/:space/templates`, `GET/PATCH/DELETE /templates/:id`                | Templates, archive/delete/default and optimistic versions                                          |
| `POST /objects/:id/apply-template`                                                    | Append template content and fill only empty properties                                             |
| `GET /objects/:id/export`                                                             | Markdown or JSON, membership checked                                                               |
| `GET /spaces/:space/export`                                                           | Owner-only JSON or ZIP, optional revision history                                                  |
| `GET /search?q=`                                                                      | Bounded search by space, type, tag, status and updated date                                        |

## What's in the app now

- **Home**: quick capture to Inbox or today's note, pinned knowledge, recent daily notes and recently edited objects.
- **Daily notes**: create on demand, date picker, previous/today/next navigation, autosave, history and ordinary search/link behaviour.
- **Inbox**: captured items (first line as title). **Done processing** files them, one at a time or in bulk.
- **All knowledge, Archive, Trash**: filter by type, tag, links and created/updated dates; sort; save/rename/delete views; bulk archive, trash and restore; load more.
- **Collections**: create, rename, browse, add/remove/reorder/pin objects and delete the collection without deleting its contents.
- **Favourites and pins**: personal shortcuts and editor-managed shared pins, reflected consistently in navigation and object actions.
- **Templates**: list, create, edit, archive/delete, set a type default and create independent objects with copied content and property defaults.
- **Discover**: unlinked/no-backlink/no-outgoing tabs with counts, plus explainable related suggestions.
- **Object page**: editable title; editor with toolbar, `/` commands, `[[` links with "Create…", Markdown shortcuts, undo/redo; autosave and conflict handling; type, properties, tags, collections, favourite/pin, links, backlinks, related knowledge, history, status actions and Markdown/JSON export.
- **Search**: ranked, highlighted, filterable, all spaces or one, keyboard navigation.
- **Object types**: create and edit types and properties, reorder, archive.
- **Space settings and export**: name/time zone, members/roles, new shared space, audit trail and full JSON/ZIP export with optional revisions.
- **Command menu**: keyboard-driven navigation, search and capture actions.
- Works on phones: the Playwright tests run on Pixel 7 emulation as well as desktop, and fail on any horizontal overflow or any serious or critical axe accessibility issue on a Knowledge page.

## Not done yet

| Area                      | Milestone | Notes                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attachments and images    | 4         | Private R2 keys, authenticated membership-checked downloads, size/MIME controls, deletion cleanup and attachment-aware export/backups. No SVG or HTML inline.                                                                                                                                                                    |
| Capacities import         | 4         | Inspect a real export first. Preview, type/property mapping, attachment ingestion, `source_system`/`source_id` idempotency, link reconstruction and reconciliation. Never deletes in Capacities.                                                                                                                                 |
| In-app export restoration | 4         | The v1 format and isolated restore implementation are verified, but there is no user-facing or production restore route. Add preview, collision handling and an explicit safe destination before exposing it.                                                                                                                    |
| Semantic search           | 5         | **Built in Daly Intelligence, off by default** ([INTELLIGENCE.md](INTELLIGENCE.md)): structure-aware chunks, incremental embedding, a Vectorize namespace per space, hybrid ranking with FTS, access checked after retrieval. Shown on Search ("Related by meaning") and under Related knowledge.                                |
| AI and authenticated MCP  | 5         | MCP first part built (not yet deployed; gateway in `mcp/`, [MCP.md](MCP.md)): space-scoped reads, search, daily notes, create and append. No body replacement, trash or delete. AI features with metering and budgets are now Daly Intelligence ([INTELLIGENCE.md](INTELLIGENCE.md)). Nothing runs or costs anything by default. |

Known limitations of this release:

- Lists show up to 200 objects at a time, with Load more. Search returns the best 50.
- Links between spaces aren't supported (by design for now).
- Collaborative real-time editing isn't supported. Simultaneous edits are detected and never silently overwritten, but they aren't merged.
- The editor bundle (about 190 KB gzipped) loads only on object pages.
- Full-space browser export is owner-only and bounded to 100,000 records / about 20 MB of stored source data; use the verified database backup for a larger space.
- Markdown is intentionally readable rather than lossless; `manifest.json` is the restoration format. Attachments do not exist yet.

## Decisions for the owner

1. **Review and merge the Milestone 3 PR only after its checks complete.** PR #22 and #23 supplied the foundation; this branch continues them rather than replacing them.
2. **Approve applying `0013` and `0014` to staging, then production.** Both are additive. Merging to `main` deploys and migrates automatically. Take `npm run db:backup -- --env production` first; the updated backup script is required after FTS5 exists.
3. **Who gets Knowledge.** Currently portal owners and admins (`knowledge.use`). Note that the second portal owner gets their own private space, and neither owner can see the other's.
4. **Editor dependency:** Tiptap 3.31.4 (MIT), pinned exactly. The Untitled UI PRO text editor component uses it too.
5. **RFS data:** confirm the data-governance position before any NSW RFS material is entered or imported.
