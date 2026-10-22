# Household Finance (Milestone 11)

`/portal/finance`: the household's accounts, imported bank transactions, balances checked against the bank, categories and where the money goes. Built so that importing a bank's CSV export (NAB first) replaces typing transactions in, and so that a paid budgeting app isn't needed.

Milestone 11.1 (this document's main subject) is the financial foundation. Budgets, bills, savings goals, reports and integrations follow in 11.2–11.4 ([plan](#plan-111114)).

Nothing here is live until it's deployed, and nothing has been deployed. Migration `0031_household_finance.sql` hasn't been applied anywhere shared. There are no feature switches: nothing in 11.1 contacts anyone or anything outside the Worker.

**Principles.** The bank's own export is the source; nothing is invented (no balance without a starting balance, never "$0" for unknown). Deterministic parsing and maths in integer cents, no AI. Nothing reaches the ledger without a person reviewing it. Never import the same transaction twice. Private means private everywhere, including totals.

## Contents

- [Repository assessment](#repository-assessment-23-october-2026) · [Plan 11.1–11.4](#plan-111114) · [Decisions](#architecture-decisions)
- [Who can use it](#who-can-use-it) · [Pages](#pages) · [Accounts and balances](#accounts-and-balances) · [Importing](#importing-csv)
- [Duplicates](#duplicates) · [Categorising](#categorising) · [Transfers](#transfers) · [Overview maths](#overview-maths)
- [Data model](#data-model-0031_household_financesql) · [API](#api) · [Security](#security) · [Testing](#testing)
- [Deploying](#deploying) · [Rollback](#rollback) · [Backup and restore](#backup-and-restore) · [Known limitations](#known-limitations)

## Repository assessment (23 October 2026)

Read before building: `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`, `PORTAL.md`, `DATABASE.md`, `HOME_ASSETS.md`, `MCP.md`, and the Home & Assets code, which Finance follows most closely.

| Area | What's there | How Finance uses it |
| --- | --- | --- |
| Identity and roles | Cloudflare Access JWT verified server-side on every page and API call (`worker/portal/auth.ts`); roles → permissions (`src/shared/portal/permissions.ts`); same-origin and `Sec-Fetch-Site` checks on every API call | A new permission, `finance.use`, owners only. No new auth. |
| Applications | Registry in `src/shared/portal/applications.ts` (launcher card, sidebar), page loaders in `worker/portal/pages.ts`, per-app API routers mounted in `worker/portal/api.ts` | A `finance` application, `worker/finance/{api,pages}.ts` |
| Household sharing | Home & Assets: per-record owner, shares (person or household `'*'`), 404 for anything not visible | Simpler: an account is its owner's (private) or the household's (shared). Transactions follow their account. |
| D1 conventions | Forward-only additive migrations; ids `prefix_` + 14 chars; money as whole cents; NULL = not recorded; compare-and-set `version`; retry keys (`client_id`); content-free history tables; every write and its history in one batch | All followed. `mcp_writes` untouched (no MCP until 11.4). |
| CSV | RFC 4180 parser (`worker/portal/csv.ts`), formula-safe export (`src/shared/portal/csv.ts`), guest import's preview → apply pattern | Reused for both. |
| UI | Untitled UI PRO components already in `src/components` and the portal wrappers (`PageHeader`, `DataTable`, `PortalDialog`, `MetricCard`, `Card`, `Notice`, `Empty`, `Tabs`, `ButtonGroup`, `FileUploadDropZone`, `Select`, `Toggle`) | Only these. No new library, no new UI component from the CLI was needed. |
| Integrations | Calendar `createEvent`, Home & Assets vehicles and policies, Today sections, Chief of Staff context, the MCP gateway and its write ledger | Not touched in 11.1; designed for in 11.3–11.4. |
| Backups | `npm run db:backup` (verified export), `npm run test:backup` (populate, back up, restore, check rules), `npm run db:verify` integrity checks, D1 Time Travel | Finance tables added to all three. |

**Outstanding problems found on `main`:**

1. **Deploys are failing.** Every Deploy workflow run since at least #38 (20 October) was cancelled or failed; the latest (#45, 22 October) failed at "Record database restore point" with `Invalid access token [code: 9109]`: the `CLOUDFLARE_API_TOKEN` GitHub secret is invalid. Production is therefore behind `main` by several merges, and migrations from `0026` on may not be applied in production. Needs the owner: a new token (see [DEPLOYMENT.md](DEPLOYMENT.md#1-cloudflare-api-token-for-github-actions)), then one deploy of `main` before this branch is considered.
2. **#45 was merged although its title says "draft, don't merge"** (merged 22 October). Worth confirming that was intended, since merging deploys.
3. `scripts/lib/ops.mjs` `TABLES` (the backup row-count manifest) doesn't list the Home & Assets tables. They are still exported (the export is the whole database); only the row-count comparison skips them. Not changed here; Finance's tables are listed.
4. Three untracked `wrangler.jsonc.backup-*` files are in the working tree. Left untouched.

## Plan 11.1–11.4

Each stage is a separate branch and draft PR, merged only with the owner's approval. Every stage's migration is additive, so rolling the Worker back never needs the data rolled back.

### 11.1 Financial foundation (this PR)

- **Scope**: accounts (five kinds, private or shared, starting balance, archive), CSV import (NAB preset plus CommBank, Westpac, ANZ, ING and a column mapper), review (new, already imported, possible duplicates, unreadable rows, exclusions), atomic commit, cancel and undo; the ledger with manual entries and corrections; balances checked against the bank's running balance and against statements; manual and bulk categorising and "categorise the others from this merchant"; transfers (suggested, confirmed by a person); the overview; CSV export.
- **Depends on**: nothing new. No binding, secret, route, DNS or Access change.
- **Acceptance**: a NAB CSV imports through review; the same or an overlapping file never duplicates; unreadable rows are listed with reasons; balances match the bank's own; transfers aren't spending; a private account never appears in the other owner's pages, totals or export. All covered by tests.
- **Rollback**: Worker rollback; tables can stay (unused).

### 11.2 Budgeting

- **Scope**: category groups the household manages; monthly envelope budgets (assign, available, rollover on/off per category, overspending carried and shown, moving money between categories); income planning for fortnightly and monthly pay (pay dates from a schedule, never assumed); personal and household budgets; budget templates; month comparisons; **split transactions** (`finance_transaction_splits`: a transaction's category becomes its splits, which must sum to its amount); **rules** (`finance_rules`: merchant or description, exact or contains, optionally per account, priority order, on/off, category and tags; each categorised transaction records `category_rule_id` and the reason). Rules only fill uncategorised transactions or ones a rule set; a person's own category (`category_source = 'manual'`) is never replaced without them confirming a preview.
- **Credit cards**: card purchases are spending in their categories when they happen; repayments are transfers, so they're never counted twice. A budget's "available" for a card's categories comes out at purchase time.
- **AI later**: the rules engine returns `{categoryId, source, ruleId, reason}`; a future suggestion source can add `source = 'suggestion'` (already allowed by the schema) without changing the transaction model.
- **Depends on**: 11.1. **Tests**: budget engine (rollover, overspending, moving money, fortnightly months with three pays), splits summing, rule priority and "never overwrite manual".
- **Rollback**: Worker rollback; new tables unused.

### 11.3 Bills and savings

- **Scope**: recurring obligations (weekly, fortnightly, monthly, quarterly, annual; expected amount and date; account and category); suggestions from history (the same merchant at a regular interval) confirmed before they count; matching imported transactions to the expected payment (so a reminder isn't raised for a bill already paid); subscription totals; renewal reminders through the existing reminder patterns (in the portal; email only behind a new switch, off by default); savings goals (target, date, starting balance, contributions, linked savings account, required contribution, forecast completion).
- **Development fixtures**: invented examples only (a wedding fund, an emergency fund, a holiday), never in production.
- **Depends on**: 11.1 (11.2 for budget lines). **Rollback**: switch off reminders; Worker rollback.

### 11.4 Reports and integrations

- **Scope**: monthly income and expenditure, category trends, merchants, budget performance, subscriptions, savings, cash flow, each reconciling with the ledger and exportable as CSV. Home & Assets: link a transaction to an existing asset or policy (no new asset or policy records; vehicle running costs and insurance premiums read from the links). Calendar: confirmed bills and goal milestones as Calendar overlays (like Home & Assets reminders), and real events only by a person's explicit preference through `createEvent`. MCP: read tools (`finance_get_summary`, `finance_list_transactions`, `finance_get_budget`, `finance_get_upcoming_bills`, `finance_get_savings_goals`, `finance_get_spending_trends`) through the same functions and visibility; writes, if any, narrowly scoped (e.g. propose a category for a person to accept), through `mcp_writes` with request ids. The gateway is deployed by hand after the portal.
- **Rollback**: Worker rollback; the gateway's previous version.

## Architecture decisions

| Decision | Why |
| --- | --- |
| **Owners only** (`finance.use` excluded from admin) | Admins may help with the wedding; nobody but the two household owners should see money. Different from Home & Assets, where admins have `assets.use`. |
| **Private or shared per account**, no per-person grants | Two people. A shared account is fully usable by both (import, categorise); sharing, the starting balance and archiving are the owner's. Simple enough to audit. |
| **Integer cents, parsed from text** (`src/shared/finance/money.ts`) | No floating point in any stored or summed amount. Amounts the parser can't read exactly are refused, never rounded. Display divides by 100 only to format. |
| **Balances worked out, never stored** | A stored balance can drift; a starting balance plus the ledger can't. Confidence comes from comparing with the bank's own running balance (in the import) or a statement. |
| **Staged imports in D1, no file in R2** | Only parsed fields are kept (never raw lines, which carry account numbers). R2 isn't needed. |
| **Fingerprint + unique index** for duplicates | `SHA-256(account, date, amount, normalised description, occurrence that day)`, unique per account among live rows: re-imports, overlaps, retries and concurrent commits can't duplicate. |
| **Commit is one D1 batch** | Claim (`review → committing` with a token), `INSERT … SELECT` of the chosen rows, mark committed, history: all or nothing. |
| **Built-in categories in code** | Nothing written to production to make categorising work; household categories are rows. |
| **Plain-HTML charts** | Server-rendered, readable without colour, with a table for screen readers. Recharts isn't needed here. |

## Who can use it

`finance.use`: owners only. Editors, viewers and admins get 403 for the pages and API. Being an owner grants nothing inside: neither owner sees the other's private accounts.

| | Private account | Shared account |
| --- | --- | --- |
| Its owner | Everything | Everything |
| The other owner | Nothing (404) | See, import, categorise, add notes and manual entries, reconcile, rename. Not: change sharing, starting balance, archive. |

A transaction, import or reconciliation is visible exactly when its account is: the overview, totals, transfer suggestions, search and export all start from the caller's visible accounts. A transfer from a shared account into someone's private account shows to the other person as "Transfer (other account not shared)", and only the private account's owner can unlink it.

## Pages

| Address | What |
| --- | --- |
| `/portal/finance` | Overview: period (this month, last month, 3 months, this year, custom) and account filter; money in, spending and left over against the period before; to categorise; possible transfers; spending by category; six months; balances with their confidence, what we have, owe and net |
| `/portal/finance/transactions` | Filters (dates, account, category, uncategorised/transfers/manual, search), categorise in the row or in bulk, the merchant offer, details (note, transfer, manual corrections, delete), likely transfers, add by hand, CSV export |
| `/portal/finance/accounts`, `/accounts/:id` | Accounts with balance and confidence; one account's balance, starting balance, statement checks, imports (with undo) and transactions |
| `/portal/finance/import`, `/import/:id` | Choose account and file, check the recognised columns (or map them), review rows, commit or cancel; import history |
| `/portal/finance/settings` | Built-in and household categories (add, rename, archive), privacy notes |

Light and dark themes come from the tokens; the browser tests check every page at desktop and Pixel 7 widths with axe.

## Accounts and balances

Kinds: everyday, savings, credit card, cash, loan or liability. Fields: name, bank or provider, last digits (at most four; optional), starting balance and its date, private or shared, archived. No full account numbers, BSBs, card numbers, passwords or bank connections.

**Balance** = starting balance + every live transaction dated on or after the starting date (`src/shared/finance/ledger.ts`). Transactions before the starting date are listed but not counted (the page says how many). Liabilities are negative; a credit card shows "$899.00 owed".

**Confidence** (`balanceView`), from the most recent check:

| Status | Meaning |
| --- | --- |
| No starting balance | Can't be worked out; shown as "Not known yet", never $0, and left out of totals |
| Calculated, not confirmed | Starting balance plus transactions; nothing to compare with |
| Matches the bank | At the end of the latest day an import carried the bank's running balance, ours equals it |
| Reconciled | Equals a statement's closing balance someone entered |
| Doesn't match | Differs from the bank or statement by the amount shown (usually a missing or excluded transaction) |

A reconciliation (`finance_reconciliations`) records the date, statement balance, our balance then and the difference; it changes no transaction. An import can **suggest** a starting balance (the file's first balance less its first transaction); a person applies it.

## Importing CSV

`src/shared/finance/csv-import.ts` (pure, tested), `worker/finance/imports.ts`.

1. **Inspect**: the file (≤ 2 MB, ≤ 5,000 rows) is parsed with the portal's RFC 4180 parser. The account's last layout is tried first, then the presets. NAB is recognised by its header names (Date, Amount, Account Number, Transaction Type, Transaction Details, Balance, Category, Merchant Name), or by the older headerless layout (date, amount, two blanks, type, details, balance). The first rows are shown so the person can check.
2. **Layout**: preset, header row, lines to skip, date column and format (day-first by default; a file readable both ways says so), description, merchant, signed amount or separate debit and credit, "money out shown as positive" (some cards), balance.
3. **Stage**: every row is read and given a status: **new**; **already imported** (exact duplicate, never imported); **possible duplicate** (must be decided); **can't be read** (kept with its line number and reason: bad date, zero amount, unreadable amount or balance, both debit and credit, too few columns, no description). Rows are put in chronological order whichever way the bank sorted them. The file's SHA-256, date range, the bank's closing balance and any warnings (rows out of order, a different account number, dates before the starting balance, a file imported before) are kept. Staging the same file twice returns the open import.
4. **Review**: tabs for all, to import, possible duplicates, already imported, can't be read, excluded. Import or skip any row; skip or import all possible duplicates at once. Commit is disabled until every possible duplicate is decided.
5. **Commit**: one batch: claim, insert the chosen rows not already in the ledger, mark committed, remember the layout on the account, history. A retry or double click answers "already committed" with the same result.
6. **Cancel** (before commit): the staged rows are deleted, nothing reached the ledger. **Undo** (after): the import's transactions are soft-deleted (kept for the record, with their categories) and transfer links to them removed; the same file can then be imported again.

## Duplicates

- **Exact**: key `account | date | amount | normalised description | n`, where `n` counts identical rows on that day in chronological order, so two identical coffees are two transactions and an overlapping file that has both again matches both. Hashed with SHA-256 and unique per account among live rows (`finance_transactions_fingerprint`).
- **Possible**: a new row with the same amount as a ledger transaction within three days and either similar words (a pending description that changed when it posted) or a manual entry. Each ledger transaction is matched to at most one row, the closest. Only flagged.
- **Manual entries** never match exactly (their key is unique), so an import always asks.

Edge: a file that ends part-way through a day and a later file covering the rest of it work, because the occurrence count is per day; two exports that cut the same day at different points could, in theory, label identical purchases differently. Possible-duplicate review catches what remains.

## Categorising

- In the row (React Aria `Select`), in bulk (select rows, choose a category), or in the details dialog. Built-in categories (`src/shared/finance/categories.ts`, 40 in 10 groups) plus household ones; archived ones stay on old transactions but can't be chosen.
- After categorising one, the page **offers** to categorise the other uncategorised transactions from the same merchant (`merchant_key`, a normalised merchant). Ones already categorised are only changed if the person explicitly includes them. Nothing is categorised without a person.
- Every change is recorded in `finance_activity` with the category ids (from, to), never the description.
- `category_source` (`manual`, later `rule` or `suggestion`) and `category_rule_id` are in the schema for 11.2.

## Transfers

Money moving between the household's own accounts (a savings top-up, a credit-card repayment) is neither income nor spending. Likely transfers are **suggested**: the same amount out of one visible account and into another within three days in the last 120 days, closest first. A person confirms ("It's a transfer", which links both sides) or dismisses (not suggested again). A transaction can also be marked a transfer on its own (to an account that isn't tracked). Transfers can't have a category; unmarking one unlinks both sides.

## Overview maths

`src/shared/finance/ledger.ts`, all integer cents:

- Transfers are excluded.
- A categorised transaction counts on its category's side: a refund in Groceries reduces grocery spending (it isn't income); a reversal in an income category reduces income.
- An uncategorised transaction counts by direction (in = income, out = spending) until categorised.
- Spending by category sums to total spending (tested). Months use the same rules. The comparison period is the same length immediately before.
- Position: balances ≥ 0 are "what we have", below zero "what we owe"; accounts without a starting balance are left out and counted; unconfirmed balances are flagged.

## Data model (`0031_household_finance.sql`)

| Table | Holds |
| --- | --- |
| `finance_accounts` | Owner, name, institution, kind, last digits, starting balance and date (both or neither), private/shared, last import layout, archived |
| `finance_categories` | Household categories (`fcat_`), kind and group |
| `finance_imports` | One file per account: SHA-256, layout, status (review, committing, committed, cancelled, undone), counts, dates, bank closing balance, warnings. One open import per file and account |
| `finance_import_rows` | Parsed rows (never raw lines), status, decision, match, reason |
| `finance_transactions` | The ledger: date, order, signed amount, description, merchant and key, note, category and its source, transfer, source (import/manual), fingerprint, the bank's balance and category, soft deletion |
| `finance_transfers`, `finance_transfer_dismissals` | Linked pairs; pairs a person said aren't transfers |
| `finance_reconciliations` | Statement checks (difference = statement − ours, enforced) |
| `finance_activity` | History: ids, action names, field names, category ids and, for manual corrections, dates and amounts. Never descriptions, notes or account names |

CHECK constraints refuse impossible rows (zero amounts, a categorised transfer, a transfer id without the flag, a category without its source, an import transaction without its import, half a starting balance, a reconciliation whose difference doesn't add up, digits other than 2–4 in the hint). There are no virtual tables, so `npm run db:backup` works unchanged.

## API

`/api/portal/finance/*` (`worker/finance/api.ts`), behind Access, the portal role, same-origin checks and `finance.use`:

- `GET /overview?from&to&accounts`
- `GET|POST /accounts`, `GET|PATCH /accounts/:id`, `POST /accounts/:id/reconcile`, `GET /accounts/:id/reconciliations`
- `GET|POST /categories`, `PATCH /categories/:id`
- `GET /transactions?from&to&account&category&show&q`, `GET /transactions.csv`, `POST /transactions` (manual, `clientId` retry key), `GET|PATCH|DELETE /transactions/:id`, `GET /transactions/:id/similar`, `POST /transactions/bulk`, `POST /transactions/similar`
- `GET /transfers/suggestions`, `POST /transfers`, `POST /transfers/dismiss`
- `GET /imports`, `POST /imports/inspect`, `POST /imports`, `GET /imports/:id`, `PATCH /imports/:id/rows`, `POST /imports/:id/{commit,cancel,undo}`

Writes carry the record's `version` (409 on a stale one). Creates take a retry key. Anything not visible is 404.

## Security

- Access, the portal's JWT and role checks, `finance.use`, then per-account visibility in every query (the SQL joins `finance_accounts` and filters by owner or shared). Same-origin and `Sec-Fetch-Site` checks on every request, including the CSV export.
- No credentials, connections, full account numbers or raw CSV lines are stored. The file's account-number column is compared with the saved last digits and discarded.
- Logs carry tool names, error codes and ids only (the portal's error logging); `finance_activity` holds no descriptions or notes.
- CSV export is formula-neutralised (`toCsv`), recorded in the history (row count only).
- Uploads are text only and parsed, never stored as files or rendered as HTML; size and row limits.

## Testing

- `test/finance-engine.test.ts`: amounts (signs, brackets, DR/CR, separators, refusals, no float drift), dates (formats, impossible dates, day-first ambiguity), NAB header and headerless layouts, Westpac debit/credit, newest-first ordering, identical purchases on one day, unreadable rows kept with reasons, the account number never kept, merchant keys, possible duplicates, transfer suggestions, income and spending (transfers, refunds, credit-card repayments), balance confidence, implied starting balance.
- `test/finance.test.ts`: owners only; cross-site refusal; private accounts invisible to the other owner in accounts, transactions, search, overview totals, imports and export; owner-only management; no full account numbers stored; inspect → stage → commit with the balance matching the bank; the same file, an overlapping file and a repeated commit never duplicating; reopened staging; exclusions, stale versions, cancel; possible duplicates against a manual entry; undo and re-import; headerless NAB and the suggested starting balance; account-number warning; unreadable layouts and size limits; importing into a shared account by the other owner; categorising one, the merchant offer that leaves others' choices alone, bulk, household and archived categories; imported bank details immutable, manual corrections and deletion with history; transfer suggestions, linking, totals afterwards (credit-card repayment not counted twice), unlinking, hidden counterparts; dismissals; spending by category reconciling with totals, months, position, account filter, previous period; statement reconciliation; export with formula neutralising; database constraints; every page loads.
- `e2e/finance.spec.ts` (desktop and Pixel 7): import a NAB file through review, the same file again recognised, the balance matching the bank; categorising one and then the others from the merchant; every page fits and passes axe; unreadable rows shown with reasons.
- `npm run test:backup` seeds Finance rows and checks they and their rules survive a backup and restore.

All data in tests is invented (`fixtures/finance/fixtures.ts`). Merchant names are ordinary public businesses.

## Deploying

Owner-approved, after the deploy token is fixed and `main` itself has deployed:

1. Merge (deploys the Worker and applies `0031` through the usual workflow: restore point, migrate, verify, deploy).
2. `npm run db:verify -- --env production`: the Finance checks (no transaction twice, transfers link two live transactions, no import stuck mid-commit) run with the others.
3. Add accounts and import real exports by hand. No production data is created by this PR.

No new binding, secret, route, DNS, Access or switch. No MCP gateway change.

## Rollback

- **Code**: `wrangler rollback` to the previous Worker. It never reads the Finance tables.
- **Data**: the tables can stay. If they ever had to go, drop them children first (activity, dismissals, reconciliations, import rows, transactions, transfers, imports, categories, accounts).
- **One import**: Undo on the account or import page.

## Backup and restore

D1 Time Travel and `npm run db:backup` cover the tables; they're in the row-count manifest (`scripts/lib/ops.mjs`). Finance stores nothing in R2.

## Known limitations

- **NAB's layout is inferred, not confirmed.** The preset reads the header names above and the older headerless layout, from public descriptions; no real NAB export was used (none may be committed). Check the first real import's preview; if NAB's columns differ, choose them in "Adjust the layout" (the account remembers it) and tell us so the preset can be fixed.
- Other banks' presets (CommBank, Westpac, ANZ, ING) are based on their commonly documented layouts and are untested against real files.
- Pending transactions: banks usually leave them out of CSV exports; if one is exported and later posts with a different description, it shows as a possible duplicate.
- Merchant keys are a heuristic for grouping ("categorise the others"); they never decide anything.
- Budgets, rules, splits, bills, goals, reports beyond the transactions export, Calendar, Home & Assets and MCP are 11.2–11.4.
- Up to 2,000 transactions per Transactions page load (narrow the dates for more); 5,000 rows per file.
