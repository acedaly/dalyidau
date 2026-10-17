# Knowledge Engine — Phase 1

Status: **foundation only, not deployed**. Initial schema: `migrations/0013_knowledge_engine.sql`.

## Outcome
Replace paid Capacities storage with a durable, searchable, linked knowledge system inside `/portal/knowledge`, retaining independent ownership of content. AI is an optional interface; all core functions work without a model or external AI subscription.

## Confirmed existing architecture
- React 19 / Untitled UI portal at `src/portal`, server routes at `worker/portal`.
- D1 binding `DB`, R2 binding `MEDIA`.
- Cloudflare Access JWT checks, role-based access and existing portal audit design.
- Public GitHub repository: never commit real notes, files, recordings, tokens or exports.
- Production is deployed via GitHub Actions on main; do not merge or migrate without owner approval.

## v1 scope
1. Separate private personal and shared spaces. Every query filters by server-verified membership, not a request-supplied user ID.
2. Types with schema-defined properties: Page, Project, Person, Meeting, Decision, Resource, Incident and Shift (configurable). Sensitive workplace/incident records must not be imported without data-governance approval.
3. Markdown editor with autosave, revision history, optimistic version checking, archive and recoverable trash.
4. Link any objects with typed, navigable bidirectional relationships and backlinks.
5. Tags; filters by type, space and status; fast full-text keyword search with FTS5.
6. Attachments in R2 with UUID-based private keys and authorised upload/download routes; no public bucket URLs.
7. Bulk import of Capacities markdown/JSON and attachments with dry-run, source ID mapping, duplicate detection, detailed import report and rollback of failed batches.
8. Full export in Markdown + JSON + attachment manifests; no vendor lock-in.

## Deferred (separate follow-up PRs)
- Semantic search (Vectorize, embeddings, per-document chunk citations); FTS5 first.
- AI read/search/write tools with scoped permissions and approval for changes.
- Todoist task management, recurrence and reminders (Phase 2).
- Recording, speaker diarisation and transcription (Phase 4).

## Backend API sketch (all require Access auth; never expose via public routes)
- `GET/POST /api/portal/knowledge/spaces`
- `GET/POST /api/portal/knowledge/types`
- `GET/POST /api/portal/knowledge/objects`
- `GET/PATCH/DELETE /api/portal/knowledge/objects/:id`
- `GET /api/portal/knowledge/objects/:id/revisions`
- `GET/POST/DELETE /api/portal/knowledge/relations`
- `GET /api/portal/knowledge/search?q=...`
- `POST /api/portal/knowledge/attachments/init` + scoped upload/download
- `POST /api/portal/knowledge/import/preview` then explicit confirm

## Security requirements before shipping
- Authentication and role checking on every route and membership validation for both ends of relations, tags, object types, and attachments.
- Never trust `space_id`, `created_by`, `updated_by`, or a role from the browser. Derive principal from a verified token.
- Tenant/space isolation tests must prove a user in one space cannot read, search, mutate or discover data from another space.
- Strict payload size limits, upload MIME and content checks, sanitised Markdown rendering and safe links; no raw HTML execution.
- Audit all writes; no sensitive text or bearer tokens in logs; rate limit imports and uploads.
- Revisions written atomically with current object updates; compare `version` to avoid overwriting simultaneous edits.
- Soft delete with deliberate retention policy and recoverability.
- Encrypted Cloudflare storage at rest isn't the same as client-side end-to-end encryption: don't claim E2EE.
- Independent scheduled D1/R2 backups with tested restore procedure. Existing blog backups may not cover this data.
- Migrations are additive; take pre-deploy backup and test on staging before production approval.

## Build order
A. Foundation schema and this specification (current PR).
B. Authenticated API with contract tests, authorisation and audit tests.
C. Knowledge UI in the existing sidebar, responsive objects list/detail/editor and search.
D. Capacities importer in preview mode, then controlled imports.
E. R2 upload/export, revision restore, backup verification.
F. Optional semantic search and ChatGPT / Claude integration.

## Acceptance criteria before ending Capacities Pro
- Can create/edit/search a note on phone and desktop.
- Can create custom object types and properties, links and backlinks.
- Can attach and retrieve private files; can restore prior versions.
- Unauthorised cross-space access is denied including search.
- Export and restore tested against a nontrivial sample.
- Imported notes, metadata, links and attachments reconciled against source.
- No regression to wedding/blog; lint, typecheck, Vitest and Playwright pass.

## Important implementation note
This migration introduces structural tables only. There is **no API, UI, seed data, entitlement configuration, migration application, or deployment** in this PR. Schema constraints do not replace route-level membership enforcement. In particular validate that object IDs in relations and attachments belong to the stated space, in transactional server code before inserting.
