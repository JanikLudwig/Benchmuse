/** FASTA reader and writer, including the multi-record and `;`-comment variants. */

import { guessKind } from "../alphabet";
import type { ParseResult, ParseWarning, SequenceRecord } from "./types";

export function isFasta(text: string): boolean {
  const firstMeaningful = text.split(/\r\n|\r|\n/).find((l) => l.trim() && !l.startsWith(";"));
  return !!firstMeaningful?.startsWith(">");
}

export function parseFasta(text: string, defaults: { isCircular?: boolean } = {}): ParseResult {
  const warnings: ParseWarning[] = [];
  const records: SequenceRecord[] = [];
  let current: SequenceRecord | null = null;
  let residues: string[] = [];

  const finish = () => {
    if (!current) return;
    current.residues = residues.join("").replace(/[^A-Za-z*-]/g, "");
    current.kind = guessKind(current.residues);
    if (!current.residues.length) warnings.push({ message: `Record "${current.name}" has no residues` });
    records.push(current);
    residues = [];
  };

  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    if (!line.trim() || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      finish();
      const header = line.slice(1).trim();
      const space = header.search(/\s/);
      const name = space === -1 ? header : header.slice(0, space);
      const description = space === -1 ? "" : header.slice(space + 1).trim();
      current = {
        name: name || `Sequence ${records.length + 1}`,
        ...(description && { description }),
        kind: "dna",
        // Some pipelines flag topology in the header; otherwise the caller decides.
        isCircular: defaults.isCircular ?? /\bcircular\b/i.test(description),
        residues: "",
        features: [],
        format: "fasta",
      };
      continue;
    }
    if (!current) {
      // Headerless sequence: accept it as a single unnamed record.
      current = { name: "Untitled", kind: "dna", isCircular: defaults.isCircular ?? false, residues: "", features: [], format: "fasta" };
      warnings.push({ message: "File started with sequence data and no > header", line: index + 1 });
    }
    residues.push(line.trim());
  }
  finish();
  return { records, warnings };
}

export function writeFasta(records: SequenceRecord | SequenceRecord[], lineWidth = 60): string {
  const list = Array.isArray(records) ? records : [records];
  return list
    .map((r) => {
      const header = `>${r.name}${r.description ? ` ${r.description}` : ""}`;
      const body: string[] = [];
      for (let i = 0; i < r.residues.length; i += lineWidth) body.push(r.residues.slice(i, i + lineWidth));
      return [header, ...body].join("\n");
    })
    .join("\n") + "\n";
}
