# Home & Assets (Milestone 10)

`/portal/assets`: what the household owns, maintains, insures or will need to replace. Vehicles and trailers, the home and rentals, servicing and repairs, warranties, insurance, receipts and manuals, values, QR labels and reports, with links into Daly Calendar, Today, the Chief of Staff and MCP.

> **Retired:** "Create task", automatic tasks and links to Knowledge notes were removed with Daly Tasks and Daly Knowledge. Their routes answer 410, `assets_create_task` and `assets_link_knowledge` are refused with `"retired"`, and `asset_task_links` and `asset_knowledge_links` are kept untouched until the owner approves the cleanup. See [DECOMMISSION_KNOWLEDGE_TASKS.md](DECOMMISSION_KNOWLEDGE_TASKS.md).

Nothing here is live until it's deployed, and nothing has been deployed. Migration `0026_home_assets.sql` hasn't been applied anywhere shared. Both feature switches it adds are off.

**Principles.** Capture once, reuse everywhere. Only a name and a category are needed. Nothing is invented: no service interval, value, date, registration number or cover is assumed, and "not recorded" is never shown as zero. AI proposes, people approve. Private unless shared, with each right shared separately.

## Contents

- [Who can use it](#who-can-use-it) · [Sharing and permissions](#sharing-and-permissions)
- [Pages](#pages) · [Asset register](#asset-register) · [Vehicles and trailers](#vehicles-and-trailers) · [Places and rentals](#places-and-rentals)
- [Maintenance](#maintenance) · [Insurance](#insurance) · [Warranties](#warranties) · [Values](#values)
- [Files: photos and documents](#files-photos-and-documents) · [QR labels](#qr-labels) · [Capture and AI](#capture-and-ai)
- [Integrations](#integrations) · [Reminders and the cron](#reminders-and-the-cron) · [Reports and export](#reports-and-export) · [MCP](#mcp)
- [Data model](#data-model-0026_home_assetssql) · [API](#api) · [Security](#security)
- [Deploying](#deploying) · [Rollback](#rollback) · [Backup and restore](#backup-and-restore) · [Testing](#testing) · [Known limitations](#known-limitations)

## Who can use it

A new portal permission, `assets.use`, is given to owners and admins (like `calendar.use`). Editors and viewers can't open it. Being a portal owner grants nothing inside it: neither owner can see the other's private assets.

## Sharing and permissions

Code: `worker/assets/access.ts`. Every read and write goes through it.

| Who                                      | Sees                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| The asset's owner                        | Everything, and only they can share, delete or make a new label version.        |
| A person it's shared with (their email)  | It, plus whichever of these were ticked for them: see below.                    |
| The household (`asset_shares.email '*'`) | Everyone who can open Home & Assets sees it, plus whichever rights were ticked. |
| Anyone else                              | Nothing. The API answers 404 (never 403), so ids can't be probed.               |

The rights, each separate: **edit** (details, vehicle details, warranties, photos; implies maintain), **record maintenance** (maintenance, problem reports, odometer, moving it), **see values and costs**, **see insurance**, **open documents**. Photos are visible to everyone the asset is shared with; receipts, invoices, manuals and other documents need the documents right. A person's rights are their own row and the household row together. Sharing with someone checks they can open Home & Assets (`canUseAssets`).

So household sharing never means everyone sees values, insurance or documents: the default household share (Quick add's "Share with the household") is view only.

**Places** (`asset_locations`) are private to whoever added them, or shared with the household (optionally with edit). An asset in a place you can't see shows "In a place not shared with you"; the place's name, address and lease never leak through the asset. **Policies** are private or shared with the household the same way. Someone with the insurance right on an asset but no sight of the policy sees only the asset's coverage state.

Server-side everywhere: the API, the page loaders, search, reports, reminders, Calendar overlays, Today, the Chief of Staff and MCP all use the same functions.

## Pages

| Address                                       | What                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/portal/assets`                              | Overview: totals (unvalued assets counted, not zeroed), needs attention in 30/60/90 days, reminders, recent repairs and purchases, items missing documents                          |
| `/portal/assets/all`, `/vehicles`             | The register: search, filters (category, place, owner, status, warranty, insurance, maintenance, condition, sharing, value range, tag), list or cards, bulk changes, label printing |
| `/portal/assets/item/:id`                     | One asset: overview, maintenance, photos & documents, warranty & insurance, value, history; QR label, sharing, update location, report a problem, add service entry                 |
| `/portal/assets/property`, `/property/:id`    | Places and rentals, inspections, leases, maintenance requests                                                                                                                       |
| `/portal/assets/maintenance`                  | Due now, all open, history, schedules, templates                                                                                                                                    |
| `/portal/assets/insurance`                    | Policies (verification, premium history, linked assets, documents, renewal, claims) and the coverage overview                                                                       |
| `/portal/assets/warranties`                   | Every warranty, with how its end date was worked out, and claims                                                                                                                    |
| `/portal/assets/documents`                    | Every file you can open, your capture inbox, missing documents, retention review                                                                                                    |
| `/portal/assets/reports`, `/reports/register` | CSV reports, the printable household register, inventory and insurance claim pack                                                                                                   |
| `/portal/assets/capture`                      | Quick add, from a photo, from a receipt, scan                                                                                                                                       |
| `/portal/assets/labels`                       | Printable QR labels                                                                                                                                                                 |
| `/portal/assets/search`                       | Search across assets, maintenance, documents and places                                                                                                                             |
| `/portal/assets/settings`                     | Reminders, Today and briefings, thresholds, retention, categories and custom fields, AI status, recently deleted                                                                    |

The application has a launcher card and its own sidebar sections. Everything is Untitled UI PRO components (`PageHeader`, `DataTable`, `PortalDialog`, `RecordPanel`, `Tabs`, `ButtonGroup`, `FileUpload`, `MetricCard`, badges, inputs). Light and dark themes come from the tokens; the browser tests check every page at desktop and Pixel 7 widths with axe.

## Asset register

`worker/assets/assets.ts`. Fields: name, category, manufacturer, brand, model, serial number, barcode, description, purchase date, price and place, condition, status, ownership (a label like "Joint"), place, notes, tags, custom fields, depreciation model, disposal (date, method, amount, notes), cover photo, label version and visibility.

**Categories** (`src/shared/assets/categories.ts`): vehicles, trailers & caravans, motorcycles, boats, camping, appliances, electronics, computers, phones & tablets, cameras, tools, furniture, outdoor, home security, personal valuables, other, plus household categories (`acat_` ids). Any category can have custom fields (text, number, date, yes/no, choice); values are checked against the category's fields.

**Writes** carry the record's version (compare-and-set): a stale edit is refused with 409, never overwrites. Create takes a retry key (`clientId`). Bulk edit (category, status, condition, place, owner label, tags) skips assets the caller can't edit and says how many. Delete is owner-only, needs the typed confirmation, hides the asset at once and is restorable from Settings for 30 days.

## Vehicles and trailers

`asset_vehicles`, created automatically for vehicle categories. Registration and jurisdiction, registration expiry, VIN, engine number, make, model, year, odometer unit (km, miles or hours), roadside assistance (provider, membership, renewal), next inspection or roadworthy, battery installed. Towed vehicles add ATM, GTM, tare and ball weight (kg, as plated) and descriptive specs: brakes and controller, bearings, coupling, electrical, water, house batteries, suspension, tyres, modifications, accessories, towing equipment.

**Odometer history** (`asset_odometer`): a reading lower than an earlier one (or higher than a later one) is refused unless marked a correction; readings can't be in the future. Completing maintenance with an odometer reading records it if it fits the history.

Nothing is looked up or pre-filled. The examples in the brief (a Hilux, a Cub Camper Frontier) are not created: add them yourselves with your own registration, VIN and values.

## Places and rentals

A place: home, rental, garage, shed, storage, room (inside another place), vehicle or camper. Rentals record tenure, lease dates, property manager or landlord contact, next inspection, utilities and notes. Maintenance at a place records **responsibility** (us as owner, us as tenant, landlord or property manager, shared, not sure yet), a request reference and date, and **approval** (not needed, waiting, approved, declined). The pages say plainly that responsibility is the household's understanding of its lease, not legal advice, and that recording a request doesn't mean a change is approved.

## Maintenance

`worker/assets/maintenance.ts`, rules in `src/shared/assets/engine.ts` (the only place due dates are calculated).

- **Schedules** recur by date, by distance, or both (whichever comes first). The next due date is the last done date plus the interval, or the first due date the person gave; the next due distance likewise from the last reading. With no starting point, or a distance rule and no odometer reading, the state is **unknown**, with the reason shown ("Record an odometer reading…"). Month arithmetic clamps to the month's end (31 Jan + 1 month = 28 Feb).
- **States**: overdue, due soon (your "due soon" days and distance, default 30 days and 1,000), upcoming, unknown.
- **Records**: preventive, corrective, one-off repair, inspection, service, replacement, seasonal, safety; priority; status (to do, requested, booked, in progress, completed, cancelled); due date or distance; booked date and time; completion date, odometer, cost, provider, notes, checklist, files and a Calendar appointment.
- **Completing** moves the schedule on from the actual completion date and reading, and (if the schedule is set to) creates the next record. A unique index allows one open record per schedule, so completing twice, a retry or two people at once can't create two. Completing again returns "already done".
- **Templates**: the built-in ones (vehicle service, trailer bearings, tyres, registration, smoke alarm, air-conditioner filter, camera batteries, equipment inspection, battery replacement, rental inspection) carry a title, a checklist and where to find the interval: **no intervals**, because those depend on the make, model, use or lease. Household templates keep the intervals the household chose.

## Insurance

`worker/assets/insurance.ts`. Provider, type (motor, caravan and trailer, home, contents, home and contents, landlord, personal property, travel, other), name, policy number, period, premium and how often it's paid, excess, your summary of cover, limits, exclusions, contacts, notes, status and the policy it replaced.

- A policy is the household's record of the documents, not a guarantee. It's **verified** only when a person confirms it against the documents; changing any fact clears that, and so does a renewal.
- An asset's coverage state is **"Linked to a verified policy"** only when a linked policy is verified, active and not past its renewal date; otherwise "not yet verified", "has lapsed", "no policy linked", or "not shared with you". The word "insured" is never used.
- **Premiums** are kept per period (`asset_policy_premiums`), so a renewal shows the change on a yearly basis (frequencies are converted where they're regular).
- **AI extraction** (optional, see below) proposes fields and coverage statements beside the original document, each with the quoted words it came from; ambiguous wording is left out; applying a suggestion marks the fields unverified until the person checks them.

## Warranties

`worker/assets/warranties.ts`. Manufacturer, extended, retailer or other; provider, start, length in months, stated end date, reference, terms, claims contact, cost. The end date is **stated** (as entered) or **calculated** (start, or the purchase date, plus the months, recalculated when the purchase date changes), otherwise **unknown**. States: active, ending soon, ended, unknown. Claims (warranty, insurance, or an Australian Consumer Law request) record what was claimed, the outcome and amounts.

Every warranty view shows the consumer-law note (`CONSUMER_LAW_NOTE`): a stated warranty is in addition to the ACL guarantees, which don't necessarily end with it. General information, not legal advice.

## Values

`asset_valuations` keeps every figure with its **basis**: your estimate, actual transaction, verified sale, professional appraisal, or insurer's figure; kinds are current, replacement, sale, disposal and agreed value. The purchase price is the actual transaction amount. **Depreciation is off** until a person turns on a model for an asset (straight line to a residual, or reducing balance); its result is a **formula estimate**, worked out when read and never stored. There are no market valuations. Totals count assets with and without a value separately; an asset without a value is never counted as $0. A low-value threshold (Settings) leaves cheap items out of summaries and reports; unknown values are never left out by it.

## Files: photos and documents

`worker/assets/files.ts`. Kinds: photo, receipt, invoice, registration, policy, warranty, manual, service record, inspection report, repair quote, other. Photos are tagged (at purchase, condition, damage, repair, inspection), have captions, and one is the cover.

- **Storage**: R2 under `private/assets/<file id>/<random 128-bit>`, which no public route serves. A file belongs to one asset (optionally one of its maintenance records, warranties or claims), one place, one policy, or the uploader's own capture inbox.
- **Checks**: the type comes from the bytes. JPEG, PNG, WebP, PDF, plain text, Word (.docx) and Excel (.xlsx) only; SVG, HTML, HEIC and other archives are refused. Office files are checked for decompression bombs (`zipBombReason`, shared with Intelligence). Limits: 10 MB documents, 8 MB photos, 300 KB previews, 200 files per asset.
- **Metadata**: photos are resized in the browser (2048 px, plus a 480 px preview) and re-encoded as JPEG, which drops EXIF; the Worker strips any EXIF/XMP/IPTC/comments from JPEG, text and EXIF chunks from PNG, and EXIF/XMP from WebP before storing. PDFs and Office files are stored as they are.
- **Duplicates**: the same file (SHA-256) on the same record isn't stored again; the same file on another asset you can see is pointed out.
- **Downloads** (`/api/portal/assets/files/:id/content`, `/thumb`) only after the record's own checks: `private, no-store`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`. Images are served inline (so they can be shown); everything else is an attachment, never rendered. There are no public or temporary links: none is needed, since every reader is signed in.
- **Retention**: deleting a file removes it from R2 at once. A deleted asset's files are removed 30 days later by the cron (restore before then keeps everything). Settings → Document retention lists documents of things disposed of more than N years ago for review; nothing is ever deleted automatically on that basis. There's no virus scanner: files are never executed or rendered as HTML and are only served to the household, the same strategy as Intelligence attachments.

## QR labels

`worker/assets/qr.ts`, `src/shared/assets/address.ts`. Each asset's label encodes `https://daly.id.au/portal/assets/item/<id>?v=<label version>`: no name, serial, place or value, and no access by itself. Opening it goes through Cloudflare Access and then the asset's own rights (no access: 404). **New label version** (owner) bumps the version for a reprint; the id and address never change, so old labels keep working and the page notes when a scanned label is older. The labels page prints a sheet (small or large, with or without names).

**Scanning**: on iPhone, the Camera app reads the label and opens the page. In browsers with `BarcodeDetector` (Chrome on Android, desktop Chrome), Capture → Scan reads QR codes and product barcodes from the camera. A code that's this portal's asset address opens the asset; any other web address is refused and never followed; anything else is matched against your own barcodes and serial numbers (no outside product catalogue). Typing a code always works.

## Capture and AI

Quick add needs a name and a category. **From a photo** and **from a receipt** store the file in your capture inbox first, then create the asset with it attached. Everything works with AI off.

AI help (receipt reading, suggesting what a photographed item is, extracting policy details) needs **both** the `assets.ai` switch (off by default) **and** Daly Intelligence on with its Documents feature and Workers AI connected. It goes through `worker/intelligence/provider.ts` (switches, the "documents" budget, circuit breaker, usage without content). The document's text (Workers AI Markdown Conversion; for a photo, its description) reaches the model only inside `fence()`. Output is validated by a strict schema and then **grounded**: a value counts only if it, or its digits, appears in the document's text (dates in Australian forms, amounts with or without separators), and each comes with the words it was found in. A photo identification is never more than "medium" confidence, and only "medium" when a visible maker and model back it up. Nothing is saved: the proposal fills a form the person reviews; ungrounded values are shown as "not found in the document" and aren't put into the form.

The local stand-in (`AI_PROVIDER=mock`, tests) answers these with fixed text patterns: it proves the pipeline, not a model's quality. Maintenance summaries, natural-language search and AI-suggested templates aren't built (see limitations).

## Integrations

- **Daly Calendar**: asset dates appear as **reminders** in Calendar's overlay (a chip with a package icon, labelled a Home & Assets reminder, never an event), only for assets the viewer can see; each person can turn them off in Calendar → Settings (`overlays.assets`). A booked service can become a real **appointment** through Calendar's `createEvent`, once per record (retry key `asset-appt-<id>`).
- **Today**: a "Home & Assets" section (on by default, per person) with what's overdue or due in 30/60/90 days, each a sentence from a record.
- **Chief of Staff**: `chief_of_staff_daily_context` adds `homeAssets` (overdue and due in 30 days, facts and links) for people with `assets.use` who haven't left it out. Example: "Cub Camper Frontier registration is due in 21 days." Deterministic; no model.

## Reminders and the cron

`worker/assets/notify.ts`, run from the existing cron once an hour (the first 15-minute run). For each person who can open Home & Assets (bounded to 25 a run): reminders for their own records (and, if they chose household reminders, what's shared with them), at each offset from their settings per kind (maintenance, registration, insurance, warranty, inspection, lease, roadside; schedules can set their own) and once more the day after it's missed. `asset_notifications` is unique per person, item, date and offset, so nothing is repeated. Rows hold ids and dates only; text is worked out when read, and a reminder whose record no longer needs attention isn't shown.

**Email** only when the owner turns on `assets.reminders.email` (off by default), an email provider is configured (`EMAIL_DELIVERY`), and the person ticked email for that kind. The email says "You have a Home & Assets reminder" unless they chose to include details. Retries are bounded (three attempts).

The same step purges deleted assets (50 files a run). Each part is contained; a failure is logged without content and never stops the others.

## Reports and export

`worker/assets/reports.ts`: asset inventory, estimated values (each labelled), assets by category, maintenance history, annual maintenance spend (recorded costs only, with the number of records without one), insurance renewals with previous premium, warranties, vehicle costs, household inventory by place, insurance claim documentation. CSV through the portal's own `toCsv` (formula injection neutralised). Printable pages (register, inventory, claim pack) print or save as PDF from the browser; the portal's pdf-lib PDFs are for invitations and leave, and a server-side register PDF isn't built. Every export is recorded in the history (who, which report, never contents). Everything respects rights: unshared values are "not shared", unrecorded figures are blank.

## MCP

`worker/mcp/assets.ts`, advertised by the gateway in `mcp/src/portal-tools.ts` (`test/mcp-contract.test.ts` compares them field by field). 14 tools (of the gateway's 66 in 3.0.0), all needing `assets.use`.

- **Read**: `assets_search`, `assets_list`, `assets_get`, `assets_maintenance_history`, `assets_upcoming_maintenance`, `assets_insurance_renewals`, `assets_warranty_expiries`, `assets_list_documents` (names and kinds only, never contents or R2), `assets_summary`, `assets_get_attention`.
- **Write** (through `mcp_writes`, ids only; send a `requestId`): `assets_create`, `assets_update` (version required), `assets_create_maintenance`, `assets_complete_maintenance`.
- **Retired** (refused with `"retired"`): `assets_link_knowledge`, `assets_create_task`.
- **Absent on purpose**: delete, sharing, uploads, bulk, policy changes.

Outputs omit values, costs and insurance the caller can't see ("not shared with you"); another person's private asset is `not_found`. The gateway's instructions say to report records as given and never call something insured.

## Data model (`0026_home_assets.sql`)

| Table                                                                 | Holds                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `asset_preferences`                                                   | Each person's settings (JSON, validated without rejecting newer fields)                               |
| `asset_categories`                                                    | Household categories, and custom fields for any category                                              |
| `asset_locations`                                                     | Places, rental details, visibility                                                                    |
| `assets`                                                              | The register; `visibility` kept in step with `asset_shares`                                           |
| `asset_shares`                                                        | Person or household (`'*'`) grants: edit, maintain, financial, insurance, documents (edit ⇒ maintain) |
| `asset_vehicles`, `asset_odometer`                                    | Vehicle details, specs JSON, readings                                                                 |
| `asset_valuations`                                                    | Values with kind and basis                                                                            |
| `asset_maintenance_templates`, `asset_schedules`, `asset_maintenance` | Templates, recurring rules with stored next due, records (one open per schedule)                      |
| `asset_policies`, `asset_policy_premiums`, `asset_policy_links`       | Policies (verification, unverified AI fields), premium history, linked assets                         |
| `asset_warranties`, `asset_claims`                                    | Warranties (end date basis) and claims                                                                |
| `asset_files`                                                         | File rows (R2 keys under `private/assets/`, SHA-256, at most one parent)                              |
| `asset_knowledge_links`, `asset_task_links`                           | Retired links to Knowledge objects and tasks. Kept, unread, until the approved cleanup                |
| `asset_notifications`                                                 | Reminders, one per person, item, date and offset; email state                                         |
| `asset_activity`                                                      | History: ids and action names, never names, identifiers, amounts or addresses                         |

Money is whole cents; NULL is "not recorded". CHECK constraints refuse impossible rows (negative amounts, edit without maintain, a schedule without an interval, a completed record without a date, a file key outside `private/assets/`). Indexes cover owner, category, place, barcode, due dates, renewal dates, expiry dates and file hashes. Everything is additive except **`mcp_writes`, rebuilt** with every row copied (same columns and indexes) to accept the outcomes `asset`, `asset_maintenance` and `asset_link`, as in 0020–0023. There are no virtual tables, so `wrangler d1 export` and `npm run db:backup` work unchanged.

## API

`/api/portal/assets/*` (`worker/assets/api.ts`), behind the portal's Access, role and same-origin checks plus `assets.use`: overview, preferences, people, notifications, categories, search; items (list with the same filters as the page, create, get, update, delete, restore, bulk, sharing, location, cover, label, qr.svg, problem, odometer, valuations, warranties); warranties, claims; locations; maintenance (create, update, complete, cancel, appointment, files), schedules, templates; policies (create, update, verify, renew, assets, extract); files (upload as base64 JSON, update, delete, content, thumb); capture (status, receipt, photo); reports/`:name`.csv.

## Security

- Cloudflare Access and the portal's JWT check on every page and API call; `assets.use`; then per-asset rights (404 for anything not visible). Same-origin and Sec-Fetch-Site checks on every request, including downloads and exports.
- Serial numbers, registrations, VINs and policy numbers are visible only to people who can see the asset or policy; addresses only with the place. Logs carry tool names, error codes and ids, never content (`asset_activity`, `mcp_call`, `asset_reminders`).
- No public endpoint serves anything from Home & Assets. QR codes hold only an address that still needs sign-in.
- Uploads: byte-sniffed types, refused SVG/HTML/HEIC/archives, size limits, ZIP-bomb check, metadata stripping, unguessable keys, sandboxed downloads.
- AI: off by default, fenced input, schema validation, grounding, nothing saved without a person.
- MCP: re-verified Access token, no identity in arguments, the same functions and rights, the write ledger, no delete or sharing tools.

## Deploying

Owner-approved, in this order:

1. Merge (which deploys the portal Worker and applies `0026` through the usual workflow: restore point, migrate, verify, deploy).
2. `npm run db:verify -- --env production`: the Home & Assets integrity checks (sharing matches visibility, no owner shares, file keys, schedules have an interval, one open record per schedule, JSON valid) run with the others.
3. Deploy the MCP gateway by hand after the portal (`npm run mcp:deploy:dry-run`, then `npx wrangler deploy --config mcp/wrangler.jsonc --env production`). The current gateway is 3.0.0: see [MCP_CUTOVER.md](MCP_CUTOVER.md).
4. Optionally, in Portal settings → Features → Home & Assets: **Home & Assets AI suggestions** (also needs Intelligence and its documents feature) and **Home & Assets reminder emails** (also needs `EMAIL_DELIVERY`). Both off until then.

No new binding, secret, route, DNS or Access change. R2 uses the existing `MEDIA` bucket.

## Rollback

- **Code**: `wrangler rollback` to the previous portal Worker. It never reads the new tables and writes only ledger outcomes the rebuilt `mcp_writes` still accepts, so the migration can stay. The Calendar preference key `overlays.assets` is dropped by the older Worker's (non-strict) overlay parser.
- **Features**: turn the two switches off; nothing else changes.
- **Data**: the tables can be left in place. If they ever had to go, drop them (children first, as in `test/portal-helpers.ts`) and delete `private/assets/` from R2; `mcp_writes` would keep its widened CHECK, which is harmless.

## Backup and restore

- D1 Time Travel and `npm run db:backup` cover every table (no virtual tables). `npm run test:backup` now seeds and restores Home & Assets rows and checks their rules survive.
- `npm run backup:r2 -- --env production --encrypt` now also copies every stored asset photo and document (previews are derived and skipped), verified against `asset_files`.
- Restoring a single asset: Settings → Recently deleted (30 days), or Time Travel for anything else.

## Testing

- `test/assets.test.ts`: register, values, vehicles, trailer specs, odometer rules, the maintenance engine (intervals, month ends, whichever-comes-first, unknown), templates without intervals, completion and next record (once), problem reports, rental requests, insurance verification and lapse, premium history, warranties, private and shared assets, selected rights, private places, uploads (sniffing, refusals, metadata stripping, duplicates, sandboxed downloads, deletion from R2), QR encode/decode and label versions, every page.
- `test/assets-integrations.test.ts`: attention items from records only, the retired task and Knowledge routes refused, completing maintenance without touching earlier links and with no automatic tasks, Calendar overlays and appointments, Today and the Chief of Staff, MCP (visibility, ledger replay, conflicts, maintenance, retired tools refused), reminders (once only, email off by default, opt-in, household), AI off and on (grounding, ungrounded values, photo confidence, policy statements), reports (visibility, formula neutralising, spend), migration rebuild, database rules, purge.
- `e2e/assets.spec.ts` (desktop and Pixel 7): every page fits and passes axe; launcher and Quick add; completing scheduled maintenance; photo upload; scanned label (and refusing other addresses); Today.
- Updated: MCP contract and gateway tests, Chief of Staff sources, feature switch labels, backup round trip.

## Known limitations

- **No production data**: nothing is imported. The Hilux and Cub Camper Frontier must be added by hand with real details.
- **Barcode scanning** depends on the browser's `BarcodeDetector` (not on iPhone Safari, where the Camera app opens QR labels and barcodes are typed). No product catalogue is used.
- **HEIC photos** that a browser can't draw are refused; choosing them from the Photos library on iPhone converts them.
- **AI**: receipt, photo and policy suggestions only. Maintenance summaries, natural-language search, AI-suggested templates and asset insights in Intelligence briefings aren't built; the deterministic Chief of Staff facts are. Real model quality is untested (no live model has been called).
- **PDF**: printable pages use the browser's Save as PDF; there's no server-side PDF register.
- **Office documents and PDFs** keep their own metadata (only images are stripped).
- **Today's notification list** doesn't include Home & Assets reminders; they're in Home & Assets' Overview, Today's own section and email.
- **Household reminders** go to people who opted in, for what's shared with them; there's no per-asset notification list.
- **Bulk sharing** isn't offered; share each asset on its page.
- **Calendar overlay** reminders are worked out on each Calendar request from the person's snapshot; with very many assets this is the main cost (bounded to 300 items a window).
