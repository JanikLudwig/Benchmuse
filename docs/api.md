# Benchmuse REST API (v1)

Base path: `/api/v1`. JSON in, JSON out. The web UI uses this same API for every write.

## Authentication

Every endpoint requires a caller except `POST /auth/session` and the first-run `/auth/setup`.

- **Browser**: `POST /auth/session` with `{ handleOrEmail, password }` sets an httpOnly session
  cookie. `DELETE /auth/session` signs out; `GET /auth/session` returns the current user.
- **Scripts and instruments**: send `Authorization: Bearer bm_…` using a key from
  `POST /auth/keys`. The token is shown once at creation and only its hash is stored. Keys can
  carry an expiry and be revoked with `DELETE /auth/keys`.

Unauthenticated requests get `401 unauthenticated`. Accounts with the `viewer` role may read but
receive `403 forbidden` on any write.

## Conventions

- **IDs** are prefixed and opaque: `prj_`, `fld_`, `sch_`, `sfd_` (schema field), `drp_`/`dro_` (dropdown/option), `ent_`, `etr_`, `res_`, `ann_` (annotation), `usr_`, `aud_`. Each has a 12-character base62 body.
- **Errors** look like `{ "error": { "code", "message", "details"? } }`:

  | Status | `code` | Notes |
  |---|---|---|
  | 400 | `bad_request` | Malformed JSON or wrong body shape (`details.issues`) |
  | 404 | `not_found` | |
  | 409 | `conflict` | Duplicate name, already registered, immutable sequence… |
  | 422 | `validation_failed` | Business rule; per-field problems in `details.fieldErrors: [{ field, message }]` |
- **Field values** are keyed by the field's API name. Coercions accepted: numeric strings for integer/decimal, `"true"`/`"false"` for yes/no. Dates are `YYYY-MM-DD`. Datetimes are ISO 8601 with an offset and are normalized to UTC. Dropdowns take option IDs; entity links take entity IDs. Multi-valued fields take arrays, deduplicated. On `PATCH`, `fields` is a partial patch.
- **Sequence annotations** use 0-based, half-open ranges `[start, end)`. On circular sequences `end <= start` wraps the origin. Send an existing annotation's `id` to keep it stable.

## Endpoints

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/projects` | `?includeArchived=true` | `{ items }` |
| POST | `/projects` | `{ name, description? }` | project (root folder created automatically) |
| GET | `/projects/:id` | | project + `rootFolderId` |
| PATCH | `/projects/:id` | `{ name?, description? }` | project |
| POST | `/folders` | `{ name, projectId? \| parentFolderId? }` | folder |
| GET | `/folders/:id` | `?includeArchived=true` | `{ folder, path, folders, entities, entries }` |
| POST | `/folders/:id/move` | `{ folderId }` | folder |
| GET | `/schemas` | `?kind=entity\|result\|entry` | `{ items }` with `fields` |
| POST | `/schemas` | `{ kind, name, description?, entityType?, nameTemplate?, fields? }` | schema |
| GET / PATCH | `/schemas/:id` | `{ name?, description?, nameTemplate? }` | schema |
| POST | `/schemas/:id/fields` | `{ name, displayName, type, isRequired?, isMulti?, dropdownId?, targetSchemaId? }` | field |
| PATCH | `/schemas/:id/fields/:fieldId` | `{ displayName?, isRequired?, archived? }` | field |
| GET / POST | `/dropdowns` | `{ name, options: string[] }` | dropdown with `options` |
| POST | `/dropdowns/:id/options` | `{ name }` | option |
| GET | `/entities?ids=a,b` | up to 500 IDs | `{ items }` |
| POST | `/entities` | `{ name, folderId, schemaId? \| entityType, fields?, aliases?, sequence?, isCircular?, annotations? }` | entity |
| GET / PATCH | `/entities/:id` | `{ name?, fields?, aliases?, sequence?, isCircular?, annotations? }` | entity |
| POST | `/entities/:id/register` | | entity with `registryId` |
| POST | `/entities/:id/move` | `{ folderId }` | entity |
| POST | `/entries` | `{ name, folderId, schemaId?, fields?, content? }` | entry |
| GET / PATCH | `/entries/:id` | `{ name?, fields?, content? }` (`content` is a Tiptap/ProseMirror doc) | entry |
| GET | `/tables` | `?entryId=` | `{ items }`, each evaluated |
| POST | `/tables` | `{ entryId, name?, columns?, rows? }` | evaluated table |
| GET | `/tables/:id` | | evaluated table |
| PUT | `/tables/:id` | `{ name?, columns?, rows? }` — the whole grid | evaluated table |
| DELETE | `/tables/:id` | | `{ ok: true }` |
| GET | `/tables/:id/csv` | | CSV download, formulas replaced by values |
| GET | `/results` | `?entryId=&schemaId=` | `{ items }` in entry order |
| POST | `/results` | `{ schemaId, entryId?, rows: [fields…] }` (1–1000 rows, all-or-nothing) | `{ items }` |
| GET | `/search` | `?q=&filter=&sort=&limit=&offset=` | `{ items, total, limit, offset }` |
| POST | `/archive` | `{ ids, reason }` | `{ archived }` |
| POST | `/unarchive` | `{ ids }` | `{ unarchived }` |
| GET | `/audit/:objectId` | | `{ items }` newest first, with field-level `changes` |

## Notebook tables

A notebook table is a spreadsheet embedded in an entry. The entry's document holds only
`{ type: "dataTable", attrs: { tableId } }`; the grid itself lives in `/tables/:id`.

Cells store **the text that was typed**, never the computed result. Anything beginning with `=`
is a formula, and the server evaluates the grid on every read, so a response carries both:

```jsonc
{
  "columns": [{ "id": "…", "name": "Per reaction", "type": "number", "unit": "µL", "decimals": 2 }],
  "rows":   [["5× Q5 buffer", "5", "1", "=DILUTE(B1,C1,$B$10)"]],  // what was typed
  "values": [[{ "raw": "…", "value": 10, "isFormula": true }]]      // what it means now
}
```

Writes replace the whole grid rather than one cell, because a single spreadsheet edit — a paste,
a fill, an inserted column — moves many cells at once, and one authoritative write avoids the
ordering problems a per-cell protocol would bring.

Limits: 2,000 rows, 60 columns, 10,000 characters per cell. Column types are `text`, `number`,
`date`, `checkbox`, `select`, `entity` and `formula`; a column's type decides how its literals
are parsed, so `"5"` in a number column is the number 5.

Formulas use the Excel dialect (`=SUM(A1:A10)`, `=IF(C2>5,"high","low")`, `$` to lock a
reference) plus lab functions backed by the sequence engine — `TM`, `GC`, `REVCOMP`,
`TRANSLATE`, `DILUTE`, `MOLARITY`, `NGTOPMOL`, `SEM`, `CV`. Errors are returned as
`{ "code": "#DIV/0!", "detail": "…" }` rather than throwing; a self-referencing formula reports
`#CYCLE!` instead of hanging.

A table whose block is deleted from the document is kept for 24 hours before being removed, so
an undo of the deletion still finds its data.

## Files, import and export

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/files` | multipart with one or more `file` parts and an optional `folderId` | `{ items }` with detected format |
| GET | `/files` | `?folderId=` | `{ items }` |
| GET | `/files/:id` / `/files/:id/content` | | metadata / the raw bytes |
| GET | `/files/:id/preview` | | what the file contains, parsed but not imported |
| POST | `/import` | `{ fileId, folderId, indexes?, names?, schemaId?, autoAnnotate?, entityType? }` | `{ items }` of created entities |
| POST | `/import/paste` | `{ text, folderId, name?, schemaId?, autoAnnotate? }` | `{ items }` |
| GET | `/entities/:id/export` | `?format=genbank\|fasta` | the file, as a download |

## Sequence tools

`POST /entities/:id/tools` takes a `tool` discriminator:

| `tool` | Other fields | Returns |
|---|---|---|
| `digest` | `enzymes?`, `allEnzymes?`, `maxCuts?`, `agarose?`, `ladder?` | cut sites, per-enzyme summary, fragments, gel lanes, non-cutters |
| `design-primers` | `target`, `targetTm?`, `minLength?`, `maxLength?`, `forwardTail?`, `reverseTail?` | ranked primer pairs with Tm, GC, structures and warnings |
| `pcr` | `forward`, `reverse` | products, binding sites, annealing temperature, warnings |
| `primer-sites` | `primer` | where an oligo anneals, with its tail and stats |
| `guides` | `enzyme?`, `target?`, `limit?`, `offTargetEntityIds?` | guides with on-target and specificity scores, off-targets, cloning oligos |
| `orfs` | `minAaLength?`, `requireStart?`, `geneticCode?` | open reading frames with translations |
| `translate` | `range`, `strand?`, `geneticCode?` | protein, length, GC, Tm |
| `properties` | `range?` | length, composition, GC, Tm, molecular weight |
| `find` | `pattern`, `bothStrands?`, `maxMismatches?` | matches, IUPAC-aware |
| `auto-annotate` | `minOrfAa?` | suggested features not already present |

### Editing sequences

| Method | Path | Body | Notes |
|---|---|---|---|
| PATCH | `/entities/:id/sequence` | `{ edits: [{ start, end, insert }], reason? }` | features move with the edit; reports any removed or truncated |
| POST | `/entities/:id/sequence?action=flip` | | reverse-complement the molecule |
| POST | `/entities/:id/sequence?action=set-origin` | `{ origin }` | rotate a plasmid |
| POST | `/entities/:id/features` | `{ features: [...] }` | add features |
| PUT | `/entities/:id/features` | `{ features: [...] }` | replace the whole list |
| GET | `/entities/:id/lineage` | `?depth=` | the construct graph around this entity |

Registered entities are immutable; edits return `409 conflict`.

## Cloning

`POST /cloning` simulates a construction without writing anything:

| `method` | Fields |
|---|---|
| `restriction_ligation` | `vectorEntityId`, `insertEntityId`, `enzymes`, fragment indexes |
| `golden_gate` | `partEntityIds`, `enzyme`, `circular?` |
| `gibson` | `fragmentEntityIds`, `minOverlap?`, `circular?` |
| `pcr` | `templateEntityId`, `forward`, `reverse` |

It returns candidate products with their junctions, the order of the parts, and plain-language
errors when fragments cannot be joined. `POST /cloning/save` then creates the chosen product and
records its parents and method.

## Alignments

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/alignments` | `{ name, referenceEntityId, folderId?, reads: [{ name, fileId? \| sequence, qualities? }], settings? }` | the alignment and its placed reads |
| GET | `/alignments` | `?referenceEntityId=&folderId=` | `{ items }` with read and variant counts |
| GET | `/alignments/:id` | | reference, reads, consensus variants, coverage summary |
| POST | `/alignments/:id/recompute` | `{ trimQuality?, minVariantQuality? }` | re-place every read |
| GET | `/reads/:id/chromatogram` | | traces, peaks and qualities, when the read came from an AB1 |

Reads that cannot be placed are kept with a `failureReason` rather than dropped.

## Reference data

`GET /catalog` returns the enzyme catalogue, Cas variants, the parts library, DNA ladders and
genetic codes. Pass `?all=true` for every enzyme rather than the common set.

Archive reasons: `made_in_error`, `retired`, `expended`, `shipped`, `contaminated`, `expired`, `missing`, `other`.

## Search filter grammar

```
filter = clause (";" clause)*
clause = property ":" OPERATOR [":" value ("," value)*]
sort   = property ":" ("asc" | "desc") (";" ...)*
```

Percent-encode each value individually, so `: ; ,` inside values are safe.

| Property | Operators |
|---|---|
| `type` (`project`, `folder`, `entity`, `entry`), `entity_type`, `schema`, `project`, `folder`, `creator` | EQ, NEQ, IS_ONE_OF, IS_EMPTY, IS_NOT_EMPTY |
| `name`, `registry_id` | the above + CONTAINS |
| `created_at`, `modified_at` | GT, GTE, LT, LTE (ISO timestamps) |
| `archived`, `registered` | IS_TRUE, IS_FALSE |
| `field.<api_name>` | EQ, NEQ, IS_ONE_OF, CONTAINS, GT/GTE/LT/LTE (numeric if the value is a number, otherwise ISO-string order), IS_TRUE, IS_FALSE, IS_EMPTY, IS_NOT_EMPTY. Equality also matches inside multi-valued fields. |

Archived objects are excluded unless the filter mentions `archived`. `q` matches name, registry ID, aliases (case-insensitive substring), or an exact object ID. Sortable properties: `name`, `registry_id`, `type`, `created_at`, `modified_at` (default `modified_at:desc`).

Example: unregistered primers with Tm ≥ 58 °C in a project, newest first:

```
GET /api/v1/search?filter=project:EQ:prj_…;schema:EQ:sch_…;registered:IS_FALSE;field.tm:GTE:58&sort=modified_at:desc
```
