# The sequence engine

`src/bio` is a self-contained molecular-biology library. It has no dependency on the database,
the API or React, so every algorithm is testable in isolation and runs on either side of the
wire. 186 of the project's tests cover it.

## Conventions

- **Coordinates** are 0-based half-open `[start, end)` everywhere inside the engine. UI,
  GenBank and primer reports use 1-based inclusive positions; convert at the boundary with
  `toDisplay` / `fromDisplay` in `range.ts` rather than carrying two conventions around.
- **Circularity**: on a circular molecule `end <= start` means the range wraps the origin, so
  `{start: 0, end: 0}` is the whole circle. `segments()` splits a range into linear pieces.
- **Case** is preserved throughout, because lowercase often marks regions a scientist cares
  about. Comparisons are case-insensitive.
- **Degeneracy**: IUPAC codes are 4-bit masks (`alphabet.ts`), so "does this base match this
  pattern" is a bitwise AND. `matchesPattern` is directional — `A` matches `N`, `N` does not
  match `A`.

## Modules

| Module | What it does |
|---|---|
| `alphabet.ts` | IUPAC codes, complementing, degenerate matching, DNA/protein guessing |
| `range.ts` | circular-aware range arithmetic, and shifting ranges through edits |
| `seq.ts` | reverse complement, GC, translation (NCBI tables 1, 2, 11), ORFs, motif search |
| `edit.ts` | sequence edits that move features; rotate origin; reverse-complement a molecule |
| `enzymes.ts` | 166 restriction enzymes, cut-site finding, digestion, end compatibility |
| `thermo.ts` | nearest-neighbor Tm, ΔG, hairpins, self-dimers |
| `primers.ts` | primer binding with 5' tails, PCR simulation, primer pair design |
| `crispr.ts` | guide finding for five Cas variants, on-target rules, Hsu off-target scoring |
| `assembly.ts` | sticky-end ligation, Golden Gate, Gibson; feature carry-through |
| `align.ts` | affine-gap alignment (global/local/glocal), seed-and-extend for long references |
| `variants.ts` | difference calling, indel left-alignment, coding-effect prediction |
| `gel.ts` | agarose migration model, standard ladders, lane layout |
| `formats/` | GenBank, FASTA and ABIF readers and writers |
| `features/` | a library of published parts, and auto-annotation |

## Choices worth knowing

**Restriction enzymes** are written in REBASE notation (`G^AATTC`, `GGTCTC(1/5)`) and parsed at
load time, so the table stays readable. Cut positions are offsets from the start of the
recognition site; for a site found on the reverse strand the cuts mirror, which is what puts a
Type IIS enzyme's cut on the correct side.

**Overhangs** are represented by the top-strand bases spanning the single-stranded region. Two
ends are compatible when those strings are equal, which makes ligation planning a string
comparison instead of strand bookkeeping.

**Melting temperature** uses SantaLucia (1998) unified nearest-neighbor parameters with the
entropic salt correction, and converts magnesium to a monovalent equivalent
(`[Na+]eq = [Na+] + 120·√([Mg2+] − [dNTP])`, in millimolar). A standard PCR buffer comes out at
about 210 mM. M13 forward reports 51.7 °C at 0.25 µM / 50 mM Na+, matching published values.

**Primer binding** anchors on the 3' end, then extends 5'-wards allowing internal mismatches but
never ending on one — an unpaired 5' base is part of the tail, not the duplex. A primer
mismatched within the anchor is reported as not binding, which matches how such primers behave.

**Alignment** is Gotoh's three-matrix affine-gap formulation. Problems too large for a full
matrix are reduced first by k-mer seeding, so a 1 kb read places in a 50 kb reference in about
400 ms. Circular references are searched across a doubled copy so reads crossing the origin
align contiguously.

**Variant calling** left-aligns indels, the convention HGVS and variant databases use, so the
same change in a homopolymer is always reported at the same position. Coding effects are
computed from the feature's own reading direction, complementing the substituted base for
minus-strand features.

**CRISPR specificity** uses the Hsu (2013) position weights — the model behind the original MIT
specificity score. On-target scoring is a transparent set of published sequence rules (GC band,
poly-T terminator, PAM-proximal preferences), not a trained model; it ranks guides sensibly but
is not a substitute for one.

## Testing approach

Expected values come from biology that can be checked independently rather than from the
implementation: the pUC19 polylinker cutting in its known order, EcoRI and MfeI producing
compatible `AATT` ends, GTG being a start codon in the bacterial table but not the standard one,
a published GFP sequence translating back to its published protein. Several of these caught real
bugs — a Hsu score above 1, an annealed region ending on a mismatch, and a default-erasing
option spread.
