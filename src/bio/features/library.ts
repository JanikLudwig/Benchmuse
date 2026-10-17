/**
 * A library of common DNA parts, used to auto-annotate imported sequences and to build
 * realistic demo constructs.
 *
 * Every entry is a canonical published sequence. Matching is exact on either strand, so a part
 * is only ever annotated where it genuinely occurs.
 */

export type PartCategory =
  | "promoter"
  | "terminator"
  | "RBS"
  | "operator"
  | "tag"
  | "protease_site"
  | "localization"
  | "recombination"
  | "primer_bind"
  | "origin"
  | "selection"
  | "CDS";

export interface Part {
  name: string;
  /** GenBank feature key to emit */
  type: string;
  category: PartCategory;
  sequence: string;
  color: string;
  description?: string;
  /** for tags and CDS parts, the peptide they encode */
  peptide?: string;
}

const COLORS: Record<PartCategory, string> = {
  promoter: "#10b981",
  terminator: "#ef4444",
  RBS: "#f59e0b",
  operator: "#8b5cf6",
  tag: "#ec4899",
  protease_site: "#f97316",
  localization: "#14b8a6",
  recombination: "#a855f7",
  primer_bind: "#0ea5e9",
  origin: "#f59e0b",
  selection: "#dc2626",
  CDS: "#6366f1",
};

function part(name: string, type: string, category: PartCategory, sequence: string, extra: Partial<Part> = {}): Part {
  return { name, type, category, sequence: sequence.toUpperCase().replace(/\s/g, ""), color: COLORS[category], ...extra };
}

export const PARTS: readonly Part[] = [
  // Promoters
  part("T7 promoter", "promoter", "promoter", "TAATACGACTCACTATAG", { description: "T7 RNA polymerase promoter" }),
  part("T3 promoter", "promoter", "promoter", "AATTAACCCTCACTAAAGG", { description: "T3 RNA polymerase promoter" }),
  part("SP6 promoter", "promoter", "promoter", "ATTTAGGTGACACTATAG", { description: "SP6 RNA polymerase promoter" }),
  part("lac promoter", "promoter", "promoter", "TTTACACTTTATGCTTCCGGCTCGTATGTTG", { description: "E. coli lac promoter" }),
  part("tac promoter", "promoter", "promoter", "TTGACAATTAATCATCGGCTCGTATAATGTGTGGA", { description: "hybrid trp/lac promoter" }),

  // Terminators
  part("T7 terminator", "terminator", "terminator", "CTAGCATAACCCCTTGGGGCCTCTAAACGGGTCTTGAGGGGTTTTTTG"),
  part("rrnB T1 terminator", "terminator", "terminator", "CAGGCATCAAATAAAACGAAAGGCTCAGTCGAAAGACTGGGCCTTTCGTTTTATC"),

  // Ribosome binding sites and operators
  part("RBS", "RBS", "RBS", "AGGAGG", { description: "Shine-Dalgarno sequence" }),
  part("strong RBS", "RBS", "RBS", "AAAGAGGAGAAA", { description: "BBa_B0034 ribosome binding site" }),
  part("lac operator", "protein_bind", "operator", "GGAATTGTGAGCGGATAACAATT", { description: "LacI binding site" }),
  part("CAP binding site", "protein_bind", "operator", "AATGTGAGTTAGCTCACTCATTA"),

  // Affinity and epitope tags
  part("6xHis", "CDS", "tag", "CACCACCACCACCACCAC", { peptide: "HHHHHH", description: "hexahistidine purification tag" }),
  part("6xHis (CAT)", "CDS", "tag", "CATCACCATCACCATCAC", { peptide: "HHHHHH" }),
  part("FLAG", "CDS", "tag", "GACTACAAAGACGATGACGACAAG", { peptide: "DYKDDDDK" }),
  part("HA", "CDS", "tag", "TACCCATACGATGTTCCAGATTACGCT", { peptide: "YPYDVPDYA" }),
  part("Myc", "CDS", "tag", "GAACAAAAACTCATCTCAGAAGAGGATCTG", { peptide: "EQKLISEEDL" }),
  part("Strep-tag II", "CDS", "tag", "TGGAGCCACCCGCAGTTCGAAAAA", { peptide: "WSHPQFEK" }),

  // Protease cleavage sites
  part("TEV site", "CDS", "protease_site", "GAAAACCTGTATTTTCAGGGC", { peptide: "ENLYFQG" }),
  part("thrombin site", "CDS", "protease_site", "CTGGTTCCGCGTGGATCC", { peptide: "LVPRGS" }),
  part("PreScission site", "CDS", "protease_site", "CTGGAAGTTCTGTTCCAGGGGCCC", { peptide: "LEVLFQGP" }),

  // Localization signals
  part("SV40 NLS", "CDS", "localization", "CCAAAAAAGAAGAGAAAGGTA", { peptide: "PKKKRKV" }),

  // Recombination sites
  part("loxP", "protein_bind", "recombination", "ATAACTTCGTATAATGTATGCTATACGAAGTTAT", { description: "Cre recombinase site" }),
  part("FRT", "protein_bind", "recombination", "GAAGTTCCTATTCTCTAGAAAGTATAGGAACTTC", { description: "Flp recombinase site" }),

  // Sequencing primer binding sites
  part("M13 fwd", "primer_bind", "primer_bind", "GTAAAACGACGGCCAGT", { description: "M13/pUC forward sequencing primer" }),
  part("M13 rev", "primer_bind", "primer_bind", "CAGGAAACAGCTATGAC", { description: "M13/pUC reverse sequencing primer" }),
  part("T7 primer", "primer_bind", "primer_bind", "TAATACGACTCACTATAGGG"),
  part("T7 term primer", "primer_bind", "primer_bind", "GCTAGTTATTGCTCAGCGG"),
];

const BY_NAME = new Map(PARTS.map((p) => [p.name.toLowerCase(), p]));

export function getPart(name: string): Part | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export function partsByCategory(category: PartCategory): Part[] {
  return PARTS.filter((p) => p.category === category);
}
