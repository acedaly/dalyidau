-- Home & Assets (Milestone 10). See docs/HOME_ASSETS.md.
--
-- Additive except for one step: mcp_writes is rebuilt (every row copied) so an MCP write can record
-- an asset, a maintenance record or a document link as its outcome, the same pattern as 0020–0023.
-- The previous Worker never reads the new tables and only writes entity types the rebuilt ledger
-- still accepts, so a rollback of the Worker leaves them unused.
--
-- Access: every asset has an owner. Others reach it only through asset_shares: a row for their
-- email, or the household row (email '*', everyone who can open Home & Assets). Each grant says
-- separately whether they may edit, record maintenance, see financial values, see insurance and
-- open documents. Locations and insurance policies are private to their owner unless shared with
-- the household. Activity rows (asset_activity) hold ids and action names only: never names,
-- serial numbers, registration numbers, policy references, amounts or addresses.
-- Money is stored in whole cents. NULL always means "not recorded", never zero.

-- --- Preferences and categories -----------------------------------------------------------------

-- Each person's own choices: Today section, reminder offsets and channels per reminder category,
-- low-value threshold, list layout, retention review. One JSON document, validated by the Worker
-- (src/shared/assets/types.ts) without rejecting fields a later version adds.
CREATE TABLE asset_preferences (
    email TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 8000),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL
);

-- Household categories. Built-in categories live in code (src/shared/assets/categories.ts); a row
-- here with a built-in id only adds custom fields to it. Custom categories have acat_ ids.
CREATE TABLE asset_categories (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 2 AND 40),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    -- Custom field definitions: [{key, label, type, options?}], validated by the Worker.
    fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields) AND json_type(fields) = 'array' AND length(fields) <= 8000),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- --- Locations and properties -------------------------------------------------------------------

CREATE TABLE asset_locations (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    kind TEXT NOT NULL CHECK (kind IN ('residence', 'rental', 'garage', 'shed', 'storage', 'room', 'vehicle', 'trailer', 'other')),
    -- A room in a house, a shelf in a shed. One level is enough for a household.
    parent_id TEXT REFERENCES asset_locations (id) ON DELETE SET NULL,
    -- Property details, all optional.
    tenure TEXT CHECK (tenure IS NULL OR tenure IN ('owned', 'renting', 'leased_out', 'other')),
    address TEXT CHECK (address IS NULL OR length(address) <= 300),
    lease_start TEXT CHECK (lease_start IS NULL OR lease_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    lease_end TEXT CHECK (lease_end IS NULL OR lease_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    manager_name TEXT CHECK (manager_name IS NULL OR length(manager_name) <= 120),
    manager_phone TEXT CHECK (manager_phone IS NULL OR length(manager_phone) <= 40),
    manager_email TEXT CHECK (manager_email IS NULL OR length(manager_email) <= 254),
    next_inspection_on TEXT CHECK (next_inspection_on IS NULL OR next_inspection_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    utilities TEXT CHECK (utilities IS NULL OR length(utilities) <= 2000),
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
    -- private: the owner only. household: everyone who can open Home & Assets can see it.
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'household')),
    household_can_edit INTEGER NOT NULL DEFAULT 0 CHECK (household_can_edit IN (0, 1)),
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK (household_can_edit = 0 OR visibility = 'household')
);
CREATE INDEX asset_locations_owner ON asset_locations (owner_email);
CREATE INDEX asset_locations_visibility ON asset_locations (visibility);

-- --- Assets ---------------------------------------------------------------------------------------

CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    category TEXT NOT NULL CHECK (length(category) BETWEEN 2 AND 40),
    manufacturer TEXT CHECK (manufacturer IS NULL OR length(manufacturer) <= 120),
    brand TEXT CHECK (brand IS NULL OR length(brand) <= 120),
    model TEXT CHECK (model IS NULL OR length(model) <= 120),
    serial_number TEXT CHECK (serial_number IS NULL OR length(serial_number) <= 120),
    -- A product barcode (EAN/UPC) or other scanned identifier, for finding the item again.
    barcode TEXT CHECK (barcode IS NULL OR length(barcode) <= 64),
    description TEXT CHECK (description IS NULL OR length(description) <= 4000),
    purchase_date TEXT CHECK (purchase_date IS NULL OR purchase_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- The actual transaction amount, as entered (a receipt total, an invoice).
    purchase_price_cents INTEGER CHECK (purchase_price_cents IS NULL OR purchase_price_cents >= 0),
    purchase_location TEXT CHECK (purchase_location IS NULL OR length(purchase_location) <= 200),
    condition TEXT NOT NULL DEFAULT 'unknown' CHECK (condition IN ('new', 'excellent', 'good', 'fair', 'poor', 'not_working', 'unknown')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_storage', 'in_repair', 'lent', 'lost', 'stolen', 'sold', 'disposed', 'gifted')),
    -- Who owns the thing (a household label, e.g. "Joint" or a person's name), separate from who owns the record.
    ownership TEXT CHECK (ownership IS NULL OR length(ownership) <= 120),
    location_id TEXT REFERENCES asset_locations (id) ON DELETE SET NULL,
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 8000),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 20),
    custom TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom) AND json_type(custom) = 'object' AND length(custom) <= 8000),
    -- An optional depreciation model the person turned on. Off ('none') unless they choose one.
    depreciation TEXT NOT NULL DEFAULT '{"method":"none"}' CHECK (json_valid(depreciation) AND length(depreciation) <= 500),
    -- Disposal or sale.
    disposed_on TEXT CHECK (disposed_on IS NULL OR disposed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    disposal_method TEXT CHECK (disposal_method IS NULL OR disposal_method IN ('sold', 'gifted', 'recycled', 'discarded', 'traded_in', 'written_off', 'other')),
    disposal_amount_cents INTEGER CHECK (disposal_amount_cents IS NULL OR disposal_amount_cents >= 0),
    disposal_notes TEXT CHECK (disposal_notes IS NULL OR length(disposal_notes) <= 2000),
    -- Printed labels: regenerating a label increases this; the asset id (and so the QR address) stays.
    label_version INTEGER NOT NULL DEFAULT 1 CHECK (label_version >= 1),
    cover_file_id TEXT,
    -- private | selected | household. Kept in step with asset_shares by the Worker, for filtering.
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'selected', 'household')),
    -- A retry key for a create, unique per creator.
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX assets_owner ON assets (owner_email, deleted_at);
CREATE INDEX assets_category ON assets (category);
CREATE INDEX assets_location ON assets (location_id);
CREATE INDEX assets_visibility ON assets (visibility, deleted_at);
CREATE INDEX assets_barcode ON assets (barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX assets_client ON assets (created_by, client_id) WHERE client_id IS NOT NULL;

-- Who else may see an asset, and what. email '*' is the whole household (everyone who can open
-- Home & Assets). Viewing is implied by having a row; each other right is separate. The owner
-- always has every right and never has a row.
CREATE TABLE asset_shares (
    asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE CHECK (email = '*' OR (length(email) <= 254 AND email LIKE '%@%')),
    can_edit INTEGER NOT NULL DEFAULT 0 CHECK (can_edit IN (0, 1)),
    can_maintain INTEGER NOT NULL DEFAULT 0 CHECK (can_maintain IN (0, 1)),
    can_financial INTEGER NOT NULL DEFAULT 0 CHECK (can_financial IN (0, 1)),
    can_insurance INTEGER NOT NULL DEFAULT 0 CHECK (can_insurance IN (0, 1)),
    can_documents INTEGER NOT NULL DEFAULT 0 CHECK (can_documents IN (0, 1)),
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (asset_id, email),
    -- Editing includes recording maintenance.
    CHECK (can_edit = 0 OR can_maintain = 1)
);
CREATE INDEX asset_shares_email ON asset_shares (email);

-- Vehicles, trailers and caravans: one row per vehicle asset. Specification details that are
-- descriptive only (tyres, towing, water and battery systems) are in specs, validated by the Worker.
CREATE TABLE asset_vehicles (
    asset_id TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('vehicle', 'trailer', 'caravan', 'motorcycle', 'boat', 'other')),
    registration TEXT CHECK (registration IS NULL OR length(registration) <= 20),
    jurisdiction TEXT CHECK (jurisdiction IS NULL OR length(jurisdiction) <= 40),
    registration_expiry TEXT CHECK (registration_expiry IS NULL OR registration_expiry GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    vin TEXT CHECK (vin IS NULL OR length(vin) <= 40),
    engine_number TEXT CHECK (engine_number IS NULL OR length(engine_number) <= 40),
    make TEXT CHECK (make IS NULL OR length(make) <= 80),
    model TEXT CHECK (model IS NULL OR length(model) <= 80),
    year INTEGER CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
    odometer_unit TEXT NOT NULL DEFAULT 'km' CHECK (odometer_unit IN ('km', 'mi', 'hours')),
    roadside_provider TEXT CHECK (roadside_provider IS NULL OR length(roadside_provider) <= 120),
    roadside_reference TEXT CHECK (roadside_reference IS NULL OR length(roadside_reference) <= 80),
    roadside_expiry TEXT CHECK (roadside_expiry IS NULL OR roadside_expiry GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- Safety inspection or roadworthy certificate (pink slip, RWC) when one is next needed.
    inspection_due TEXT CHECK (inspection_due IS NULL OR inspection_due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    battery_installed_on TEXT CHECK (battery_installed_on IS NULL OR battery_installed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- Trailer masses, in kilograms, as plated or certified.
    atm_kg INTEGER CHECK (atm_kg IS NULL OR atm_kg BETWEEN 0 AND 100000),
    gtm_kg INTEGER CHECK (gtm_kg IS NULL OR gtm_kg BETWEEN 0 AND 100000),
    tare_kg INTEGER CHECK (tare_kg IS NULL OR tare_kg BETWEEN 0 AND 100000),
    ball_weight_kg INTEGER CHECK (ball_weight_kg IS NULL OR ball_weight_kg BETWEEN 0 AND 10000),
    specs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(specs) AND json_type(specs) = 'object' AND length(specs) <= 12000),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX asset_vehicles_rego ON asset_vehicles (registration_expiry);

-- Odometer (or hour meter) history. A reading lower than an earlier one is refused unless it's
-- marked as a correction (a replaced cluster, a typo).
CREATE TABLE asset_odometer (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    reading INTEGER NOT NULL CHECK (reading BETWEEN 0 AND 10000000),
    read_on TEXT NOT NULL CHECK (read_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    correction INTEGER NOT NULL DEFAULT 0 CHECK (correction IN (0, 1)),
    maintenance_id TEXT,
    note TEXT CHECK (note IS NULL OR length(note) <= 300),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX asset_odometer_asset ON asset_odometer (asset_id, read_on, reading);

-- --- Valuations -----------------------------------------------------------------------------------

-- Every value is labelled with what it is. basis says where the number came from: entered by a
-- person (an estimate), an actual transaction, a verified sale, an appraisal or an insurer's
-- agreed value. Formula estimates (depreciation) are worked out when read and never stored.
CREATE TABLE asset_valuations (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('current', 'replacement', 'sale', 'disposal', 'agreed')),
    basis TEXT NOT NULL CHECK (basis IN ('user_estimate', 'transaction', 'verified_sale', 'appraisal', 'insurer')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    valued_on TEXT NOT NULL CHECK (valued_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    source TEXT CHECK (source IS NULL OR length(source) <= 300),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX asset_valuations_asset ON asset_valuations (asset_id, kind, valued_on);

-- --- Maintenance ----------------------------------------------------------------------------------

-- Household maintenance templates. Built-in templates (src/shared/assets/templates.ts) carry no
-- interval: the person enters the one from their manual, service book or agreement. Templates saved
-- here are the household's own, with the intervals the person chose.
CREATE TABLE asset_maintenance_templates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    category TEXT NOT NULL CHECK (category IN ('service', 'inspection', 'safety', 'cleaning', 'replacement', 'seasonal', 'registration', 'repair', 'other')),
    applies_to TEXT NOT NULL DEFAULT 'any' CHECK (applies_to IN ('any', 'vehicle', 'trailer', 'property', 'appliance', 'equipment')),
    interval_count INTEGER CHECK (interval_count IS NULL OR interval_count BETWEEN 1 AND 1000),
    interval_unit TEXT CHECK (interval_unit IS NULL OR interval_unit IN ('days', 'weeks', 'months', 'years')),
    interval_km INTEGER CHECK (interval_km IS NULL OR interval_km BETWEEN 1 AND 1000000),
    checklist TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist) AND json_type(checklist) = 'array' AND length(checklist) <= 4000),
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((interval_count IS NULL) = (interval_unit IS NULL))
);

-- A recurring requirement for an asset or a location (exactly one). The next due date and
-- distance are worked out from the interval the person set and when it was last done, and kept
-- here so lists and reminders can be queried; src/shared/assets/schedule.ts is the only place
-- that calculates them.
CREATE TABLE asset_schedules (
    id TEXT PRIMARY KEY,
    asset_id TEXT REFERENCES assets (id) ON DELETE CASCADE,
    location_id TEXT REFERENCES asset_locations (id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    category TEXT NOT NULL CHECK (category IN ('service', 'inspection', 'safety', 'cleaning', 'replacement', 'seasonal', 'registration', 'repair', 'other')),
    interval_count INTEGER CHECK (interval_count IS NULL OR interval_count BETWEEN 1 AND 1000),
    interval_unit TEXT CHECK (interval_unit IS NULL OR interval_unit IN ('days', 'weeks', 'months', 'years')),
    interval_km INTEGER CHECK (interval_km IS NULL OR interval_km BETWEEN 1 AND 1000000),
    -- When it's first due, if it has never been done (otherwise last done + interval).
    first_due_on TEXT CHECK (first_due_on IS NULL OR first_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    first_due_km INTEGER CHECK (first_due_km IS NULL OR first_due_km >= 0),
    last_done_on TEXT CHECK (last_done_on IS NULL OR last_done_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    last_done_km INTEGER CHECK (last_done_km IS NULL OR last_done_km >= 0),
    next_due_on TEXT CHECK (next_due_on IS NULL OR next_due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    next_due_km INTEGER CHECK (next_due_km IS NULL OR next_due_km >= 0),
    -- Days before the due date to remind, e.g. [30, 7, 0].
    reminder_days TEXT NOT NULL DEFAULT '[14,0]' CHECK (json_valid(reminder_days) AND json_type(reminder_days) = 'array' AND json_array_length(reminder_days) <= 5),
    -- For a rented property: who is responsible, as the household understands it (never asserted as law).
    responsibility TEXT NOT NULL DEFAULT 'owner' CHECK (responsibility IN ('owner', 'tenant', 'landlord', 'shared', 'uncertain')),
    provider TEXT CHECK (provider IS NULL OR length(provider) <= 200),
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
    template_id TEXT CHECK (template_id IS NULL OR length(template_id) <= 40),
    -- Create the next record automatically when one is completed.
    auto_next INTEGER NOT NULL DEFAULT 1 CHECK (auto_next IN (0, 1)),
    -- Create a Daly Task this many days before it's due (NULL: never automatically).
    task_lead_days INTEGER CHECK (task_lead_days IS NULL OR task_lead_days BETWEEN 0 AND 365),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((asset_id IS NULL) <> (location_id IS NULL)),
    CHECK ((interval_count IS NULL) = (interval_unit IS NULL)),
    CHECK (interval_count IS NOT NULL OR interval_km IS NOT NULL)
);
CREATE INDEX asset_schedules_asset ON asset_schedules (asset_id);
CREATE INDEX asset_schedules_location ON asset_schedules (location_id);
CREATE INDEX asset_schedules_due ON asset_schedules (active, next_due_on);

-- One piece of maintenance: planned, requested (e.g. lodged with a property manager), scheduled,
-- under way, completed or cancelled. For an asset or a location (exactly one).
CREATE TABLE asset_maintenance (
    id TEXT PRIMARY KEY,
    asset_id TEXT REFERENCES assets (id) ON DELETE CASCADE,
    location_id TEXT REFERENCES asset_locations (id) ON DELETE CASCADE,
    schedule_id TEXT REFERENCES asset_schedules (id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT CHECK (description IS NULL OR length(description) <= 4000),
    kind TEXT NOT NULL DEFAULT 'preventive' CHECK (kind IN ('preventive', 'corrective', 'repair', 'inspection', 'service', 'replacement', 'seasonal', 'safety')),
    category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('service', 'inspection', 'safety', 'cleaning', 'replacement', 'seasonal', 'registration', 'repair', 'other')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'requested', 'scheduled', 'in_progress', 'completed', 'cancelled')),
    due_on TEXT CHECK (due_on IS NULL OR due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    due_km INTEGER CHECK (due_km IS NULL OR due_km >= 0),
    scheduled_on TEXT CHECK (scheduled_on IS NULL OR scheduled_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    scheduled_time TEXT CHECK (scheduled_time IS NULL OR scheduled_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    completed_on TEXT CHECK (completed_on IS NULL OR completed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
    cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
    provider TEXT CHECK (provider IS NULL OR length(provider) <= 200),
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 8000),
    responsibility TEXT NOT NULL DEFAULT 'owner' CHECK (responsibility IN ('owner', 'tenant', 'landlord', 'shared', 'uncertain')),
    -- A request to a landlord or property manager, and whether a change was approved. Recording a
    -- request never implies permission to make a modification.
    request_reference TEXT CHECK (request_reference IS NULL OR length(request_reference) <= 80),
    requested_on TEXT CHECK (requested_on IS NULL OR requested_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    approval TEXT NOT NULL DEFAULT 'not_needed' CHECK (approval IN ('not_needed', 'pending', 'approved', 'declined')),
    checklist TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist) AND json_type(checklist) = 'array' AND length(checklist) <= 4000),
    -- A Calendar appointment made for it (Calendar's own event, created through Calendar).
    calendar_event_id TEXT,
    client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((asset_id IS NULL) <> (location_id IS NULL)),
    CHECK (status <> 'completed' OR completed_on IS NOT NULL)
);
CREATE INDEX asset_maintenance_asset ON asset_maintenance (asset_id, status);
CREATE INDEX asset_maintenance_location ON asset_maintenance (location_id, status);
CREATE INDEX asset_maintenance_due ON asset_maintenance (status, due_on);
-- A schedule has at most one open record, so completing one (or a retry) can't create two next ones.
CREATE UNIQUE INDEX asset_maintenance_open_schedule ON asset_maintenance (schedule_id)
    WHERE schedule_id IS NOT NULL AND status IN ('open', 'requested', 'scheduled', 'in_progress');
CREATE UNIQUE INDEX asset_maintenance_client ON asset_maintenance (created_by, client_id) WHERE client_id IS NOT NULL;

-- --- Insurance, warranties and claims -------------------------------------------------------------

-- A policy is source material the household recorded, not a guarantee of cover. verified_at is set
-- only when a person confirms the details against the policy documents.
CREATE TABLE asset_policies (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 120),
    policy_type TEXT NOT NULL CHECK (policy_type IN ('motor', 'caravan_trailer', 'home', 'contents', 'home_contents', 'landlord', 'personal_property', 'travel', 'other')),
    name TEXT CHECK (name IS NULL OR length(name) <= 120),
    reference TEXT CHECK (reference IS NULL OR length(reference) <= 80),
    starts_on TEXT CHECK (starts_on IS NULL OR starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    renews_on TEXT CHECK (renews_on IS NULL OR renews_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    premium_cents INTEGER CHECK (premium_cents IS NULL OR premium_cents >= 0),
    payment_frequency TEXT CHECK (payment_frequency IS NULL OR payment_frequency IN ('annual', 'half_yearly', 'quarterly', 'monthly', 'fortnightly', 'other')),
    excess_cents INTEGER CHECK (excess_cents IS NULL OR excess_cents >= 0),
    coverage_summary TEXT CHECK (coverage_summary IS NULL OR length(coverage_summary) <= 4000),
    coverage_limits TEXT CHECK (coverage_limits IS NULL OR length(coverage_limits) <= 4000),
    exclusions TEXT CHECK (exclusions IS NULL OR length(exclusions) <= 4000),
    contact_phone TEXT CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
    contact_email TEXT CHECK (contact_email IS NULL OR length(contact_email) <= 254),
    contact_url TEXT CHECK (contact_url IS NULL OR (length(contact_url) <= 300 AND contact_url LIKE 'https://%')),
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lapsed', 'cancelled', 'replaced')),
    -- The policy this one renewed or replaced, for comparing premiums.
    previous_id TEXT REFERENCES asset_policies (id) ON DELETE SET NULL,
    -- Fields filled from a document by AI and not yet confirmed by a person (JSON array of names).
    unverified_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unverified_fields) AND json_type(unverified_fields) = 'array'),
    verified_at TEXT,
    verified_by TEXT,
    shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
    household_can_edit INTEGER NOT NULL DEFAULT 0 CHECK (household_can_edit IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (household_can_edit = 0 OR shared = 1),
    CHECK (previous_id IS NULL OR previous_id <> id)
);
CREATE INDEX asset_policies_owner ON asset_policies (owner_email);
CREATE INDEX asset_policies_renewal ON asset_policies (status, renews_on);

-- Premiums by period, for comparing renewals.
CREATE TABLE asset_policy_premiums (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES asset_policies (id) ON DELETE CASCADE,
    period_start TEXT NOT NULL CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    premium_cents INTEGER NOT NULL CHECK (premium_cents >= 0),
    payment_frequency TEXT CHECK (payment_frequency IS NULL OR payment_frequency IN ('annual', 'half_yearly', 'quarterly', 'monthly', 'fortnightly', 'other')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (policy_id, period_start)
);

-- Which assets a policy names. A link alone isn't confirmed cover: the policy must be verified too.
CREATE TABLE asset_policy_links (
    policy_id TEXT NOT NULL REFERENCES asset_policies (id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    agreed_value_cents INTEGER CHECK (agreed_value_cents IS NULL OR agreed_value_cents >= 0),
    note TEXT CHECK (note IS NULL OR length(note) <= 300),
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (policy_id, asset_id)
);
CREATE INDEX asset_policy_links_asset ON asset_policy_links (asset_id);

-- Warranties stated by a manufacturer, retailer or extended-warranty provider. These are separate
-- from Australian Consumer Law guarantees, which don't simply end when a stated warranty does.
CREATE TABLE asset_warranties (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('manufacturer', 'extended', 'retailer', 'other')),
    provider TEXT CHECK (provider IS NULL OR length(provider) <= 120),
    starts_on TEXT CHECK (starts_on IS NULL OR starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    months INTEGER CHECK (months IS NULL OR months BETWEEN 1 AND 600),
    -- Entered as stated, or worked out from the start date and months (expires_basis says which).
    expires_on TEXT CHECK (expires_on IS NULL OR expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    expires_basis TEXT NOT NULL DEFAULT 'unknown' CHECK (expires_basis IN ('stated', 'calculated', 'unknown')),
    reference TEXT CHECK (reference IS NULL OR length(reference) <= 80),
    terms TEXT CHECK (terms IS NULL OR length(terms) <= 4000),
    contact TEXT CHECK (contact IS NULL OR length(contact) <= 300),
    cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX asset_warranties_asset ON asset_warranties (asset_id);
CREATE INDEX asset_warranties_expiry ON asset_warranties (expires_on);

-- Warranty and insurance claims: what was claimed, and the outcome.
CREATE TABLE asset_claims (
    id TEXT PRIMARY KEY,
    asset_id TEXT REFERENCES assets (id) ON DELETE CASCADE,
    warranty_id TEXT REFERENCES asset_warranties (id) ON DELETE SET NULL,
    policy_id TEXT REFERENCES asset_policies (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('warranty', 'insurance', 'consumer_guarantee')),
    lodged_on TEXT CHECK (lodged_on IS NULL OR lodged_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    reference TEXT CHECK (reference IS NULL OR length(reference) <= 80),
    description TEXT CHECK (description IS NULL OR length(description) <= 4000),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('preparing', 'open', 'approved', 'declined', 'settled', 'withdrawn')),
    amount_claimed_cents INTEGER CHECK (amount_claimed_cents IS NULL OR amount_claimed_cents >= 0),
    amount_paid_cents INTEGER CHECK (amount_paid_cents IS NULL OR amount_paid_cents >= 0),
    outcome TEXT CHECK (outcome IS NULL OR length(outcome) <= 2000),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (asset_id IS NOT NULL OR policy_id IS NOT NULL)
);
CREATE INDEX asset_claims_asset ON asset_claims (asset_id);
CREATE INDEX asset_claims_policy ON asset_claims (policy_id);

-- --- Files ----------------------------------------------------------------------------------------

-- Photos and documents in R2 under private/assets/ (never served by a public route). Each file
-- belongs to exactly one record: an asset (optionally also tied to one of its maintenance records,
-- warranties or claims), a location, a policy, or nothing yet (an upload waiting in the person's
-- own capture inbox). Photos have a small preview stored beside them.
CREATE TABLE asset_files (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL COLLATE NOCASE,
    asset_id TEXT REFERENCES assets (id) ON DELETE SET NULL,
    location_id TEXT REFERENCES asset_locations (id) ON DELETE SET NULL,
    policy_id TEXT REFERENCES asset_policies (id) ON DELETE SET NULL,
    maintenance_id TEXT REFERENCES asset_maintenance (id) ON DELETE SET NULL,
    warranty_id TEXT REFERENCES asset_warranties (id) ON DELETE SET NULL,
    claim_id TEXT REFERENCES asset_claims (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('photo', 'receipt', 'invoice', 'registration', 'policy', 'warranty', 'manual', 'service_record', 'inspection', 'quote', 'other')),
    photo_tag TEXT CHECK (photo_tag IS NULL OR photo_tag IN ('general', 'purchase', 'condition', 'damage', 'repair', 'inspection')),
    caption TEXT CHECK (caption IS NULL OR length(caption) <= 300),
    filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
    content_type TEXT NOT NULL CHECK (length(content_type) <= 100),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    r2_key TEXT NOT NULL UNIQUE CHECK (r2_key LIKE 'private/assets/%'),
    thumb_key TEXT UNIQUE CHECK (thumb_key IS NULL OR thumb_key LIKE 'private/assets/%'),
    width INTEGER,
    height INTEGER,
    status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    -- At most one parent record.
    CHECK ((asset_id IS NOT NULL) + (location_id IS NOT NULL) + (policy_id IS NOT NULL) <= 1)
);
CREATE INDEX asset_files_asset ON asset_files (asset_id, status);
CREATE INDEX asset_files_location ON asset_files (location_id, status);
CREATE INDEX asset_files_policy ON asset_files (policy_id, status);
CREATE INDEX asset_files_owner ON asset_files (owner_email, status);
CREATE INDEX asset_files_hash ON asset_files (sha256);

-- Knowledge objects about an asset (manuals, notes, troubleshooting). Nothing is copied: the
-- object stays in Knowledge, readable only by its space's members, checked on every read.
CREATE TABLE asset_knowledge_links (
    asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    object_id TEXT NOT NULL CHECK (length(object_id) <= 40),
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (asset_id, object_id)
);

-- --- Tasks, reminders and history -----------------------------------------------------------------

-- Daly Tasks created for asset work: one per maintenance record, or one per renewal or expiry date
-- (ref_kind + ref_id + ref_date). The task lives in Tasks; this only remembers that it was made.
CREATE TABLE asset_task_links (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE CHECK (length(task_id) <= 40),
    asset_id TEXT REFERENCES assets (id) ON DELETE CASCADE,
    ref_kind TEXT NOT NULL CHECK (ref_kind IN ('maintenance', 'schedule', 'registration', 'policy_renewal', 'warranty_expiry', 'inspection', 'lease_end', 'roadside')),
    ref_id TEXT NOT NULL CHECK (length(ref_id) <= 40),
    ref_date TEXT NOT NULL DEFAULT '' CHECK (length(ref_date) <= 10),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (ref_kind, ref_id, ref_date)
);
CREATE INDEX asset_task_links_asset ON asset_task_links (asset_id);

-- Reminders, one per person per date and offset, so none is ever sent twice. Ids only: what each
-- one says is worked out when it's read, from the record as that person may see it now.
CREATE TABLE asset_notifications (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    reminder TEXT NOT NULL CHECK (reminder IN ('maintenance', 'registration', 'insurance', 'warranty', 'inspection', 'lease', 'roadside')),
    ref_id TEXT NOT NULL CHECK (length(ref_id) <= 40),
    due_on TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    offset_days INTEGER NOT NULL CHECK (offset_days BETWEEN -365 AND 365),
    fire_on TEXT NOT NULL CHECK (fire_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL,
    dismissed_at TEXT,
    email_status TEXT NOT NULL DEFAULT 'none' CHECK (email_status IN ('none', 'pending', 'sending', 'sent', 'skipped', 'failed')),
    email_attempts INTEGER NOT NULL DEFAULT 0,
    emailed_at TEXT,
    UNIQUE (email, reminder, ref_id, due_on, offset_days)
);
CREATE INDEX asset_notifications_email ON asset_notifications (email, dismissed_at, fire_on);
CREATE INDEX asset_notifications_pending ON asset_notifications (email_status, fire_on);

-- History without content: who did what to which record.
CREATE TABLE asset_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (length(action) <= 60),
    entity_type TEXT NOT NULL CHECK (length(entity_type) <= 30),
    entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 40),
    asset_id TEXT CHECK (asset_id IS NULL OR length(asset_id) <= 40),
    via TEXT NOT NULL DEFAULT 'portal' CHECK (via IN ('portal', 'mcp', 'system'))
);
CREATE INDEX asset_activity_asset ON asset_activity (asset_id, at);
CREATE INDEX asset_activity_at ON asset_activity (at);

-- --- MCP write ledger -----------------------------------------------------------------------------

-- SQLite can't widen a CHECK in place: rebuild mcp_writes with the asset outcomes, copying every
-- row unchanged (same columns, order and indexes; nothing refers to the table).
CREATE TABLE mcp_writes_next (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (length(tool) <= 64),
    -- The client's request id. Cleared when the write fails, so the same id can be tried again.
    request_key TEXT CHECK (request_key IS NULL OR length(request_key) BETWEEN 8 AND 64),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    entity_type TEXT CHECK (
        entity_type IS NULL OR entity_type IN (
            'task', 'task_knowledge_link', 'knowledge_object', 'task_project', 'ai_capture', 'ai_suggestion',
            'calendar_event', 'calendar_subscription', 'leave_booking', 'task_time_block',
            'asset', 'asset_maintenance', 'asset_link'
        )
    ),
    entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 64),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
    created_at TEXT NOT NULL,
    completed_at TEXT
);

INSERT INTO mcp_writes_next (id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at)
SELECT id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at FROM mcp_writes;

DROP TABLE mcp_writes;
ALTER TABLE mcp_writes_next RENAME TO mcp_writes;

CREATE UNIQUE INDEX mcp_writes_request ON mcp_writes (email, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX mcp_writes_email ON mcp_writes (email, created_at);
