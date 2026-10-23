-- Household Finance, Milestone 11.1: the financial foundation. See docs/HOUSEHOLD_FINANCE.md.
--
-- Additive only: no existing table is changed, and mcp_writes is untouched (Finance has no MCP tools
-- until 11.4). The previous Worker never reads these tables, so rolling the Worker back leaves them
-- unused.
--
-- Access: every account has an owner. A private account is visible to its owner only; a shared
-- account to everyone who can open Household Finance (the two household owners). A transaction is
-- visible exactly when its account is: nothing here is shared on its own.
--
-- Money is whole cents (INTEGER), signed from the account's point of view: money in is positive,
-- money out is negative. NULL is "not recorded", never zero. No bank credentials, full account
-- numbers or raw CSV lines are stored: an account keeps at most the last four digits as a hint, and
-- an import keeps the parsed fields of each row and the file's SHA-256.

-- --- Accounts --------------------------------------------------------------------------------------

CREATE TABLE finance_accounts (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    institution TEXT CHECK (institution IS NULL OR length(institution) <= 80),
    kind TEXT NOT NULL CHECK (kind IN ('transaction', 'savings', 'credit_card', 'cash', 'loan')),
    -- At most the last four digits, to tell two cards apart and to check a file is for this account.
    number_hint TEXT CHECK (number_hint IS NULL OR (length(number_hint) BETWEEN 2 AND 4 AND number_hint NOT GLOB '*[^0-9]*')),
    -- The balance before any transaction dated on or after opening_balance_on. Both or neither.
    opening_balance_cents INTEGER,
    opening_balance_on TEXT CHECK (opening_balance_on IS NULL OR opening_balance_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
    -- The CSV layout last used for this account (validated by the Worker), offered on the next import.
    import_mapping TEXT CHECK (import_mapping IS NULL OR (json_valid(import_mapping) AND length(import_mapping) <= 2000)),
    archived_at TEXT,
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((opening_balance_cents IS NULL) = (opening_balance_on IS NULL))
);
CREATE INDEX finance_accounts_owner ON finance_accounts (owner_email);
CREATE INDEX finance_accounts_visibility ON finance_accounts (visibility);
CREATE UNIQUE INDEX finance_accounts_client ON finance_accounts (owner_email, client_id) WHERE client_id IS NOT NULL;

-- --- Categories ------------------------------------------------------------------------------------

-- Household categories. Built-in categories and groups live in code (src/shared/finance/categories.ts);
-- these are the ones the household adds. Categories are household-wide: they hold no amounts.
CREATE TABLE finance_categories (
    id TEXT PRIMARY KEY CHECK (id GLOB 'fcat_*'),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    group_id TEXT NOT NULL CHECK (length(group_id) BETWEEN 2 AND 40),
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX finance_categories_name ON finance_categories (lower(name)) WHERE archived_at IS NULL;

-- --- Imports ---------------------------------------------------------------------------------------

-- One uploaded CSV file for one account. 'review' rows are staged and can be changed or cancelled;
-- 'committing' is claimed by exactly one commit; 'committed' wrote its transactions; 'cancelled'
-- dropped its staged rows; 'undone' soft-deleted the transactions it wrote.
CREATE TABLE finance_imports (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES finance_accounts (id),
    filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
    file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
    -- The layout used (preset and column mapping), validated by the Worker.
    mapping TEXT NOT NULL CHECK (json_valid(mapping) AND length(mapping) <= 2000),
    status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'committing', 'committed', 'cancelled', 'undone')),
    rows_total INTEGER NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
    rows_new INTEGER NOT NULL DEFAULT 0 CHECK (rows_new >= 0),
    rows_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (rows_duplicate >= 0),
    rows_possible INTEGER NOT NULL DEFAULT 0 CHECK (rows_possible >= 0),
    rows_invalid INTEGER NOT NULL DEFAULT 0 CHECK (rows_invalid >= 0),
    rows_imported INTEGER CHECK (rows_imported IS NULL OR rows_imported >= 0),
    first_on TEXT,
    last_on TEXT,
    -- The bank's own closing balance, when the file has a balance column: the last row's balance.
    bank_closing_cents INTEGER,
    -- Notes about the file as a whole (rows out of date order, a different account number), as text.
    warnings TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings) AND json_type(warnings) = 'array' AND length(warnings) <= 2000),
    commit_token TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    committed_by TEXT,
    committed_at TEXT,
    closed_by TEXT,
    closed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (status <> 'committed' OR (committed_at IS NOT NULL AND rows_imported IS NOT NULL))
);
CREATE INDEX finance_imports_account ON finance_imports (account_id, created_at);
CREATE INDEX finance_imports_sha ON finance_imports (account_id, file_sha256);
-- At most one import of a file under review for an account at a time.
CREATE UNIQUE INDEX finance_imports_open_file ON finance_imports (account_id, file_sha256) WHERE status IN ('review', 'committing');

-- The parsed rows of an import. Never the raw line. Kept after commit (the import's history shows
-- what was skipped and why); deleted when the import is cancelled.
CREATE TABLE finance_import_rows (
    import_id TEXT NOT NULL REFERENCES finance_imports (id) ON DELETE CASCADE,
    line INTEGER NOT NULL CHECK (line >= 1),
    -- Chronological order within the file (0 is the earliest), whichever way the bank sorted it.
    position INTEGER NOT NULL CHECK (position >= 0),
    -- new: not in the ledger. duplicate: exactly matches a transaction already there (never imported).
    -- possible_duplicate: looks like one (needs a decision). invalid: couldn't be read (never imported).
    status TEXT NOT NULL CHECK (status IN ('new', 'duplicate', 'possible_duplicate', 'invalid')),
    -- The person's decision. NULL: the default (new rows are included). A possible duplicate must be decided.
    decision TEXT CHECK (decision IS NULL OR decision IN ('include', 'skip')),
    posted_on TEXT CHECK (posted_on IS NULL OR posted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    amount_cents INTEGER,
    description TEXT CHECK (description IS NULL OR length(description) <= 500),
    merchant TEXT CHECK (merchant IS NULL OR length(merchant) <= 200),
    merchant_key TEXT CHECK (merchant_key IS NULL OR length(merchant_key) <= 200),
    bank_category TEXT CHECK (bank_category IS NULL OR length(bank_category) <= 80),
    bank_balance_cents INTEGER,
    fingerprint TEXT CHECK (fingerprint IS NULL OR length(fingerprint) = 64),
    match_transaction_id TEXT,
    error TEXT CHECK (error IS NULL OR length(error) <= 300),
    PRIMARY KEY (import_id, line),
    CHECK (status = 'invalid' OR (posted_on IS NOT NULL AND amount_cents IS NOT NULL AND description IS NOT NULL AND fingerprint IS NOT NULL)),
    CHECK (status <> 'invalid' OR error IS NOT NULL),
    CHECK (status NOT IN ('invalid', 'duplicate') OR decision IS NULL)
);

-- --- The ledger ------------------------------------------------------------------------------------

CREATE TABLE finance_transfers (
    id TEXT PRIMARY KEY,
    out_transaction_id TEXT NOT NULL UNIQUE,
    in_transaction_id TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (out_transaction_id <> in_transaction_id)
);

CREATE TABLE finance_transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES finance_accounts (id),
    posted_on TEXT NOT NULL CHECK (posted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- Order within a day for one import (chronological); 0 for manual entries.
    sequence INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
    description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
    merchant TEXT CHECK (merchant IS NULL OR length(merchant) <= 200),
    -- Normalised merchant, for "categorise others like this" and (from 11.2) rules.
    merchant_key TEXT CHECK (merchant_key IS NULL OR length(merchant_key) <= 200),
    note TEXT CHECK (note IS NULL OR length(note) <= 1000),
    -- A built-in category id or a finance_categories id. NULL: uncategorised.
    category_id TEXT CHECK (category_id IS NULL OR length(category_id) BETWEEN 2 AND 40),
    -- Who decided the category: a person (manual) or, from 11.2, a rule or a suggestion they accepted.
    category_source TEXT CHECK (category_source IS NULL OR category_source IN ('manual', 'rule', 'suggestion')),
    category_rule_id TEXT,
    -- Money moving between the household's own accounts: never income or spending.
    is_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer IN (0, 1)),
    transfer_id TEXT REFERENCES finance_transfers (id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('import', 'manual')),
    import_id TEXT REFERENCES finance_imports (id),
    import_line INTEGER,
    -- SHA-256 of account, date, amount, normalised description and occurrence: the duplicate key.
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    bank_balance_cents INTEGER,
    bank_category TEXT CHECK (bank_category IS NULL OR length(bank_category) <= 80),
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    deleted_at TEXT,
    deleted_by TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((category_id IS NULL) = (category_source IS NULL)),
    CHECK (is_transfer = 0 OR category_id IS NULL),
    CHECK (transfer_id IS NULL OR is_transfer = 1),
    CHECK ((source = 'import') = (import_id IS NOT NULL)),
    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
-- The duplicate guard: a file imported twice, two overlapping files, or two commits at once can't
-- write the same transaction twice. Soft-deleted rows (an undone import) don't count.
CREATE UNIQUE INDEX finance_transactions_fingerprint ON finance_transactions (account_id, fingerprint) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX finance_transactions_client ON finance_transactions (created_by, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX finance_transactions_account_date ON finance_transactions (account_id, posted_on);
CREATE INDEX finance_transactions_date ON finance_transactions (posted_on);
CREATE INDEX finance_transactions_category ON finance_transactions (category_id);
CREATE INDEX finance_transactions_merchant ON finance_transactions (merchant_key);
CREATE INDEX finance_transactions_import ON finance_transactions (import_id);

-- A suggested transfer pair someone said isn't one, so it isn't suggested again.
CREATE TABLE finance_transfer_dismissals (
    out_transaction_id TEXT NOT NULL,
    in_transaction_id TEXT NOT NULL,
    dismissed_by TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (out_transaction_id, in_transaction_id)
);

-- --- Reconciliation --------------------------------------------------------------------------------

-- A person compared the account with a statement: the statement's closing balance on a date, what
-- the ledger said then, and the difference. Explicit and append-only; the latest one is shown.
CREATE TABLE finance_reconciliations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES finance_accounts (id),
    as_of TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    statement_balance_cents INTEGER NOT NULL,
    calculated_balance_cents INTEGER NOT NULL,
    difference_cents INTEGER NOT NULL CHECK (difference_cents = statement_balance_cents - calculated_balance_cents),
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX finance_reconciliations_account ON finance_reconciliations (account_id, as_of);

-- --- History ---------------------------------------------------------------------------------------

-- Who changed what. Ids, action names and the fields changed (with category ids, dates and amounts
-- for ledger corrections); never descriptions, notes, institutions or account names. Rows tied to an
-- account are shown only to people who can see that account.
CREATE TABLE finance_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 60),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'transaction', 'transfer', 'import', 'category', 'reconciliation', 'export')),
    entity_id TEXT,
    account_id TEXT,
    via TEXT NOT NULL DEFAULT 'portal' CHECK (via IN ('portal', 'mcp', 'system')),
    detail TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 2000))
);
CREATE INDEX finance_activity_entity ON finance_activity (entity_type, entity_id);
CREATE INDEX finance_activity_account ON finance_activity (account_id, at);
