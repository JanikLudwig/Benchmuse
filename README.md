# Benchmuse

A molecular-biology R&D platform: a schema-driven registry, an electronic notebook, and the
sequence tools a lab actually needs — import and annotate constructs, design primers and guides,
simulate digests and assemblies, and verify finished plasmids against sequencing reads.

Design is informed by a teardown of Benchling ([docs/benchling](docs/benchling/README.md)).
Architecture is in [docs/architecture.md](docs/architecture.md), the REST API in
[docs/api.md](docs/api.md), and the sequence engine in [docs/bio-engine.md](docs/bio-engine.md).

## Quickstart

Requires Node 20.9+. No database server is needed: development uses
[PGlite](https://pglite.dev) (Postgres compiled to WASM) under `.data/`.

```bash
npm install
npm run db:seed   # demo project, then sign in as "dev" / "benchmuse-demo"
npm run dev       # http://localhost:3000
```

The first run of an empty instance asks you to create an administrator account. To use a real
Postgres instead, set `DATABASE_URL`; migrations run automatically on startup either way.

| Script | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm test` | 277 tests (Vitest; database tests run against in-memory Postgres) |
| `npm run typecheck` | TypeScript |
| `npm run db:generate` | generate a migration after editing `src/server/db/schema.ts` |
| `npm run db:seed` | load demo data (idempotent) |

## What it does

### Sequences and constructs
- **Import** GenBank, FASTA and AB1 chromatograms by drag-and-drop, or paste a sequence. Files
  are parsed and previewed before anything is written, with warnings for anything unusual.
- **Sequence workspace** with a circular plasmid map, a linear map, and a base-level view that
  share one selection. Features are drawn on stacked tracks, including joins and features that
  cross the origin.
- **Edit** sequences with features moving correctly: insertions shift them, deletions truncate
  or remove them. Rotate the origin, reverse-complement the molecule, add and edit features.
- **Auto-annotate** against a library of published parts (promoters, terminators, tags, protease
  sites, recombination sites, sequencing primer sites) and open reading frames.
- **Export** back to GenBank or FASTA, round-tripping features, joins and partial ends.

### Tools
- **Digest** with 166 restriction enzymes, including Type IIS. Shows which enzymes cut once,
  which do not cut at all, the resulting fragments with their overhangs, and a simulated agarose
  gel with standard ladders.
- **Primers**: design pairs against a selected region with Tm, GC, hairpin, self-dimer and
  cross-dimer checks; add cloning tails; simulate the PCR to confirm the product.
- **CRISPR**: find guides for SpCas9, SaCas9, Cas12a and PAM variants, scored for on-target
  activity and for specificity against off-targets, with U6 cloning oligos.
- **ORFs**, **translation**, **motif search** with IUPAC degeneracy and mismatches, and
  **properties** (length, GC, Tm, molecular weight, composition).

### Cloning
Simulate restriction cloning, Gibson assembly and Golden Gate. Each one shows the product before
anything is saved, explains clearly when fragments cannot be joined, and records the parents and
method as lineage when you accept it.

### Sequence verification
Upload Sanger reads, align them to a plasmid, and see the differences. Reads are quality-trimmed,
aligned on either strand (including across the origin), and each difference is reported with its
HGVS label, its effect on any overlapping coding sequence (synonymous, missense, nonsense,
frameshift), the reads supporting it, and the chromatogram trace behind the call.

### Electronic lab notebook
Entries are rich documents: headings, lists, @-mentions of registry entities, images, file
attachments and dates, all reachable from a `/` menu without leaving the keyboard. Screenshots
and files can also be pasted or dragged straight in.

Entries embed **spreadsheets with formulas**, which behave the way a scientist expects from
Excel: type to replace a cell, `Enter`/`Tab` to commit and move, `Ctrl+D` to fill down, drag to
select, and paste a block straight out of Excel. A formula bar shows what is really in the cell.

Alongside the usual `SUM`/`AVERAGE`/`IF`, the formula language knows molecular biology — `TM`,
`GC`, `REVCOMP`, `TRANSLATE`, `DILUTE` (C1V1), `MOLARITY`, `NGTOPMOL`, `SEM`, `CV` — because the
same sequence engine backs both. The demo entry ships with a PCR master mix whose every volume
derives from two cells: change the reaction volume or the number of reactions and the sheet
rescales, with no formula edited.

Cells store the text that was typed, never a computed snapshot, so a table always shows what its
formulas mean now. Exporting gives CSV with the values, which is what a statistician wants.

### Shared foundations
Projects and folders, tenant-defined schemas with typed fields, a registry with gap-free IDs,
structured results tables validated against a schema, search with a URL filter grammar,
archive-with-reason instead of deletion, and a field-level audit trail on everything.

## Authentication

Sessions use scrypt-hashed passwords; only SHA-256 hashes of session and API tokens are stored.
Roles are `admin`, `member` and `viewer` (read-only). Scripts and instruments authenticate with
`Authorization: Bearer bm_…` API keys, which can be given an expiry and revoked.

Every API route and server component authenticates for itself. `proxy.ts` only redirects
signed-out visitors to the sign-in page as a convenience; it is not the security boundary.

## Layout

```
src/bio/              the sequence engine: formats, enzymes, thermodynamics, primers,
                      CRISPR, assembly, alignment, variant calling. No app dependencies.
src/lib/formula/      the spreadsheet language: tokenizer, parser, evaluator, functions
src/server/domain/    IDs, the field engine, name templates, the filter grammar
src/server/services/  use-cases on a db handle: enforce rules, write audit events
src/server/db/        Drizzle schema, migrations, PGlite/pg client, seed
src/server/api/       shared route plumbing (auth, errors, request schemas)
src/app/api/v1/       REST route handlers (thin)
src/app/(app)/        signed-in pages; src/app/(auth)/ sign-in and first-run setup
src/components/       UI, including sequence/, alignment/ and notebook/ (the ELN)
docs/                 architecture, API, bio engine, Benchling teardown
```

## Not built yet

- **Inventory**: boxes, plates, locations and containers.
- **Per-project permissions**: roles are instance-wide today.
- **Cloning UI**: the simulation API is complete and tested, but the wizard is not built.
- **Review and e-signature** workflows, and real-time co-editing of notebook entries.
