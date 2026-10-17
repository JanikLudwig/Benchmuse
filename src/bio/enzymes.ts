/**
 * Restriction enzymes and virtual digestion.
 *
 * Enzyme definitions use REBASE notation:
 *   `G^AATTC`       cut after position 1 on the top strand; the bottom cut mirrors it
 *   `CCC^GGG`       blunt
 *   `GGTCTC(1/5)`   Type IIS: cuts 1 nt past the site on top, 5 nt past on the bottom
 *   `GCAGTG(2/0)`   Type IIS leaving a 3' recess
 *
 * Cut offsets are measured in bases from the start of the recognition site: `cutTop = 1` means
 * the top strand is cut between index 0 and 1.
 */

import { reverseComplement } from "./seq";
import { findMatches } from "./seq";
import type { Range } from "./range";

export type OverhangType = "blunt" | "5" | "3";

export interface Enzyme {
  name: string;
  /** recognition site, 5'->3' on the top strand, IUPAC codes */
  site: string;
  cutTop: number;
  cutBottom: number;
  /** cuts outside its recognition site */
  isTypeIIS: boolean;
  palindromic: boolean;
  /** length of the overhang produced (0 for blunt) */
  overhangLength: number;
  overhangType: OverhangType;
  /** in the short list most labs keep on the bench */
  common: boolean;
}

/** `Name site` per line. `*` marks the common-enzyme short list. */
const TABLE = `
*AatII GACGT^C
AccI GT^MKAC
AclI AA^CGTT
AfeI AGC^GCT
*AflII C^TTAAG
AflIII A^CRYGT
*AgeI A^CCGGT
AhdI GACNNN^NNGTC
AleI CACNN^NNGTG
AluI AG^CT
AlwNI CAGNNN^CTG
*ApaI GGGCC^C
ApaLI G^TGCAC
ApoI R^AATTY
*AscI GG^CGCGCC
AseI AT^TAAT
AsiSI GCGAT^CGC
AvaI C^YCGRG
*AvrII C^CTAGG
*BamHI G^GATCC
BanI G^GYRCC
BanII GRGCY^C
BbvCI CC^TCAGC
BclI T^GATCA
BglI GCCNNNN^NGGC
*BglII A^GATCT
BlpI GC^TNAGC
BmtI GCTAG^C
BsaAI YAC^GTR
BsaBI GATNN^NNATC
BsaHI GR^CGYC
BsaJI C^CNNGG
BsaWI W^CCGGW
BseYI C^CCAGC
BsiEI CGRY^CG
BsiHKAI GWGCW^C
BsiWI C^GTACG
Bsp1286I GDGCH^C
BspDI AT^CGAT
BspEI T^CCGGA
BspHI T^CATGA
BsrGI T^GTACA
BssHII G^CGCGC
BstBI TT^CGAA
BstEII G^GTNACC
BstXI CCANNNNN^NTGG
BstZ17I GTA^TAC
Bsu36I CC^TNAGG
BtgI C^CRYGG
*ClaI AT^CGAT
DdeI C^TNAG
DpnI GA^TC
*DraI TTT^AAA
DraIII CACNNN^GTG
DrdI GACNNNN^NNGTC
EaeI Y^GGCCR
EagI C^GGCCG
EcoNI CCTNN^NNNAGG
EcoO109I RG^GNCCY
*EcoRI G^AATTC
*EcoRV GAT^ATC
FatI ^CATG
*FseI GGCCGG^CC
FspI TGC^GCA
HaeII RGCGC^Y
HaeIII GG^CC
HhaI GCG^C
HincII GTY^RAC
*HindIII A^AGCTT
HinfI G^ANTC
HpaI GTT^AAC
HpaII C^CGG
*KasI G^GCGCC
*KpnI GGTAC^C
MfeI C^AATTG
*MluI A^CGCGT
MscI TGG^CCA
MseI T^TAA
MslI CAYNN^NNRTG
MspI C^CGG
NaeI GCC^GGC
NarI GG^CGCC
NciI CC^SGG
*NcoI C^CATGG
*NdeI CA^TATG
NgoMIV G^CCGGC
*NheI G^CTAGC
*NotI GC^GGCCGC
NruI TCG^CGA
NsiI ATGCA^T
NspI RCATG^Y
*PacI TTAAT^TAA
PciI A^CATGT
PflMI CCANNNN^NTGG
*PmeI GTTT^AAAC
PmlI CAC^GTG
PpuMI RG^GWCCY
PshAI GACNN^NNGTC
PsiI TTA^TAA
PspOMI G^GGCCC
*PstI CTGCA^G
PvuI CGAT^CG
*PvuII CAG^CTG
RsaI GT^AC
*SacI GAGCT^C
*SacII CCGC^GG
*SalI G^TCGAC
SbfI CCTGCA^GG
ScaI AGT^ACT
SexAI A^CCWGGT
SfcI C^TRYAG
SfiI GGCCNNNN^NGGCC
SfoI GGC^GCC
SgrAI CR^CCGGYG
*SmaI CCC^GGG
SmlI C^TYRAG
SnaBI TAC^GTA
*SpeI A^CTAGT
*SphI GCATG^C
SrfI GCCC^GGGC
SspI AAT^ATT
*StuI AGG^CCT
StyI C^CWWGG
SwaI ATTT^AAAT
TaqI T^CGA
TfiI G^AWTC
TseI G^CWGC
Tsp509I ^AATT
TspMI C^CCGGG
Tth111I GACN^NNGTC
*XbaI T^CTAGA
XcmI CCANNNNN^NNNNTGG
*XhoI C^TCGAG
*XmaI C^CCGGG
XmnI GAANN^NNTTC
ZraI GAC^GTC
*BsaI GGTCTC(1/5)
*BsmBI CGTCTC(1/5)
Esp3I CGTCTC(1/5)
*BbsI GAAGAC(2/6)
BpiI GAAGAC(2/6)
BsmAI GTCTC(1/5)
BcoDI GTCTC(1/5)
*SapI GCTCTTC(1/4)
BspQI GCTCTTC(1/4)
EarI CTCTTC(1/4)
AarI CACCTGC(4/8)
PaqCI CACCTGC(4/8)
BspMI ACCTGC(4/8)
BfuAI ACCTGC(4/8)
BtgZI GCGATG(10/14)
MlyI GAGTC(5/5)
PleI GAGTC(4/5)
HgaI GACGC(5/10)
FokI GGATG(9/13)
BmrI ACTGGG(5/4)
BciVI GTATCC(12/10)
BpmI CTGGAG(16/14)
BpuEI CTTGAG(16/14)
BsgI GTGCAG(16/14)
EciI GGCGGA(11/9)
MmeI TCCRAC(20/18)
BtsI GCAGTG(2/0)
BsrDI GCAATG(2/0)
BsmI GAATGC(1/-1)
BmgBI CACGTC(-3/-3)
`;

function parseEnzyme(line: string): Enzyme | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const common = trimmed.startsWith("*");
  const [name, notation] = (common ? trimmed.slice(1) : trimmed).split(/\s+/);
  if (!name || !notation) return null;

  let site: string;
  let cutTop: number;
  let cutBottom: number;
  let isTypeIIS = false;

  const typeIIS = /^([A-Z]+)\((-?\d+)\/(-?\d+)\)$/.exec(notation);
  if (typeIIS) {
    site = typeIIS[1]!;
    cutTop = site.length + Number(typeIIS[2]);
    cutBottom = site.length + Number(typeIIS[3]);
    isTypeIIS = true;
  } else {
    const caret = notation.indexOf("^");
    if (caret === -1) return null;
    site = notation.replace("^", "");
    cutTop = caret;
    // For symmetric recognition sites the bottom-strand cut mirrors the top one.
    cutBottom = site.length - caret;
  }

  const palindromic = site === reverseComplement(site);
  const delta = cutBottom - cutTop;
  return {
    name,
    site,
    cutTop,
    cutBottom,
    isTypeIIS,
    palindromic,
    overhangLength: Math.abs(delta),
    overhangType: delta === 0 ? "blunt" : delta > 0 ? "5" : "3",
    common,
  };
}

export const ENZYMES: readonly Enzyme[] = TABLE.split("\n")
  .map(parseEnzyme)
  .filter((e): e is Enzyme => e !== null);

const BY_NAME = new Map(ENZYMES.map((e) => [e.name.toLowerCase(), e]));

export function getEnzyme(name: string): Enzyme | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export const COMMON_ENZYMES: readonly Enzyme[] = ENZYMES.filter((e) => e.common);

/** Enzymes that recognise the same site and cut it the same way. */
export function isoschizomers(enzyme: Enzyme): Enzyme[] {
  return ENZYMES.filter((e) => e.name !== enzyme.name && e.site === enzyme.site && e.cutTop === enzyme.cutTop && e.cutBottom === enzyme.cutBottom);
}

// ---------------------------------------------------------------------------------------------
// Digestion

export interface CutSite {
  enzyme: Enzyme;
  /** where the recognition site sits on the top strand */
  siteRange: Range;
  /** which strand the enzyme binds; Type IIS enzymes cut on one side only */
  strand: 1 | -1;
  /** index on the top strand where the top strand is cut (the cut is before this base) */
  topCut: number;
  /** index on the top strand where the bottom strand is cut */
  bottomCut: number;
  overhangType: OverhangType;
  /** top-strand bases spanning the single-stranded region ("" for blunt cuts) */
  overhang: string;
}

export interface DigestOptions {
  /** restrict to these enzymes (by name); defaults to every enzyme passed in `enzymes` */
  enzymes: readonly (Enzyme | string)[];
  /** only report enzymes that cut at most this many times */
  maxCuts?: number;
  /** only report enzymes that cut at least this many times */
  minCuts?: number;
}

/** Find every position an enzyme cuts, including sites that span the origin of a plasmid. */
export function findCutSites(seq: string, isCircular: boolean, enzymes: readonly (Enzyme | string)[]): CutSite[] {
  const L = seq.length;
  const sites: CutSite[] = [];
  const seen = new Set<string>();

  for (const entry of enzymes) {
    const enzyme = typeof entry === "string" ? getEnzyme(entry) : entry;
    if (!enzyme || !L) continue;
    // Palindromic sites are found once; asymmetric ones must be searched on both strands.
    const matches = findMatches(seq, enzyme.site, isCircular, { bothStrands: !enzyme.palindromic });
    for (const match of matches) {
      const siteStart = match.range.start;
      const len = enzyme.site.length;
      const [rawTop, rawBottom] =
        match.strand === 1
          ? [siteStart + enzyme.cutTop, siteStart + enzyme.cutBottom]
          : [siteStart + len - enzyme.cutBottom, siteStart + len - enzyme.cutTop];

      // A Type IIS site near the end of a linear molecule can cut past the end: no cut happens.
      if (!isCircular && (rawTop < 0 || rawTop > L || rawBottom < 0 || rawBottom > L)) continue;
      const topCut = isCircular ? ((rawTop % L) + L) % L : rawTop;
      const bottomCut = isCircular ? ((rawBottom % L) + L) % L : rawBottom;

      const key = `${enzyme.name}:${topCut}:${bottomCut}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const lo = Math.min(topCut, bottomCut);
      const hi = Math.max(topCut, bottomCut);
      const overhang = lo === hi ? "" : isCircular && hi - lo > L / 2
        ? seq.slice(hi) + seq.slice(0, lo) // the overhang itself wrapped the origin
        : seq.slice(lo, hi);
      sites.push({
        enzyme,
        siteRange: match.range,
        strand: match.strand,
        topCut,
        bottomCut,
        overhangType: topCut === bottomCut ? "blunt" : bottomCut > topCut ? "5" : "3",
        overhang,
      });
    }
  }
  return sites.sort((a, b) => a.topCut - b.topCut || a.enzyme.name.localeCompare(b.enzyme.name));
}

export interface DigestEnd {
  type: OverhangType;
  /** top-strand bases of the single-stranded region; "" for blunt */
  overhang: string;
  /** enzyme that produced the end, or null for the natural end of a linear molecule */
  enzyme: string | null;
}

export interface Fragment {
  /** top-strand range between consecutive top-strand cuts */
  range: Range;
  /** length in bp, measured between top-strand cuts (what a gel reports) */
  length: number;
  sequence: string;
  leftEnd: DigestEnd;
  rightEnd: DigestEnd;
  /** true when the fragment still carries the original origin (uncut circular molecule) */
  isCircular: boolean;
}

const NATURAL_END: DigestEnd = { type: "blunt", overhang: "", enzyme: null };

/**
 * Cut a sequence with a set of enzymes and return the resulting fragments.
 *
 * Fragment boundaries are the top-strand cut positions, which is the convention gels and
 * cloning tools use. Each end records the overhang so fragments can be re-ligated.
 */
export function digest(seq: string, isCircular: boolean, enzymes: readonly (Enzyme | string)[]): { sites: CutSite[]; fragments: Fragment[] } {
  const sites = findCutSites(seq, isCircular, enzymes);
  const L = seq.length;

  // Several enzymes can cut at the same position; one cut is enough to split the molecule.
  const byPosition = new Map<number, CutSite>();
  for (const site of sites) if (!byPosition.has(site.topCut)) byPosition.set(site.topCut, site);
  const cuts = [...byPosition.values()].sort((a, b) => a.topCut - b.topCut);

  if (!cuts.length) {
    return {
      sites,
      fragments: [
        {
          range: { start: 0, end: isCircular ? 0 : L },
          length: L,
          sequence: seq,
          leftEnd: NATURAL_END,
          rightEnd: NATURAL_END,
          isCircular,
        },
      ],
    };
  }

  const endFor = (site: CutSite): DigestEnd => ({ type: site.overhangType, overhang: site.overhang, enzyme: site.enzyme.name });
  const fragments: Fragment[] = [];

  if (isCircular) {
    // n cuts on a circle give n fragments, the last wrapping back to the first cut.
    for (let i = 0; i < cuts.length; i++) {
      const from = cuts[i]!;
      const to = cuts[(i + 1) % cuts.length]!;
      const start = from.topCut;
      const end = to.topCut;
      const length = end > start ? end - start : L - start + end;
      fragments.push({
        range: { start, end },
        length,
        sequence: end > start ? seq.slice(start, end) : seq.slice(start) + seq.slice(0, end),
        leftEnd: endFor(from),
        rightEnd: endFor(to),
        isCircular: false,
      });
    }
  } else {
    const boundaries = [0, ...cuts.map((c) => c.topCut), L];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]!;
      const end = boundaries[i + 1]!;
      if (end === start && i !== 0) continue;
      fragments.push({
        range: { start, end },
        length: end - start,
        sequence: seq.slice(start, end),
        leftEnd: i === 0 ? NATURAL_END : endFor(cuts[i - 1]!),
        rightEnd: i === boundaries.length - 2 ? NATURAL_END : endFor(cuts[i]!),
        isCircular: false,
      });
    }
  }
  return { sites, fragments };
}

/** Group cut sites by enzyme, for the "which enzymes cut once?" panel. */
export function summarizeDigest(sites: CutSite[]): { enzyme: Enzyme; cuts: number; positions: number[] }[] {
  const byEnzyme = new Map<string, { enzyme: Enzyme; positions: number[] }>();
  for (const site of sites) {
    const entry = byEnzyme.get(site.enzyme.name) ?? { enzyme: site.enzyme, positions: [] };
    entry.positions.push(site.topCut);
    byEnzyme.set(site.enzyme.name, entry);
  }
  return [...byEnzyme.values()]
    .map((e) => ({ enzyme: e.enzyme, cuts: e.positions.length, positions: e.positions.sort((a, b) => a - b) }))
    .sort((a, b) => a.cuts - b.cuts || a.enzyme.name.localeCompare(b.enzyme.name));
}

/** True when two digest ends can be ligated together. */
export function endsCompatible(a: DigestEnd, b: DigestEnd): boolean {
  if (a.type === "blunt" && b.type === "blunt") return true;
  return a.type === b.type && a.overhang.toUpperCase() === b.overhang.toUpperCase() && a.overhang.length > 0;
}
