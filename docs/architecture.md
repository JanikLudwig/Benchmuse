# Benchmuse architecture

Benchmuse is an R&D data platform: notebook, registry, inventory, and results, all on one schema-driven object model. Design choices below trace back to the [Benchling teardown](benchling/README.md): keep what makes Benchling work, and avoid the legacy weight.

## Principles

1. **Schema engine first.** Admins define schemas (entity, container, result, entry…) with typed fields. Every module is configuration on top of one engine (teardown: ~15 `SchemaInterface` implementors, 38 field-definition types).
2. **One object base.** Every first-class object has the same columns and behaviors: prefixed ID, creator, timestamps, archive-with-reason, audit trail, search, folder placement. Benchling bolted these on as ~10 interfaces; Benchmuse designs them in.
3. **One API.** A single versioned REST API that the UI itself uses. Benchling runs internal GraphQL + internal REST + public v2 + v3; Benchmuse ships one.
4. **One list/search grammar.** Every list view is the search endpoint plus a filter expression serialized in the URL (Benchling's best idea, made explicit and documented).
5. **Boring, portable infra.** Postgres only (PGlite in dev and tests, real Postgres in prod). No Redis or queues until there's a need.

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript 5.9 |
| DB | Postgres via Drizzle ORM. Dev and tests use PGlite (in-process WASM Postgres); prod uses `DATABASE_URL` with `pg` |
| Validation | Zod 4. Field schemas are compiled at runtime from schema definitions |
| UI | Tailwind 4. Notebook editor on Tiptap (ProseMirror) |
| Tests | Vitest against a fresh PGlite instance per test file |

## Code layout

```
src/
  server/
    db/          drizzle schema, client (pglite | pg), migrations
    domain/      pure business logic: ids, fields engine, name templates, filter grammar
    services/    use-cases (create entity, register, move, archive…); take a db handle, enforce rules, write audit events
    api/         request parsing and error mapping shared by route handlers
  app/
    api/v1/...   REST route handlers (thin: parse, then service, then JSON)
    (app)/...    UI pages
  components/    UI components
  lib/
    formula/     the spreadsheet language, shared by the browser and the server
```

## Core model (v1)

- **Project → Folder (tree) → items.** Items are entities, entries, and so on; each has a `folderId`.
- **Schema** (`sch_`) with `kind` ∈ `entity | entry | result | container | box | plate | location`. A schema has ordered **fields** (`fld_`). An entity schema has an optional **registry prefix** and **name template** (e.g. `PLS-{number:4}`).
- **Field types:** `text, long_text, integer, float, boolean, date, datetime, dropdown, json, entity_link`, each optionally `multi` and `required`. Link fields target a schema or a kind.
- **Entity** (`ent_`) has `entityType` ∈ `custom | dna_sequence | aa_sequence`. Sequence types carry `bases`/`aminoAcids` and `annotations`. Registration assigns an immutable `registryId` from the schema's name template.
- **Entry** (`etr_`): a notebook document (Tiptap JSON). Rich content embeds entity mentions, **structured result tables** bound to result schemas, **spreadsheets** (`tbl_`), images and file attachments.
- **Notebook table** (`tbl_`): a spreadsheet belonging to an entry. Stores `columns` (name, type, unit, decimals) and `rows` of raw cell text. Formulas are evaluated on read, never stored computed.
- **Result** (`res_`): a row of a result schema, linked to an entry and to entities.
- **Inventory:** Location (`loc_`, nestable) → Box/Plate (`box_`/`plt_`, grid) → Container (`con_`) → contents (entity + quantity).
- **Audit event** for every mutation: object ID, actor, action, field-level diff.
- **Archive:** `archivedAt` + `archiveReason` ∈ `made_in_error | retired | expended | shipped | contaminated | expired | missing | other`.

Single-tenant per deployment (like Benchling). Auth starts as a dev-mode user behind an `actor` abstraction, so real auth and permissions slot in without touching services.

## Documents and their payloads

An entry's document holds *references*, not payloads. A spreadsheet is
`{ type: "dataTable", attrs: { tableId } }`; an image is `{ type: "labImage", attrs: { fileId } }`.
Three things follow from that:

- A 20 MB gel photo never travels with the entry's JSON on every autosave.
- The same file can be referenced twice without being stored twice (blobs are content-addressed
  by SHA-256).
- A table's cells stay queryable and exportable outside the notebook.

Deleting a block only removes the reference. Orphaned tables are pruned on save, but only after a
24-hour grace period, because autosave runs while someone is still editing and an eager prune
would make `Ctrl+Z` bring the block back empty.

Uploaded bytes are served from one authenticated endpoint. Only a raster allowlist
(`png/jpeg/gif/webp/avif`) is served `inline`; everything else, SVG included, is forced to
`attachment` with `application/octet-stream` and `nosniff`, so an uploaded file can never execute
script in our origin.

## The formula engine

`src/lib/formula/` is a self-contained Excel-dialect spreadsheet language with no database or UI
dependencies, so the browser evaluates a grid exactly as the server does and the two never
disagree.

- **ast.ts** — tokenizer and recursive-descent parser. Precedence is the arithmetic one, which
  means one deliberate departure from spreadsheets: `=-2^2` is **-4** here, where Excel, Sheets
  and LibreOffice all answer 4 (a VisiCalc inheritance). A notebook records real quantities and
  has to agree with what was worked out on paper, so the maths wins over bug-compatibility.
  Also holds the fill-down rewrite, which shifts rows in references while leaving `$`-locked
  rows, quoted text, and lookalikes such as the `G10` in `LOG10` untouched.
- **functions.ts** — ~60 functions. The molecular-biology group calls straight into
  `src/bio`, so `TM()` in a cell is the same nearest-neighbour calculation the primer designer
  uses.
- **evaluate.ts** — memoised evaluation over the dependency graph, with cycle detection
  (`#CYCLE!`) and column-type-aware parsing of literals.

Errors are values, not exceptions: a cell holds `#DIV/0!` or `#NAME?` and the rest of the sheet
keeps computing, which is what a spreadsheet user expects.

## The sequence engine

`src/bio` is deliberately separate from everything else: no database, API or React imports. That
keeps every algorithm unit-testable against known biology and lets the same code run on the
client when a tool needs to be interactive. See [bio-engine.md](bio-engine.md).

Services load an entity, hand its sequence to the engine, and shape the result for the UI. The
engine never reads or writes; the services never do biology.

## Authentication and authorisation

Sessions and API keys are described in the [README](../README.md#authentication). Two decisions
worth recording:

- **Closed by default.** `route()` authenticates before the handler runs, so a new endpoint is
  protected unless it explicitly opts out with `publicRoute`. The alternative — each handler
  remembering to check — fails quietly the first time someone forgets.
- **`proxy.ts` is a convenience, not a boundary.** It redirects visitors without a session
  cookie, but the cookie's presence says nothing about validity, so every route and server
  component still resolves the session itself.

## Roadmap

Done: the object base and schema engine, projects and folders, registry, notebook, search,
archive and audit; the sequence engine and its tools; import/export; cloning simulation with
lineage; sequencing alignment with variant effects; authentication with roles and API keys.

Next, in order:

1. **Inventory** — locations, boxes and plates with a grid view, containers, transfers.
2. **Per-project permissions** — roles are instance-wide today; projects need their own access
   lists before several groups share one instance.
3. **Cloning UI** — the simulation API is complete and tested; the wizard is not built.
4. **Review and sign-off** — entry review lifecycles and e-signatures for regulated work.
5. **Real-time co-editing** of notebook entries (CRDT), replacing last-write-wins.
