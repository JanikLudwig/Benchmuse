# Benchling teardown

Reverse-engineering notes on the Benchling R&D platform (the logged-in app, not the marketing site), gathered 2026-10-17 with REA plus static analysis of publicly served assets. Purpose: inform what Benchmuse needs to build.

## TL;DR

- **The paid product's client code is public.** `benchling.com/signin` (no login) serves the full single-page app: about 51 MB of JS across 60 chunks, with publicly fetchable source maps. Paid and free tenants run the **same build**. Paid modules are switched on per tenant by about 420 server-injected `window.*` flags plus LaunchDarkly.
- **The app is a monolith SPA** (webpack namespace `aurelia`, built with Rspack). It mixes legacy Backbone/jQuery with modern React + Redux Toolkit + Apollo + Mantine, has about 9,800 first-party TS/TSX modules, and uses a custom router with 265 URL patterns.
- **Reads go through GraphQL and writes go through REST/RPC.** The internal GraphQL schema is embedded in the bundle (390 KB SDL, 739 types, 411 root query fields) and has essentially no mutations. Writes use about 670 internal `/1/api/<resource>` REST resources. There is also a public REST API (v2: 403 ops; new unified v3: 1,064 ops).
- **The data model is schema-driven.** Nearly everything (entities, containers, plates, boxes, locations, results, runs, requests, workflow tasks, studies, entries) is an instance of a tenant-defined **Schema** with typed **Field Definitions**. That abstraction is the heart of the product.
- **The backend is Python** (SQLAlchemy/Alembic migrations, Celery jobs), on AWS. Realtime runs over Ably, and the client also polls (`/1/api/_poll`).

## Method and scope

| Step | Tool | What it yielded |
|---|---|---|
| Isolated headless Chrome (throwaway profile) with CDP | — | No personal cookies or logins involved |
| `inspect_web_page`, `analyze_web_bundle` on www.benchling.com | REA | Marketing site: Next.js app router, irrelevant to the product |
| `capture_browser_scenario` on `benchling.com/signin` | REA | Network trace showing the full app bundle, LaunchDarkly context, `/1/api/*` calls |
| Download of publicly served chunks and source-map `sources` lists | curl | Module tree (file paths only; original source contents were **not** kept) |
| Static string extraction from bundles | python | Route manifest, `/1/api` paths, embedded GraphQL SDL, server flags |
| Logged-out OpenAPI specs (`/api/{v2,v2-beta,v2-alpha,v3}/openapi.yaml`) | curl | Public data model and API |

**Not done:** logging into any tenant, calling authenticated endpoints, or bypassing any gate. Everything above is served to anonymous visitors. As a result, no runtime behavior of paid modules was observed (see Gaps).

REA's bundle analyzer dropped its connection on the 51 MB app bundle, so app-level analysis was done offline on the downloaded files.

## Architecture

### Frontend
- **Bundler:** Rspack (webpack-compatible); entry chunks `app-0/1/2`, plus about 36 lazy chunks (editor, Monaco, swagger-ui, pdfkit, procedure page, tenant admin, config migration…). Most of the app, including paid modules, ships in the initial load.
- **Layers:** Legacy Backbone + jQuery/jQuery-UI + `create-react-class` + Immutable sit alongside modern React, Redux Toolkit, Apollo Client, Mantine, Emotion, and XState.
- **Notable libraries:**
  - Mol* for 3D structures (lazy, 3.7 MB)
  - Monaco and Ace for SQL/formula/code editing
  - React Flow + dagre for process, workflow, and procedure graph builders
  - d3 + visx for charts
  - `fixed-data-table-2`, react-window, and react-virtuoso for grids
  - KaTeX for math
  - swagger-ui for in-app API docs
  - Stripe for academic billing
  - pdfkit for exports
- **Notebook editor:** in-house rich-text editor (`client/notebook/mediocre`, `client/notebook/notes`), not ProseMirror or Slate. Editing uses **document locks** (`ELN_REALTIME_DOCUMENT_EDITOR_LOCK_DURATION_SECONDS=15`, released every 5 s), not CRDTs.
- **Data sync:** a custom Apollo "Syncer" layer (`client/graphql-client/sync/*`) keeps relationship caches coherent.
- **Telemetry:** Datadog RUM + logs + session replay, Sentry, Amplitude, Segment, Gainsight PX, Zendesk, LaunchDarkly.

### Backend (inferred from client)
- Python with SQLAlchemy/Alembic (`ALEMBIC_VERSION` exposed), Celery (`WORKFLOWS_ABLY_CELERY_THRESHOLD`), AWS.
- **Async jobs:** a generic `asyncTask` / `recentAsyncTasks` pattern; large table submissions are batched client-side (`ELN_TABLE_SUBMISSION_GLOBAL_BATCH_SIZES`: registration 100, results 200, plates 10…).
- **Warehouse:** a per-tenant SQL warehouse with per-user credentials (direct access, plus temporary Insights and Agent logins) feeding Insights dashboards and SQL. The client references both PostgreSQL and Snowflake, which suggests a Postgres warehouse with a Snowflake option or migration.

### Deploy and tenancy model
- One codebase, many **deploys** and **stacks**. The free tier is `deploy=academic`, `stack=free-us-east-1`, CDN `academic.bnchcdn.com`. Enterprise customers get their own subdomain (`<tenant>.benchling.com`) on a dedicated or shared deploy, optionally **Validated Cloud** (`VALIDATED_CLOUD_VERSION`, GxP) or a private deploy (`PRIVATE_DEPLOY`).
- Tenant identity is injected server-side: `TENANT_ID` (`ten_…`), `TENANT_SUBDOMAIN`, `TENANT_HAS_SAML`, and so on.
- **Licensing is by capability:** `IDENTITY_RELEASED_CAPABILITIES = NOTEBOOK, MOLBIO, REGISTRY, INVENTORY, RESULTS, REQUESTS, V2_REQUESTS, WORKFLOWS, PROCESSES, RECIPES, ASSAYS, LAB_AUTOMATION, INSIGHTS, ADVANCED_ANALYSIS, DEVELOPER_PLATFORM, BIOLOGICS`. These are provisioned per user or tenant.

## Product modules: free vs paid

These flag values are from the free academic deploy. "Off" here means the module is paid or enterprise-only, but its client code is present.

| Module | Gate (flag on free tier) | Client size (modules) | Key routes |
|---|---|---|---|
| Notebook (ELN): entries, templates, tables, reviews | on (reviews/e-sign/schemas off) | notebook 1,456 | `/f/:folder/:item/edit`, `/templates/*`, `/template-collections` |
| Molecular biology: sequence maps, alignment, CRISPR, assembly, primers, AlphaFold | on | molbio 734, assembly 49 | `crispr`, `bulk-workflows/assembly` |
| Registry: entity schemas, IDs, name templates | on | registry 114, schemas 158 | `:owner/registries/:reg/*-schemas` |
| Inventory: containers, boxes, plates, locations | `ENABLE_STORAGE=false` | samples 399, inventory 52 | `samples/{containers,boxes,plates,locations}/:id` |
| Results/Runs/Assays | `ENABLE_RUNS=false`, `ENABLE_NEW_RESULTS=false` | results 77, runs 56 | `assay-schemas/{results,runs,requests}`, `assay-runs/:id` |
| Requests (legacy + v2) | `ENABLE_REQUESTS=false`, `REQUESTS_V2_ENABLE=false` | requests 126 | `requests/:id`, `requests-v2/:id`, `request-v2-templates/*` |
| Workflows / Processes (flowcharts, task schemas, outputs) | `WORKFLOWS_ENABLE=false` | processes 613, workflows 140 | `workflows/*`, `processes/:id`, `workflow-task-schemas/*` |
| Procedures (method/step execution, run plans, parameters) | `PROCEDURES_ENABLE=false` | procedures 252 | `procedures/:id`, `procedure-runs/:id` |
| Studies (preclinical/clinical, treatment groups) | `STUDIES_ENABLE=false` | studies 298 | `studies/*`, `study-schemas/*` |
| Lab Automation and Instruments (Connect, gateways) | `ENABLE_LAB_AUTOMATION=false`, `INSTRUMENTS_ENABLE=false` | lab-automation 113, instruments 54 | `instrument-gateways`, `connections/*` |
| Worklists, Worksheets | `WORKLISTS_ENABLE_WORKLISTS=false` | worklists 53 | `worklists`, `worksheets/:id` |
| Insights / Analysis (dashboards, SQL, data frames, analysis templates) | partly off | insights 324, analysis-tool 393, data-frames 113 | `analytics/*`, `analysis-templates/:id` |
| Warehouse | `ENABLE_WAREHOUSE=false` | warehouse 9 | — |
| Benchling AI: chat, agents, skills, MCP connectors, routines | `ELN_ENABLE_AI_*=false` | llm 318 | `chats/*`, `agent-foundries/:id`, `chats/settings/{agents,skills,connectors}` |
| Model Hub (structure prediction, generative models) | partly on (AlphaFold quota 100) | model-hub 131 | `model-hub/*` |
| Developer platform: Benchling Apps, canvases, webhooks/events | `ENABLE_BENCHLING_APPS=false` | benchling-apps 111, canvas-core 31 | `developer/apps/*`, `app-catalog/*`, `event-subscriptions` |
| Biologics / antibodies, chemistry, modified bio (oligos, HELM) | mostly off | antibodies 128, chemistry 93, modbio 73 | `aa-monomers/*`, `monomers/*`, `salts`, `solvents` |
| Governance: audit, e-signatures, review processes, policies, data policies | `ENABLE_ELN_ESIGNATURE=false`, `ENABLE_POLICY_UI=false` | audit 24 | `entry-review-processes/*`, `schema-policies/*`, `access-policies` |
| Tenant admin, config migration (dev→prod config promotion) | `ENABLE_TENANT_ADMIN_CONSOLE=false`, `MIGRATION_ENABLE_CONFIG_MIGRATION=false` | tenants 26, config-migration 45 | `admin/*`, `config-migration/*`, `tools/tenant-comparison` |

The full flag list is in [data/feature-flags.tsv](data/feature-flags.tsv). Module counts per area are in [data/client-module-areas.tsv](data/client-module-areas.tsv), and all 265 URL patterns are in [data/client-url-patterns.txt](data/client-url-patterns.txt).

## Data model

### Core abstractions (GraphQL interfaces, by number of implementors)
| Interface | Implementors | Meaning |
|---|---|---|
| `HasPermissionsInterface` | 90 | Everything is permission-checked per object |
| `HasCreatorInterface` | 88 | Creator/timestamps on everything |
| `CoreObjectArchivableInterface` | 77 | Soft delete via **archive with reason** (entities: `Made in error`, `Retired`, `Expended`, `Shipped`, `Contaminated`, `Expired`, `Missing`, `Other`) |
| `SearchableInterface` | 54 | Unified search index ("Sightglass") |
| `FieldDefinitionInterface` | 38 | Typed fields: text, long text, integer, float, date, datetime, boolean, JSON, blob, dropdown, and **link** fields to ~25 object kinds (entities, entries, storables, results, runs, requests, schemas…) |
| `PoliceableInterface` | 29 | Access policies |
| `SchemaInterface` | 15 | Schemas for batch, box, container, location, plate, result, run, request, request task, process task/output, sample group, study… |
| `FolderItemInterface` / `BaseFolderItemInterface` | 13 / 11 | Projects → folders → items tree |
| `RegistryItemInterface` | 10 | Registrable entities: DNA/RNA sequence, AA sequence/protein, custom entity, mixture, molecule, oligo duplex/conjugate, complex polymer, equipment |
| `StudyableInterface`, `WorklistItemInterface`, `StarrableInterface`, `TemplateCollectibleInterface`, `PartyInterface` | — | Cross-cutting capabilities |

`PartyInterface` covers User, Team, Organization, BenchlingApp, ServiceAccount, and RoutinePrincipal (AI agents are first-class actors).

### Key relationships (from schema and public API)
- **Project → Folder → Item.** Items are entries, entities, analyses, files, datasets, and so on.
- **Registry → Entity Schema → Entity.** Registration assigns an ID through **name templates** (`client/name-templates`). Entities have versions, aliases, and parent/child links.
- **Location → Box/Plate → Container → Contents.** Contents are entity + batch + concentration. Containers keep transfer and freeze-thaw history.
- **Entry (notebook doc).** An entry has days/notes and embedded **structured tables**: registration, inventory, results, transfers, plate creation, process-task tables. Inline "chips" link to any object. Entries go through review lifecycles, snapshots, and e-signatures.
- **Result Schema → Result (row).** A result links to entities/containers. A Run groups results and comes from instruments/automation.
- **Workflow Flowchart → Task Schema → Task → Output.** Tasks have status lifecycles, routers, and task groups.
- **Procedure → Method/Step definition versions → Run plan → Execution instances → Parameters** (planned, measured, confirmed).

### ID scheme
Prefixed opaque IDs: `ent_` user, `seq_` DNA sequence, `prtn_` AA sequence, `bfi_` custom entity, `mxt_` mixture, `mol_` molecule, `etr_` entry, `lib_` folder, `src_` project, `ts_` schema, `tsf_` field definition, `con_` container, `box_`, `plt_` plate, `loc_` location, `bat_` batch, `assaysch_` assay schema, `wftask_` workflow task, `wfts_` task status, `dset_` dataset, `app_` app, `ten_` tenant. Human-facing registry IDs are separate, generated from name templates.

## API surfaces

| Surface | Use | Size |
|---|---|---|
| Internal GraphQL (`/graphql`, Apollo) | All app **reads** | 411 query fields; ~3 mutations |
| Internal REST/RPC `/1/api/<resource>[:action]` | All app **writes** and actions (e.g. `/1/api/analytics:track-single-tracked-event`) | ~670 distinct resources ([data/internal-api-resources.tsv](data/internal-api-resources.tsv)) |
| Polling `/1/api/_poll` + Ably websockets | Change notifications, app canvas/session polling every 2 s | — |
| Public REST v2 (`/api/v2`) | Customer integrations, SDK | 326 paths, 403 ops, 862 schemas |
| Public REST v3 "unified" (`/api/v3`) | Newer, schema-per-type resources | 975 paths, 1,064 ops, 1,326 schemas |
| Webhooks / event subscriptions; Benchling Apps (canvases, sessions, UI blocks) | Extensibility | — |

## Limits worth copying (or beating)
- Structured table: 500 rows interactive, 1,000 persisted. Inline table view: 500 rows.
- File upload: 128 MB (2 GB with the unlimited add-on).
- Workflows: ≤1,000 tasks per group or entry; ≤85 fields per task schema; flowchart UI renders ≤200 nodes.
- Insights: ≤12 concurrent queries per tab.
- Requests: ≤600 sample groups.
- Alignment timeout: 315 s.

## Implications for Benchmuse

1. **Build the schema engine first.** Tenant-defined schemas with typed and link fields, validation rules, computed fields, and name templates power Registry, Inventory, Results, Requests, Workflows, and Studies alike. Get this right and most modules are configuration on top.
2. **Make cross-cutting concerns uniform:** permissions/policies, archive-with-reason, audit history, search, starring, and folder placement. Benchling bolted these on as ~10 interfaces. Benchmuse can design them into a single object base.
3. **Split reads and writes** the way Benchling does (GraphQL reads, REST commands), but expose a single public API from day one. Benchling now maintains v2, v2-beta, v2-alpha, and v3 in parallel.
4. **The notebook is the hardest UI.** Benchling uses a custom editor with locks rather than real-time co-editing. A CRDT-based editor (e.g. Yjs + ProseMirror/Tiptap) with structured-table blocks would be a real differentiator.
5. **AI is now central to their positioning** ("Science Foundries", agents, skills, MCP connectors, model hub, AI credit metering). Treat agents as first-class parties with permissions from the start.
6. **Mind the legacy weight.** Backbone/jQuery coexisting with React, ~420 runtime flags, and four API versions are what a newcomer can avoid.

## Logged-in session (free academic account, 2026-10-17)

Observed passively via REA on a free academic login. I loaded pages by URL only, with no clicks or writes. I recorded structure only, not data values.

- **GraphQL transport.** `POST /graphql` with **batched arrays** of operations. Each operation carries `operationName`, `variables`, the full `query`, and `extensions.persistedQuery.queryHash` (Apollo persisted queries with fallback text).
- **One search endpoint powers every list.** The Projects page, global search, and pickers all call `POST /1/api/search`. The UI state lives in the URL as a small filter grammar:
  `filter=types:IS_ONE_OF:source,folder;hidden:not_hidden;archivePurposes:IS_ONE_OF:NOT_ARCHIVED&offset=0&limit=25&sorts=starred:0;modified_at:1&q=&v=2`
  Here `source` means project. Searchable types: `folder, sequence, rna_sequence, protein, basic_folder_item` (custom entity)`, oligo, rna_oligo, mixture, entry, protocol, request_v2_submission, request_v2_definition, sequence_analysis, protein_alignment, bulk_assembly, canvas_fldr_artifact, worklist, template, subtemplate, form_definition, plate_design_template, template_collection, pipeline_file`.
- **Item URLs** are `/{ownerHandle}/f/{folderId-slug}/{itemId-slug}/edit`, i.e. the owner handle, then the folder, then the item, each as `id-slug`. Opening a sequence calls `GET /1/api/sequences/{id}` and `GET /1/api/files/{id}/note-versions/`; sequences are versioned "files".
- **Every page** posts `/1/api/_poll` (change feed) and analytics events, and loads Gainsight in-app guides.
- **Gated modules redirect.** On free tier `/workflows` bounces to `/editor`, which reopens the last item. `/{handle}` redirects to `/{handle}/settings`.
- **The home screen is AI-first.** It shows "Start with chat" prompt chips (transcribe handwritten notes, import data from file, create and fill an entry, run statistics, chart results), then "Jump back in" (recent items), "Running now" (processes), and a calendar.
- **Left rail:** AI chat, projects, search, create (+), then tasks, notifications, and profile at the bottom.

## Gaps (need a paid tenant)
- Actual UI and UX of paid modules (screens, flows, empty states)
- Runtime request/response shapes for `/1/api/*` writes and GraphQL operations
- Server-side behavior: validation, ID generation, permissions resolution, warehouse sync
- Enterprise-only deploy differences (Validated Cloud, SSO/SCIM, private deploys)

The free academic login used here can't fill these gaps, because paid modules are switched off for it. That login can also see a real lab's shared workspace, so live probing stopped once that showed up. Further observation needs a paid sandbox tenant with no real data in it.

## Raw artifacts (local only, gitignored)
`research/benchling/raw/` holds:
- `graphql-schema.graphql`: Benchling's internal SDL
- `v2*.openapi.yaml`, `v3.openapi.yaml`: Benchling's public API specs
- `all_sources.txt`: source-map module paths
- `window_flags.json`: unredacted flags
- `rest_paths.txt`: full `/1/api` path list
- `signin.png`: sign-in screenshot

These are Benchling's material. Use them to understand the product, but design Benchmuse's own schema and code rather than copying them.
