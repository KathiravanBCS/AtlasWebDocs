# Database Design Standards

Engineering playbook for relational schema design — naming, keys, public identifiers, audit columns, money, time, tenancy, status workflows, shared tables, referential integrity, indexing, concurrency, security, retention, and migration discipline for every new table and every schema change.

Written for PostgreSQL (14+ assumed; features tied to newer versions are flagged). Almost every rule applies to any relational database.

Each rule uses this language:

- **Must** — required; violating it blocks the review
- **Should** — the default; deviating needs a documented reason
- **Never** — prohibited

These standards exist to prevent the failure modes that actually ship to production: silent timezone bugs, sequential scans on unindexed foreign keys, deletes that crash on broken constraints, enumerable API ids, lost updates between concurrent editors, cross-tenant data leaks, lock storms from careless migrations, conventions that drift between authors and tools, and unprotected personal data.

## Contents

1. Naming conventions
2. Primary keys and identifiers
3. The standard audit block
4. Lifecycle flags: soft delete and active
5. Dates and times
6. Money and numeric data
7. Text and case sensitivity
8. Constraints and nullability
9. One source of truth for value sets
10. Status and workflow
11. Polymorphic associations
12. The snapshot pattern (immutable documents)
13. Referential integrity
14. Multi-tenancy
15. Concurrency and locking
16. Indexing
17. Normalization and jsonb
18. Files and binary data
19. Personal data, retention, and erasure
20. Roles and least privilege
21. Database logic: triggers, views, procedures
22. Migrations and zero-downtime change
23. Seed and reference data
24. In-schema documentation
25. Schema review checklist
26. Anti-pattern gallery

---

## 1. Naming conventions

| Object | Rule | Example |
|---|---|---|
| Table | lowercase snake_case, singular | `customer`, `invoice`, `sales_order` |
| Column | lowercase snake_case | `total_amount`, `due_date` |
| Primary key | always `id` | `id` |
| Foreign key | referenced table + `_id` | `customer_id`, `branch_id` |
| Public identifier | always `public_id` | `public_id` |
| Tenant column | always `tenant_id` | `tenant_id` |
| Boolean | `is_` / `has_` prefix | `is_deleted`, `has_attachments` |
| Enum type | snake_case + `_enum` suffix | `task_priority_enum` |
| Junction table | both parent names | `project_member`, `invoice_tag` |

**Constraint and index naming scheme** — adopt once, enforce in every review:

`pk_<table>` · `fk_<table>_<ref>` · `uq_<table>_<cols>` · `ck_<table>_<rule>` · `ix_<table>_<cols>` · `ex_<table>_<rule>` (exclusion)

### Rules

- **Must** use singular table names. (Plural is an equally common industry convention — the universal rule is *one convention, total consistency*. This playbook standardizes on singular; a schema that mixes `customer` with `orders` and `addresses` is the most visible symptom of convention drift across authors.)
- **Never** allow quoted identifiers of any kind (`"serviceItemId"`, `"Order"`). Quoted camelCase columns are ORM migration artifacts — configure the ORM to map camelCase model fields to snake_case columns instead (e.g., Prisma `@map` / `@@map`).
- **Avoid** SQL reserved words as identifiers (`order`, `user`, `comment`, `name`, `role`). Rename or prefix: `sales_order`, `app_user`. Quoted reserved words work, but you will be quoting them in every query forever.
- **Must** name one concept one way, everywhere. `balance_amount` in one table and `bal_amount` in another is two bugs waiting to happen — and a typo (`prise_as_custom_text`) will leak into your API contracts and live there permanently.
- **Must** name columns for what they actually contain. A column called `invoice_date` that stores the payment date will mislead every developer who ever reads it.
- **Must** name constraints explicitly and accurately:

```sql
-- ✅ The name describes what it constrains
CONSTRAINT fk_invoice_customer
  FOREIGN KEY (customer_id) REFERENCES customer (id)

-- ❌ Copy-pasted from another table — the name lies about the column
CONSTRAINT bank_account_partner_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branch (id)
```

- Stale names left over from renames (a unique constraint still named after a column that no longer exists) **must** be fixed in the same migration as the rename.

---

## 2. Primary keys and identifiers

- Every table **must** have a primary key. No exceptions — including log tables, filter tables, history tables, and AI/analysis result tables. A serial column that was never declared `PRIMARY KEY` is just an integer with a default.
- **Should** use `bigint GENERATED ALWAYS AS IDENTITY` for surrogate keys. It is the SQL-standard successor to `serial` and rejects accidental manual inserts into the key.
- **Never** ship a table whose `id` has no default and is assigned by the application. That is a race condition with extra steps.
- **Should** keep the primary key `bigint`. UUID *primary* keys are a documented exception reserved for genuinely distributed id minting — 16-byte keys propagate into every foreign key and every index. (Public-facing UUIDs are a separate column; see §2.1.)
- Natural keys are allowed only for true reference data:

```sql
CREATE TABLE currency (
  code             varchar(3) PRIMARY KEY,        -- ISO 4217: 'USD', 'EUR', 'INR'
  name             varchar(100) NOT NULL,
  symbol           varchar(10),
  decimal_places   smallint NOT NULL DEFAULT 2
    CHECK (decimal_places BETWEEN 0 AND 3),       -- JPY = 0, KWD/BHD = 3
  is_base_currency boolean NOT NULL DEFAULT false
);
```

- **Must** add a uniqueness guarantee wherever the business expects one. A results table keyed by `(user_id, external_message_id)` with no unique constraint will accumulate duplicates.

### 2.1 The triple-identifier pattern

Every externally visible business entity carries three identifiers:

| Identifier | Type | Audience | Properties |
|---|---|---|---|
| `id` | `bigint` identity | Internal only | Target of every FK; never leaves the backend |
| `public_id` | `uuid` (UUIDv7) | APIs, URLs, webhooks, exported logs | Opaque, non-enumerable, `UNIQUE` |
| business code | `varchar`, e.g. `INV-2026-0042` | Humans | Immutable, `UNIQUE`; what users see, search, and quote |

```sql
CREATE TABLE invoice (
  id           bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid    NOT NULL UNIQUE DEFAULT uuidv7(),   -- PostgreSQL 18+
  invoice_code varchar(30) NOT NULL UNIQUE,
  -- ...
);
```

- **Never** expose sequential `id` values in URLs, API payloads, filenames, or webhooks. Sequential ids leak business volume (`/invoices/1041` tells a competitor your count) and invite enumeration (IDOR) attacks — the attacker's next target is always `id + 1`.
- **Must** use UUIDv7, not v4, for `public_id`: v7 is time-ordered, so inserts stay local in the b-tree instead of fragmenting it. On PostgreSQL ≤ 17, generate v7 in the application or via an extension; `gen_random_uuid()` (v4) is an acceptable fallback only at low write volume, at the cost of index locality.
- `public_id` is for lookup at the boundary; internal joins and foreign keys still use `id`.
- Internal-only tables (line items addressed through their parent, junction rows, history rows) may omit `public_id`.

### 2.2 Formatted business codes

Formatted codes come from a central counter table, not a native sequence — sequences cannot produce `INV-2026-0042`, and they leave gaps on rollback:

```sql
CREATE TABLE code_sequence (
  entity_type varchar(50) PRIMARY KEY,
  last_number int NOT NULL DEFAULT 0
);
```

Read and increment the counter with a row lock inside the same transaction that inserts the document:

```sql
SELECT last_number FROM code_sequence WHERE entity_type = $1 FOR UPDATE;
UPDATE code_sequence SET last_number = last_number + 1 WHERE entity_type = $1;
```

- Without the `FOR UPDATE`, concurrent requests will mint duplicate codes.
- **Know the cost:** the row lock serializes all inserts of that entity type for the duration of the transaction. Fine for documents created by humans; wrong for high-throughput rows (events, messages, sync records) — those get a native sequence or no formatted code at all.
- Keep the code-minting transaction short. **Never** call external services while holding the lock.
- Gapless numbering is a *legal* requirement only for specific documents in specific jurisdictions (e.g., tax invoices under some VAT/GST regimes). Where gaps are acceptable, a native sequence plus formatting is simpler and faster — document which regime applies to each code series.

---

## 3. The standard audit block

Every business table carries the same four columns, in the same order, with the same types:

```sql
created_at timestamptz NOT NULL DEFAULT now(),
created_by bigint REFERENCES app_user (id),
updated_at timestamptz,
updated_by bigint REFERENCES app_user (id)
```

### Rules

- **Must** pick one actor-column type for the whole schema. A foreign key to the user table is preferred (it survives renames and enables joins); plain text is acceptable only if user records can be hard-deleted. **Never** mix — text here, `varchar(255)` there, an integer FK somewhere else is unauditable.
- **Actor rows are deactivated, never hard-deleted.** The audit FKs default to `RESTRICT`, which is correct — it means `app_user` rows must never be removed once they have touched anything. Off-boarding sets `is_active = false`; legally required erasure anonymizes the row in place (see §19). This ruling is what makes `RESTRICT` safe.
- **`updated_at` is maintained by a trigger, not the ORM.** Only a trigger survives admin scripts, bulk SQL, and writes from other services:

```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_updated_at
  BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

  One ruling per schema: trigger-maintained or ORM-maintained — but if *any* write path bypasses the ORM, triggers are the only honest answer. `updated_by` remains the application's responsibility: the database does not know the acting user.
- **Never** invent per-table variants (`uploaded_by`, `entered_by`) alongside the standard names. If the semantic really is different (e.g. an approver), add it as an *extra* column — don't replace the standard block.
- Append-only tables (event logs, status history) get only `created_at` + the actor. They **must not** have `updated_at`, `updated_by`, or a soft-delete flag — history is immutable.
- Workflow actor columns **must** follow the same standard as audit actors. `approved_by` as an FK but `rejected_by` as free text in the same table is drift.

---

## 4. Lifecycle flags: soft delete and active

| Table category | Flag | Default |
|---|---|---|
| Transactional / business documents | `is_deleted boolean NOT NULL` | `false` |
| Master / configuration / templates | `is_active boolean NOT NULL` | `true` |
| Append-only logs and history | *(none)* | — |

### Rules

- **Must** apply the flag consistently across a domain. If line items of one document type are soft-deletable, line items of its sibling document type must be too — gaps force the application to special-case deletes.
- **Never** give a table both `is_deleted` and a status enum containing `DELETED`/`ARCHIVED`. Two deletion mechanisms on one table guarantee they disagree eventually. Pick one.
- Every list query filters on the flag, so pair it with partial indexes (see §16).
- Soft delete is an application contract, not just a column — document whether unique constraints apply to deleted rows (usually they shouldn't; use partial unique indexes `WHERE is_deleted = false`).
- If the parent uses soft delete, the application **must** apply the flag to the children in the same transaction — `ON DELETE CASCADE` only fires on a real `DELETE`, never on an `UPDATE`.
- Soft-delete flags are one of three valid lifecycle strategies (flag, archive table, temporal/history table). Pick one per domain and write it down; this playbook standardizes on the flag for transactional data.

---

## 5. Dates and times

- **Must** use `timestamptz` for every point-in-time value. `timestamp without time zone` is banned — one table using `timestamptz` while fifty-four use `timestamp` is not a convention, it's a landmine.
- **Must** store UTC; convert at the application edge.
- **Should** use `date` for calendar concepts that have no time-of-day or timezone: birthdays, due dates, holidays, leave days.
- Durations are `interval`, or an integer with the unit in the name (`duration_seconds int`). **Never** text (`'2 hours'`).
- Validity windows are paired columns with a check — `valid_from` / `valid_to`, `CHECK (valid_from < valid_to)` — and an exclusion constraint when overlap is forbidden (§8).

Naive timestamps *appear* to work while all servers and users share one timezone. The bugs surface the day you add a second region, a daylight-saving transition, or a server migration — and by then the data is ambiguous forever.

---

## 6. Money and numeric data

- **Must** store money as `numeric`. **Never** `float`, `real`, `double precision` (binary floating point cannot represent 0.1), and never the `money` type (locale-dependent formatting baked into the value).
- **Scale must cover every currency you support.** ISO 4217 exponents run from 0 (JPY) to 3 (KWD, BHD, OMR):
  - Platforms handling only 2-decimal currencies: `numeric(15,2)`, and constrain the `currency` seed data to `decimal_places = 2`.
  - Multi-currency platforms: `numeric(15,4)` for stored amounts (or `bigint` minor units with the convention documented), rounding to `currency.decimal_places` at posting and presentation.
- **Must** name the rounding mode once, platform-wide: round-half-even ("banker's rounding") is the accounting default; round-half-up is acceptable if documented. Two services rounding differently produce penny drift that reconciliation chases forever.
- **Must** put `currency_code varchar(3) NOT NULL DEFAULT '<base>' REFERENCES currency (code)` on every table that stores a monetary amount — headers and line items alike.
- **Should** store percentages as `numeric(5,2)`, with a range check where the domain demands it:

```sql
progress_percentage numeric(5,2) NOT NULL DEFAULT 0
  CHECK (progress_percentage >= 0 AND progress_percentage <= 100)
```

- **Never** store numeric data as text. `salary`, `annual_revenue`, `years_of_experience`, `employee_count` as `varchar` cannot be summed, compared, or validated. The same rule applies to dates-as-text.
- **Avoid** per-currency price columns on catalog tables (`price_usd`, `price_eur`, `price_inr`). Prefer a child price table keyed by currency. If you deliberately denormalize for read speed, document it as an exception (§24).
- Multi-jurisdiction tax fields (applicability flags, registration numbers, classification codes) belong on the documents that need them; variable tax breakdowns are a legitimate use of `jsonb` (§17).

---

## 7. Text and case sensitivity

- **Should** default to `text` for free-form content: names, descriptions, comments, URLs, addresses. In PostgreSQL, `varchar(n)` has no performance advantage over `text`; arbitrary caps (`varchar(255)`) are a habit imported from other engines that eventually truncates real data. Use `varchar(n)` only where the cap is the actual shape of the value — ISO codes (`varchar(3)`), discriminators, status codes, formatted business codes.
- **Must** make identity-bearing text case-insensitive *at the constraint level*. `UNIQUE (email)` happily stores `Foo@x.com` and `foo@x.com` as two different users:

```sql
CREATE UNIQUE INDEX uq_app_user_email ON app_user (lower(email));
-- alternative: the citext extension with a plain UNIQUE constraint
```

  Lookups must use the same expression (`WHERE lower(email) = lower($1)`) or the index is skipped.
- **Must** pick one meaning for "no value": `NULL`. **Never** store empty string as absent. Required text gets `CHECK (trim(col) <> '')`.
- **Should** normalize at the edge — trim whitespace, lowercase emails — before insert. The constraint is the backstop, not the normalizer.

---

## 8. Constraints and nullability

- **Must** default every column to `NOT NULL`. Nullability is an explicit design decision — it means "absent/unknown is a valid state for this value", and that meaning is documented. A schema where null-ness is accidental forces every reader to handle three states everywhere.
- **Should** encode the invariants the business states as `CHECK` constraints:

```sql
quantity   numeric(10,2) NOT NULL CHECK (quantity > 0),
unit_price numeric(15,4) NOT NULL CHECK (unit_price >= 0),
valid_from date NOT NULL,
valid_to   date,
CHECK (valid_to IS NULL OR valid_from < valid_to)
```

- PostgreSQL 15+: use `UNIQUE NULLS NOT DISTINCT` when a nullable column participates in a dedup key and at most one NULL row per group is allowed. (Standard `UNIQUE` treats every NULL as distinct.)
- Forbid overlapping ranges with an *exclusion constraint*, not application checks — concurrent inserts race past app-side validation:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE room_booking
  ADD CONSTRAINT ex_room_booking_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  );
```

- The division of labor: the application validates for *user experience* (early, friendly errors); the database constrains for *truth*. Constraints are the only validation that covers every write path — services, admin scripts, bulk jobs, and the next team.

---

## 9. One source of truth for value sets

There are three ways to constrain a column to a fixed set of values. Pick one per column — and only after choosing deliberately:

| Mechanism | Use when | Trade-off |
|---|---|---|
| Native `ENUM` type | Small, stable, code-defined sets that **never shrink**: priority, role, channel | Values can be added but not dropped (`DROP VALUE` does not exist); removal means rebuilding the type |
| `CHECK (col IN (...))` | Small sets that change occasionally | Easy to alter; allowed values visible in the DDL |
| Lookup table + FK | Business-managed sets needing metadata: labels, ordering, terminal flags | One join away; runtime-editable |

### Rules

- **Never** define an enum type and then declare the column as text with a duplicate `CHECK` list. Two sources of truth drift apart — the enum gains a value the `CHECK` doesn't allow, or vice versa.
- **Never** leave defined-but-unused enum types in the schema. Either use them or drop them in the next migration.
- Because PostgreSQL enums cannot drop values, **reserve native enums for sets that only ever grow**. Anything a product manager might rename or retire belongs in a `CHECK` or a lookup table.
- If a lookup table governs the values, **should** add a real FK to it rather than validating only in the application.

---

## 10. Status and workflow

Workflow state is modeled with three cooperating pieces:

```sql
-- 1. Definitions: which statuses exist, per context, in what order
CREATE TABLE status_definition (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context     varchar(50)  NOT NULL,   -- 'INVOICE', 'PROJECT', 'TASK'
  status_code varchar(50)  NOT NULL,
  label       varchar(100) NOT NULL,
  sequence    int          NOT NULL,
  is_final    boolean      NOT NULL DEFAULT false,
  is_active   boolean      NOT NULL DEFAULT true,
  UNIQUE (context, status_code)
);

-- 2. Current state: one column on the business table
status_code varchar(50) NOT NULL DEFAULT 'DRAFT'

-- 3. Transitions: an append-only history with the actor
CREATE TABLE status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type varchar(50) NOT NULL
    CHECK (entity_type IN ('INVOICE', 'PROJECT', 'TASK')),
  entity_id   bigint      NOT NULL,
  from_status varchar(50),
  to_status   varchar(50) NOT NULL,
  comment     text,
  changed_by  bigint      NOT NULL REFERENCES app_user (id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_status_history_entity
  ON status_history (entity_type, entity_id, changed_at);
```

`status_history` is itself a polymorphic table and follows every rule in §11 — discriminator `CHECK` and composite index included.

### Rules

- **Must** validate `status_code` the same way on every table — all via `CHECK`, or all via the lookup. Half-and-half means nobody knows where the allowed values live.
- **Must** default new rows to the *entry* state of the workflow, never a terminal or consumed one. A notification table defaulting status to `'READ'` means every notification is born already read.
- Status history rows are immutable: insert-only, no updates, no soft delete.
- Legal transitions live in **exactly one place**: a transition map in the service layer, or — when the business edits workflows at runtime — a `status_transition (context, from_status, to_status)` table the service validates against. Never scattered if-statements per endpoint.
- Embedded workflow columns (`approved_by`/`approved_at`, `rejected_reason`) are fine for simple two-step approvals — but once a table grows three or more such column clusters, migrate to `status_code` + history.

---

## 11. Polymorphic associations

Cross-cutting concerns — addresses, contact persons, bank accounts, comments, file attachments, status history, notifications — attach to many parents. Instead of N copies of the same table, use one shared table with a discriminator pair:

```sql
CREATE TABLE address (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type varchar(20) NOT NULL
    CHECK (entity_type IN ('CUSTOMER', 'VENDOR', 'PARTNER')),
  entity_id   bigint      NOT NULL,
  -- address fields ...
  is_primary  boolean NOT NULL DEFAULT false,
  is_billing  boolean NOT NULL DEFAULT false,
  is_shipping boolean NOT NULL DEFAULT false
  -- standard audit block + is_deleted
);

CREATE INDEX ix_address_entity ON address (entity_type, entity_id);
```

### Rules

- **Must** use one discriminator naming convention everywhere: `entity_type` / `entity_id`. Don't drift into `context_type` / `context_id` on some tables — it breaks generic data-access code.
- **Must** put a `CHECK` constraint on `entity_type` in every polymorphic table, listing the allowed parents. An unconstrained discriminator will accumulate typos (`'Customer'`, `'CUSTOMERS'`) that orphan rows silently.
- **Must** create the composite index `(entity_type, entity_id)` — it is the access path for every lookup.
- **Accept the trade-off knowingly.** The database cannot verify that `entity_id` points to a live row. Deletion cleanup is the service layer's job; write that contract down. Most DBA literature classifies this pattern as an anti-pattern *unless* mitigated exactly this way — the `CHECK`, the composite index, and the documented cleanup contract are not optional garnish; they are the mitigation.
- **Should** keep `is_primary` / role flags on the shared table rather than FK columns on each parent.
- **When not to use it:** high-integrity or regulated data deserves dedicated child tables with hard foreign keys. It is a legitimate design to give, say, HR records their own `employee_address`, `employee_bank_account`, and `emergency_contact` tables with real FKs while business entities share polymorphic ones — but that dual standard **must** be documented (§24), or the next developer will treat it as an accident.

---

## 12. The snapshot pattern (immutable documents)

Financial and contractual documents must not change retroactively when catalog data changes. Line items therefore copy the descriptive and pricing fields at creation time, while keeping a lineage FK to the source:

```sql
CREATE TABLE order_item (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_order_id      bigint NOT NULL REFERENCES sales_order (id) ON DELETE CASCADE,
  product_id          bigint REFERENCES product (id),  -- lineage: where it came from

  product_name        varchar(255) NOT NULL,  -- snapshot at time of order
  product_description text,                   -- snapshot
  catalog_rate        numeric(15,2) NOT NULL, -- price list at time of order
  agreed_rate         numeric(15,2) NOT NULL, -- negotiated price actually charged

  quantity            numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  discount_amount     numeric(15,2) NOT NULL DEFAULT 0
);
```

### Rules

- **Must** snapshot name, description, and rate on every line item of a quote, contract, order, or invoice. Re-reading them from the catalog rewrites history.
- **Must** keep both rates: the catalog price at the time and the negotiated price. The difference is your discount audit trail.
- **Should** chain lineage FKs through the whole pipeline — catalog → quote item → contract item → invoice item — so every billed amount traces back to its origin.
- Denormalized rollups (`total_billed_amount`, `billing_progress` maintained on a parent) are acceptable, but the application owns keeping them correct — name them clearly, recompute them in **one** place, and `COMMENT` them (§24).
- This is the one sanctioned exception to "don't duplicate data." **Must** label snapshot columns as such via `COMMENT ON` so reviewers don't "fix" them.

---

## 13. Referential integrity

Every column that points at another table gets a real foreign key. Owner ids, manager ids, interviewer ids, branch ids, "source user" / "target user" — all of them. "The application validates it" is how orphaned rows are born.

**Must** choose `ON DELETE` behavior deliberately:

| Relationship | Policy |
|---|---|
| Line items → their document | `CASCADE` |
| Junction rows → either parent | `CASCADE` |
| Business rows → master/reference data | `RESTRICT` (default) |
| Optional lineage / template references | `SET NULL` — only if the column is nullable |

**Deleting a parent must take its dependent children with it.** When a child row is meaningless without its parent — an order line without its order, an invoice item without its invoice, an attachment without its document — the child FK **must** declare `ON DELETE CASCADE` so the database removes the children in the same transaction. **Never** rely on the application to "remember" to delete child rows first: any path that bypasses it (admin script, bulk job, another service) leaves orphans or fails on the constraint.

```sql
CREATE TABLE sales_order_item (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_order_id  bigint NOT NULL REFERENCES sales_order (id) ON DELETE CASCADE,
  product_id      bigint NOT NULL REFERENCES product (id),  -- RESTRICT: reference data
  quantity        int    NOT NULL CHECK (quantity > 0)
);

-- One statement removes the order AND all of its items, atomically
DELETE FROM sales_order WHERE id = 42;
```

Cascade only flows from owner to owned. The same table's FK to reference data (`product_id` above) stays `RESTRICT` — deleting a product must not silently rewrite history. And if the parent uses soft delete (§4), the application must flag the children in the same transaction.

**Never** combine `NOT NULL` with `ON DELETE SET NULL`. The delete will always fail with a constraint violation — this is an outright bug, not a style issue:

```sql
-- ❌ Deleting the parent can never succeed
parent_id bigint NOT NULL REFERENCES parent (id) ON DELETE SET NULL

-- ✅ Either allow null...
parent_id bigint REFERENCES parent (id) ON DELETE SET NULL
-- ✅ ...or cascade/restrict
parent_id bigint NOT NULL REFERENCES parent (id) ON DELETE CASCADE
```

**Never** use sentinel defaults in place of a foreign key. `branch_id int NOT NULL DEFAULT 0` with no FK is a value that can never reference a real row. Use a nullable FK, or seed a genuine default row and reference it.

**Junction tables:** composite `UNIQUE (a_id, b_id)`, `CASCADE` from the owning side, and a minimal audit (`created_at`, `created_by` / `assigned_at`, `assigned_by`). Add an ordering column (`sort_order`) when sequence matters.

**Either/or parents** (a document that belongs to exactly one of two entity types) use two nullable FKs, a discriminator, and a `CHECK` that enforces exclusivity:

```sql
target_type  varchar(20) NOT NULL CHECK (target_type IN ('CUSTOMER', 'PARTNER')),
customer_id  bigint REFERENCES customer (id),
partner_id   bigint REFERENCES partner (id),
CHECK (
  (target_type = 'CUSTOMER' AND customer_id IS NOT NULL AND partner_id IS NULL) OR
  (target_type = 'PARTNER'  AND partner_id  IS NOT NULL AND customer_id IS NULL)
)
```

**Self-referencing FKs** are the standard for hierarchies (category trees, threaded comments, interview rounds, org reporting lines): `parent_id REFERENCES same_table (id)`, usually `ON DELETE SET NULL` for trees and `CASCADE` for threads.

**Deferrable constraints:** mutually-referencing rows that must be inserted in one transaction (rare) may declare the FK `DEFERRABLE INITIALLY DEFERRED` rather than dropping the constraint. Prefer restructuring; deferral is a documented exception.

---

## 14. Multi-tenancy

Applies when one schema serves many customer organizations from shared tables. (Single-tenant deployments and schema-per-tenant designs skip this section — say so in the data dictionary.)

- **Must** put `tenant_id bigint NOT NULL REFERENCES tenant (id)` on every tenant-owned table — parents, children, line items, and junction rows alike. Deriving tenancy through joins makes row-level security impossible and every hot index wrong.
- **Must** scope uniqueness by tenant: `UNIQUE (tenant_id, invoice_code)`. A global `UNIQUE (invoice_code)` makes one tenant's numbering collide with another's.
- **Must** lead tenant-owned indexes with `tenant_id`: `(tenant_id, status_code)`, `(tenant_id, created_at)`. Every query in a multi-tenant system filters by tenant first.
- **Should** make cross-tenant pointers *unrepresentable* on sensitive domains with composite foreign keys:

```sql
-- parent gains a composite uniqueness target
ALTER TABLE sales_order
  ADD CONSTRAINT uq_sales_order_tenant_id UNIQUE (tenant_id, id);

-- child references parent THROUGH the tenant
ALTER TABLE sales_order_item
  ADD CONSTRAINT fk_sales_order_item_order
  FOREIGN KEY (tenant_id, sales_order_id)
  REFERENCES sales_order (tenant_id, id) ON DELETE CASCADE;
```

  A child can now never point at another tenant's parent, no matter what the application does.
- **Should** enable Row-Level Security as defense in depth:

```sql
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice
  USING (tenant_id = current_setting('app.tenant_id')::bigint);
```

  The application sets `SET LOCAL app.tenant_id = '<id>'` at transaction start. RLS catches the one query someone forgot to filter; the explicit `WHERE tenant_id = $1` stays in code for clarity and for the planner.
- Global reference tables (`currency`, `status_definition`, `country`) are tenant-less by design — list them in the data dictionary so a missing `tenant_id` reads as deliberate, not forgotten.

---

## 15. Concurrency and locking

- **Must** add optimistic locking to business documents that humans edit:

```sql
version int NOT NULL DEFAULT 1
```

```sql
UPDATE invoice
SET    ..., version = version + 1, updated_by = $3
WHERE  id = $1 AND version = $2;
-- 0 rows updated → the row changed under this editor → surface a conflict
```

  **Never** silent last-write-wins on documents two people can have open at once.
- Allocation problems (counters, stock, seat assignment) use pessimistic `SELECT ... FOR UPDATE` inside short transactions (§2.2).
- Job/queue tables drain with `FOR UPDATE SKIP LOCKED` so workers don't serialize on each other.
- **Never** hold row locks across user think-time or external API calls. Lock, mutate, commit.

---

## 16. Indexing

PostgreSQL does not automatically index foreign key columns. A schema whose only indexes are primary keys and unique constraints will sequential-scan every join, every assignee filter, and every polymorphic lookup as soon as data grows.

- **Must** index every foreign key column: `customer_id` on documents, `assigned_to` on tasks, and so on.
- **Must** index every polymorphic pair: `(entity_type, entity_id)`.
- **Must** order composite indexes equality-first, then the range or sort column: `(tenant_id, status_code, due_date)` serves `WHERE tenant_id = ? AND status_code = ? ORDER BY due_date`. The reverse order serves almost nothing.
- **Should** add partial indexes for soft-delete-filtered hot paths:

```sql
CREATE INDEX ix_invoice_customer_active
  ON invoice (customer_id)
  WHERE is_deleted = false;
```

- **Should** index columns used in routine filters and sorts: `status_code`, `due_date`, `created_at` on list-heavy tables.
- **Should** use `INCLUDE` when a hot list query reads only a few extra columns — `ON invoice (customer_id) INCLUDE (invoice_code, total_amount)` enables index-only scans.
- Expression indexes back expression lookups: `lower(email)` (§7).
- GIN indexes (jsonb, arrays, full-text) only on columns *actually used as predicates* — GIN amplifies write cost.
- Unique business codes are covered automatically by their `UNIQUE` constraints — don't double-index them.
- **Should** review `pg_stat_user_indexes` quarterly and drop unused indexes; every index taxes every write.
- In production, indexes are built with `CREATE INDEX CONCURRENTLY` (§22).

Indexes are part of the table's design, not an afterthought: a migration that adds a table without its FK indexes is incomplete.

---

## 17. Normalization and jsonb

**Never** model repeating groups as numbered columns. `dependent1_name`, `dependent1_dob`, `dependent2_name`, `dependent2_dob` violates first normal form and hard-caps the business at two dependents:

```sql
-- ❌ Repeating group, capped at 2
spouse_name text, child1_name text, child1_dob date, child2_name text, child2_dob date

-- ✅ Child table, unlimited, queryable
CREATE TABLE insurance_dependent (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id bigint NOT NULL REFERENCES insurance_enrollment (id) ON DELETE CASCADE,
  relation      varchar(20) NOT NULL CHECK (relation IN ('SPOUSE', 'CHILD')),
  full_name     text NOT NULL CHECK (trim(full_name) <> ''),
  date_of_birth date NOT NULL,
  gender        varchar(10)
);
```

- **Never** duplicate a parent's identity fields into its children (copying a person's code, name, and birth date into every dependent row). Join for it. The only sanctioned duplication is the snapshot pattern (§12).
- **Must** use honest types: numbers as `numeric`/`int`, dates as `date`, flags as `boolean`. Free-text columns holding "5 years" or "12,00,000" are write-only data.

### jsonb

- `jsonb` is for genuinely variable structures you store and display but don't relationally filter or join on: tax breakdowns that differ by jurisdiction, raw extraction output from OCR, flexible metadata.
- Guard the shape minimally — `CHECK (jsonb_typeof(metadata) = 'object')` — and document the expected keys in a `COMMENT` (§24).
- **The promotion rule:** the moment a JSON field becomes a query predicate, a sort key, or an FK target, promote it to a real column in a migration.
- GIN-index a jsonb column only when it is genuinely queried (§16).

---

## 18. Files and binary data

**Never** store file bytes (`bytea`) in business tables. Files live in object storage (S3, SharePoint, GCS); the database stores a pointer record:

```sql
CREATE TABLE document (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_code varchar(30)  NOT NULL UNIQUE,
  entity_type   varchar(50)  NOT NULL
    CHECK (entity_type IN ('CUSTOMER', 'INVOICE', 'PROJECT')),
  entity_id     bigint       NOT NULL,
  external_id   varchar(255) NOT NULL UNIQUE,  -- id in the storage system
  web_url       text         NOT NULL,
  file_name     text         NOT NULL,
  file_size_kb  int,
  mime_type     varchar(100)
  -- standard audit block + is_deleted
);

CREATE INDEX ix_document_entity ON document (entity_type, entity_id);
```

One storage strategy per schema. If documents go to object storage, scanned images do too — don't run a pointer pattern and an in-row `bytea` pattern side by side.

---

## 19. Personal data, retention, and erasure

- **Must** classify: the data dictionary tags every column `none` / `internal` / `personal` / `sensitive`. New tables don't merge without it.
- **Must** protect national identity numbers, tax identifiers, and bank account numbers with column-level encryption or a vault/tokenization service, plus restricted database roles (§20). Plaintext government IDs in a master table are a compliance incident waiting for a breach (GDPR, DPDP, and similar regimes).
- **Should** minimize where PII lives: one authoritative table, joined when needed — never copied across child tables.
- Binary captures of personal data (ID scans, business-card images) follow §18: object storage with access controls, never in-row bytes.
- **Must** resolve "immutable history" vs. "right to erasure" by **anonymizing, not deleting**:

```sql
UPDATE app_user
SET    full_name = 'Deleted user',
       email     = 'deleted+' || id || '@example.invalid',
       phone     = NULL,
       is_active = false
WHERE  id = $1;
```

  History and audit rows keep their FK to the now-anonymous actor: lineage intact, person gone. Free-text columns that may carry PII (comments, descriptions) are in scope for scrubbing — list which.
- **Must** write a retention schedule per table class: business documents per statutory period; audit/history per policy (e.g., 7 years); operational logs short-lived (e.g., 90 days) with a scheduled purge job. The numbers vary by jurisdiction and domain; the existence of the *written schedule* does not.
- Backups contain the PII too: encrypt at rest, and define how restores of pre-erasure backups are handled.

---

## 20. Roles and least privilege

- **Must** run the application as a dedicated role with DML only (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) on the application schema. No DDL, no superuser, not the schema owner.
- **Must** run migrations as a separate role that owns the schema and is used only by the deployment pipeline.
- **Should** provide a read-only role for reporting/BI, with PII-bearing columns gated behind views or column grants.
- **Should** set `ALTER DEFAULT PRIVILEGES` so new tables inherit the standard grants — otherwise every migration must remember to `GRANT`, and one day one won't.
- Humans get personal, named roles with the least privilege their job needs. **Never** share service credentials with people; never let people write through the app's login.

---

## 21. Database logic: triggers, views, procedures

- **Triggers** are limited to mechanical bookkeeping: `updated_at` (§3), audit-copy rows, search-vector maintenance. **Never** business rules in triggers — they are invisible to anyone reading service code, and multi-trigger firing order turns writes into puzzles.
- **Views** serve two purposes: PII-restricted projections (§20) and reporting convenience. Materialized views may back heavy aggregates, with a documented refresh cadence and an owner.
- **Stored procedures** are documented exceptions for set-based operations where round-trips dominate. The default: logic lives in services.

---

## 22. Migrations and zero-downtime change

A schema standard without lock-safety rules is how outages ship. Every change:

- **Must** be a versioned, forward-only migration in version control, applied by one tool (Prisma Migrate, Flyway, Liquibase — pick one). No manual production DDL, ever. Prefer roll-forward fixes to down migrations.
- **Must** set timeouts at the top of every migration:

```sql
SET lock_timeout = '5s';
SET statement_timeout = '10min';
```

  A migration queued behind one long-running transaction blocks *all* traffic behind itself. Fail fast, retry off-peak.
- **Must** create indexes on non-trivial tables with `CREATE INDEX CONCURRENTLY` (run outside a transaction block).
- **Must** add FKs and CHECKs to large tables in two steps:

```sql
ALTER TABLE invoice
  ADD CONSTRAINT fk_invoice_customer
  FOREIGN KEY (customer_id) REFERENCES customer (id) NOT VALID;

-- later, or immediately after: scans without blocking writes
ALTER TABLE invoice VALIDATE CONSTRAINT fk_invoice_customer;
```

- Setting `NOT NULL` on an existing column follows the same shape: add `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` (PostgreSQL 12+ uses the validated check to skip the table scan) → drop the now-redundant check.
- **Must** use **expand → migrate → contract** for renames and type changes — never one release:
  1. **Expand:** add the new column/table; deploy code that writes both, reads old.
  2. **Migrate:** backfill in bounded batches (e.g., 5–10k rows per loop, by id range, throttled). Never one giant `UPDATE` — it locks, bloats, and replicates as a single write storm.
  3. **Contract:** switch reads to new; one release later, drop the old.
- Destructive operations (`DROP TABLE`, `DROP COLUMN`) ship only after a release in which nothing reads or writes the object.
- **Should** rehearse non-trivial migrations against a production-sized copy and record duration and lock behavior before merging.

---

## 23. Seed and reference data

`status_definition` rows, `currency`, and lookup tables are **schema in disguise**: code references them by value, so they are versioned like DDL.

- **Must** ship seeds as idempotent migrations:

```sql
INSERT INTO status_definition (context, status_code, label, sequence, is_final)
VALUES
  ('INVOICE', 'DRAFT', 'Draft', 1, false),
  ('INVOICE', 'SENT',  'Sent',  2, false),
  ('INVOICE', 'PAID',  'Paid',  3, true)
ON CONFLICT (context, status_code) DO UPDATE
SET label    = EXCLUDED.label,
    sequence = EXCLUDED.sequence,
    is_final = EXCLUDED.is_final;
```

- **Never** hand-`INSERT` lookup rows per environment. Environments drift; tests pass where production fails on a missing FK target.
- Application constants (`'DRAFT'`) and seed values are the same source — generate one from the other, or keep both in one reviewed module.

---

## 24. In-schema documentation

- **Must** attach `COMMENT ON` to everything a future reviewer would otherwise "fix": snapshot columns, denormalized rollups, jsonb shapes, sanctioned exceptions, tenant-less global tables, deliberate denormalizations.

```sql
COMMENT ON COLUMN order_item.product_name IS
  'Snapshot of product.name at order time — intentionally denormalized; never re-read from catalog.';

COMMENT ON COLUMN invoice.total_billed_amount IS
  'Rollup maintained by BillingService.recalculate(); do not hand-edit.';

COMMENT ON COLUMN invoice.tax_breakdown IS
  'jsonb object: { jurisdiction: { rate, amount } } — display only; never a query predicate.';
```

- The data dictionary is **generated from the catalog** (tables, columns, comments) — never a hand-maintained parallel document, which is wrong within a month.

---

## 25. Schema review checklist

Run this against every migration before it merges.

**Table level**

- [ ] Every new table has an explicit `PRIMARY KEY`
- [ ] Names: singular snake_case, no reserved words, no quoted identifiers
- [ ] Correct lifecycle flag for the table category (`is_deleted` / `is_active` / none)
- [ ] Standard audit block present, schema-wide actor type; `updated_at` trigger attached
- [ ] `tenant_id NOT NULL` on tenant-owned tables; uniques and hot indexes scoped/led by it
- [ ] `public_id` (UUIDv7) on API-exposed entities; sequential ids never exposed
- [ ] `version` column on human-edited business documents
- [ ] Polymorphic tables: `entity_type` CHECK + `(entity_type, entity_id)` index
- [ ] Snapshot columns on document line items, with lineage FKs and COMMENTs

**Column level**

- [ ] `NOT NULL` by default; every nullable column's null has documented meaning
- [ ] All timestamps `timestamptz`; calendar values `date`; no naive timestamps
- [ ] Money is `numeric` with a `currency_code` FK; rounding mode documented; percentages `numeric(5,2)`
- [ ] No numeric or date data typed as text; no repeating-group columns
- [ ] `text` for free-form content; case-insensitive uniqueness on identity text (`lower()` / citext)
- [ ] One value-set mechanism per column; no unused enum types left behind
- [ ] Domain CHECKs present (`quantity > 0`, range checks, either/or exclusivity)

**Integrity**

- [ ] Every pointer column has an FK with a deliberate `ON DELETE` policy
- [ ] Owned children (line items, attachments, junction rows) `CASCADE`; reference data `RESTRICT`
- [ ] No `NOT NULL` column with `ON DELETE SET NULL`; no sentinel defaults standing in for FKs
- [ ] Status defaults are the entry state, not a terminal one
- [ ] Unique constraints cover business expectations (codes, junction pairs, dedup keys)
- [ ] Constraint names match the columns they constrain

**Performance and operations**

- [ ] Index on every FK and every hot filter; partial indexes for `is_deleted = false`
- [ ] Composite indexes ordered equality-first, then range/sort
- [ ] Migration sets `lock_timeout`; indexes built `CONCURRENTLY`; big-table constraints `NOT VALID` → `VALIDATE`
- [ ] Backfills batched; destructive drops deferred to a later release
- [ ] Seeds idempotent (`ON CONFLICT ... DO UPDATE`)

**Security and data protection**

- [ ] PII columns classified and encrypted/vaulted; no `bytea` file storage
- [ ] Retention class assigned; no new PII copies outside the authoritative table
- [ ] Grants unchanged or deliberately updated; app role still DML-only

---

## 26. Anti-pattern gallery

The recurring bugs to hunt for in review — each of these has shipped to production somewhere:

**The undeletable parent** — A `NOT NULL` foreign key declared with `ON DELETE SET NULL`. Every attempt to delete the parent fails with a constraint violation. Fix: make the column nullable, or switch to CASCADE/RESTRICT. (§13)

**The lying constraint name** — A constraint named `..._partner_id_fkey` that actually constrains `branch_id` — the fingerprint of copy-paste DDL. The schema still works, but every developer who trusts the name debugs the wrong thing. (§1)

**Born already read** — A status column whose DEFAULT is a terminal or consumed state — notifications defaulting to `'READ'`, tasks defaulting to `'DONE'`. Works only as long as every code path remembers to override it. (§10)

**The keyless log table** — Log, filter, or analysis tables shipped with a serial id but no `PRIMARY KEY` declared, and no unique constraint on their natural dedup key. Duplicates accumulate; replication and ORMs misbehave. (§2)

**Two sources of truth** — An enum type defined in the schema while the column it was made for is text with a duplicate CHECK list. The two drift apart with the first careless migration. (§9)

**The zombie column** — A rename or refactor that leaves the old column (`description` and `entity_description` on one table) or the old constraint name behind. Half the codebase writes one, half reads the other. (§1, §22)

**The naive timestamp** — `timestamp without time zone` across the schema. Invisible while everyone shares one timezone; ambiguous forever once a second region, a DST change, or a server move happens. (§5)

**App-side integrity** — Owner/actor columns (`lead_owner_id`, `manager_id`, `interviewer_id`) with obvious targets but no FK, "validated in the application." Every one of them eventually points at a deleted row. (§13)

**The enumerable API** — Sequential ids in URLs (`/invoices/1041`). Competitors read your volume; attackers iterate ids until authorization slips once. Fix: `public_id` UUIDv7 at the boundary. (§2.1)

**The case-twin account** — `UNIQUE (email)` without `lower()`/citext. `Foo@x.com` and `foo@x.com` register separately, and the password reset goes to "the other" account. (§7)

**The lost update** — No `version` column on an edited document. Two people open it; the second save silently erases the first. (§15)

**The midday lock storm** — `CREATE INDEX` without `CONCURRENTLY`, or a one-statement backfill of 40M rows, run at peak. Every write queues behind it; the app times out in sympathy. (§22)

**The cross-tenant pointer** — A child FK by bare `id` in a multi-tenant schema. One service bug later, tenant A's order lists tenant B's items — and the database permitted it. Fix: composite `(tenant_id, id)` foreign keys. (§14)

**The hand-seeded lookup** — Status rows INSERTed manually per environment. Works in dev, violates an FK in prod, and the postmortem reads "data issue, not code." (§23)

**The trigger labyrinth** — Business rules hidden in BEFORE/AFTER triggers, some firing other triggers. Nobody can predict a write's side effects by reading the service code. (§21)

**The eternal varchar(255)** — Arbitrary caps copied from an old tutorial, truncating real names and URLs for zero benefit. (§7)
