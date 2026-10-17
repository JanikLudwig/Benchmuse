/**
 * The function library available in notebook tables.
 *
 * Alongside the spreadsheet functions everyone expects, there are molecular-biology functions
 * backed by the same engine the sequence tools use — so `=TM(B2)` beside a primer column gives
 * the melting temperature the primer designer would, and `=DILUTE(...)` does the C1V1 arithmetic
 * a scientist would otherwise do on paper.
 */

import { gcContent, reverseComplement, translate } from "@/bio/seq";
import { meltingTemp, PCR_CONDITIONS } from "@/bio/thermo";

export type CellValue = number | string | boolean | null | FormulaError;

export class FormulaError {
  constructor(readonly code: string, readonly detail?: string) {}
  toString(): string {
    return this.code;
  }
}

export const ERRORS = {
  div0: () => new FormulaError("#DIV/0!"),
  ref: (detail?: string) => new FormulaError("#REF!", detail),
  name: (detail?: string) => new FormulaError("#NAME?", detail),
  value: (detail?: string) => new FormulaError("#VALUE!", detail),
  num: (detail?: string) => new FormulaError("#NUM!", detail),
  cycle: () => new FormulaError("#CYCLE!", "This formula refers to itself"),
  na: () => new FormulaError("#N/A"),
};

export const isError = (value: unknown): value is FormulaError => value instanceof FormulaError;

/** Coerce to a number the way a spreadsheet does; blanks are zero, text that looks numeric works. */
export function toNumber(value: CellValue): number | FormulaError {
  if (isError(value)) return value;
  if (value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : ERRORS.num();
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim().replace(/,/g, "");
  if (trimmed === "") return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : ERRORS.value(`"${value}" is not a number`);
}

export function toText(value: CellValue): string {
  if (isError(value)) return value.code;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatNumber(value);
  return value;
}

export function toBoolean(value: CellValue): boolean | FormulaError {
  if (isError(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === null || value === "") return false;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return ERRORS.value(`"${value}" is not true or false`);
}

/** Trim floating-point noise so 0.1+0.2 shows as 0.3. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

/** A sequence argument: strip whitespace and digits, as pasted sequences often carry both. */
function toSequence(value: CellValue): string | FormulaError {
  if (isError(value)) return value;
  const text = toText(value).replace(/[\s\d]/g, "").toUpperCase();
  if (!text) return ERRORS.value("Expected a sequence");
  if (!/^[ACGTURYSWKMBDHVN]+$/.test(text)) return ERRORS.value("Not a nucleotide sequence");
  return text;
}

export interface FunctionContext {
  /** today's date, injected so results are reproducible in tests */
  now: Date;
}

type Fn = (args: CellValue[][], context: FunctionContext) => CellValue;

/**
 * Functions receive each argument as an array, because a range argument expands to many cells.
 * Scalar functions take the first value; aggregate ones flatten everything.
 */
const flatten = (args: CellValue[][]): CellValue[] => args.flat();
const first = (args: CellValue[][]): CellValue => args[0]?.[0] ?? null;

/** Numbers only, skipping blanks and text — how SUM and AVERAGE behave in a spreadsheet. */
function numbers(args: CellValue[][]): number[] | FormulaError {
  const out: number[] = [];
  for (const value of flatten(args)) {
    if (isError(value)) return value;
    if (value === null || value === "") continue;
    if (typeof value === "boolean") continue;
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function unary(fn: (n: number) => number): Fn {
  return (args) => {
    const n = toNumber(first(args));
    if (isError(n)) return n;
    const result = fn(n);
    return Number.isFinite(result) ? result : ERRORS.num();
  };
}

function aggregate(fn: (values: number[]) => number, emptyValue: CellValue = 0): Fn {
  return (args) => {
    const values = numbers(args);
    if (isError(values)) return values;
    if (!values.length) return emptyValue;
    const result = fn(values);
    return Number.isFinite(result) ? result : ERRORS.num();
  };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function sampleStdev(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function toDate(value: CellValue): Date | FormulaError {
  if (isError(value)) return value;
  const text = toText(value).trim();
  if (!ISO_DATE.test(text)) return ERRORS.value("Expected a date like 2026-10-17");
  const parsed = new Date(text.length <= 10 ? `${text}T00:00:00Z` : text);
  return Number.isNaN(parsed.getTime()) ? ERRORS.value("Not a valid date") : parsed;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export const FUNCTIONS: Record<string, Fn> = {
  // --- Maths
  SUM: aggregate((v) => v.reduce((a, b) => a + b, 0)),
  PRODUCT: aggregate((v) => v.reduce((a, b) => a * b, 1)),
  ABS: unary(Math.abs),
  SQRT: unary(Math.sqrt),
  EXP: unary(Math.exp),
  LN: unary(Math.log),
  LOG10: unary(Math.log10),
  SIGN: unary(Math.sign),
  INT: unary(Math.floor),
  LOG: (args) => {
    const value = toNumber(first(args));
    const base = args.length > 1 ? toNumber(args[1]![0] ?? null) : 10;
    if (isError(value)) return value;
    if (isError(base)) return base;
    const result = Math.log(value) / Math.log(base);
    return Number.isFinite(result) ? result : ERRORS.num();
  },
  POWER: (args) => {
    const base = toNumber(first(args));
    const exponent = toNumber(args[1]?.[0] ?? null);
    if (isError(base)) return base;
    if (isError(exponent)) return exponent;
    const result = base ** exponent;
    return Number.isFinite(result) ? result : ERRORS.num();
  },
  ROUND: (args) => {
    const value = toNumber(first(args));
    const digits = args.length > 1 ? toNumber(args[1]![0] ?? null) : 0;
    if (isError(value)) return value;
    if (isError(digits)) return digits;
    const factor = 10 ** Math.trunc(digits);
    return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
  },
  ROUNDUP: (args) => {
    const value = toNumber(first(args));
    const digits = args.length > 1 ? toNumber(args[1]![0] ?? null) : 0;
    if (isError(value)) return value;
    if (isError(digits)) return digits;
    const factor = 10 ** Math.trunc(digits);
    return Math.ceil(value * factor) / factor;
  },
  ROUNDDOWN: (args) => {
    const value = toNumber(first(args));
    const digits = args.length > 1 ? toNumber(args[1]![0] ?? null) : 0;
    if (isError(value)) return value;
    if (isError(digits)) return digits;
    const factor = 10 ** Math.trunc(digits);
    return Math.trunc(value * factor) / factor;
  },

  // --- Statistics
  AVERAGE: aggregate(mean, ERRORS.div0()),
  AVG: aggregate(mean, ERRORS.div0()),
  MIN: aggregate((v) => Math.min(...v)),
  MAX: aggregate((v) => Math.max(...v)),
  MEDIAN: aggregate(median, ERRORS.num()),
  STDEV: aggregate(sampleStdev, ERRORS.div0()),
  STDEVP: aggregate((v) => {
    const m = mean(v);
    return Math.sqrt(v.reduce((acc, x) => acc + (x - m) ** 2, 0) / v.length);
  }, ERRORS.div0()),
  /** Standard error of the mean, which is what goes on an error bar. */
  SEM: aggregate((v) => sampleStdev(v) / Math.sqrt(v.length), ERRORS.div0()),
  /** Coefficient of variation as a percentage, the usual assay reproducibility check. */
  CV: aggregate((v) => (sampleStdev(v) / mean(v)) * 100, ERRORS.div0()),
  COUNT: (args) => {
    const values = numbers(args);
    return isError(values) ? values : values.length;
  },
  COUNTA: (args) => flatten(args).filter((v) => v !== null && v !== "").length,

  // --- Logic
  IF: (args) => {
    const condition = toBoolean(first(args));
    if (isError(condition)) return condition;
    const branch = condition ? args[1] : args[2];
    return branch ? (branch[0] ?? null) : condition;
  },
  IFERROR: (args) => {
    const value = first(args);
    return isError(value) ? (args[1]?.[0] ?? null) : value;
  },
  AND: (args) => {
    for (const value of flatten(args)) {
      const b = toBoolean(value);
      if (isError(b)) return b;
      if (!b) return false;
    }
    return true;
  },
  OR: (args) => {
    for (const value of flatten(args)) {
      const b = toBoolean(value);
      if (isError(b)) return b;
      if (b) return true;
    }
    return false;
  },
  NOT: (args) => {
    const b = toBoolean(first(args));
    return isError(b) ? b : !b;
  },

  // --- Text
  CONCAT: (args) => flatten(args).map(toText).join(""),
  CONCATENATE: (args) => flatten(args).map(toText).join(""),
  LEN: (args) => toText(first(args)).length,
  UPPER: (args) => toText(first(args)).toUpperCase(),
  LOWER: (args) => toText(first(args)).toLowerCase(),
  TRIM: (args) => toText(first(args)).trim().replace(/\s+/g, " "),
  LEFT: (args) => {
    const count = args.length > 1 ? toNumber(args[1]![0] ?? null) : 1;
    return isError(count) ? count : toText(first(args)).slice(0, Math.max(0, count));
  },
  RIGHT: (args) => {
    const count = args.length > 1 ? toNumber(args[1]![0] ?? null) : 1;
    if (isError(count)) return count;
    const text = toText(first(args));
    return count <= 0 ? "" : text.slice(Math.max(0, text.length - count));
  },
  TEXT: (args) => toText(first(args)),
  VALUE: (args) => toNumber(first(args)),

  // --- Dates
  TODAY: (_args, context) => isoDate(context.now),
  NOW: (_args, context) => context.now.toISOString().slice(0, 16).replace("T", " "),
  DAYS: (args) => {
    const end = toDate(first(args));
    const start = toDate(args[1]?.[0] ?? null);
    if (isError(end)) return end;
    if (isError(start)) return start;
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  },
  DATEADD: (args) => {
    const date = toDate(first(args));
    const days = toNumber(args[1]?.[0] ?? null);
    if (isError(date)) return date;
    if (isError(days)) return days;
    return isoDate(new Date(date.getTime() + days * 86400000));
  },

  // --- Molecular biology
  /** Melting temperature in °C, in a standard PCR buffer. */
  TM: (args) => {
    const sequence = toSequence(first(args));
    if (isError(sequence)) return sequence;
    if (sequence.length < 2) return ERRORS.value("Sequence is too short for a Tm");
    return Number(meltingTemp(sequence, PCR_CONDITIONS).toFixed(1));
  },
  /** GC content as a percentage. */
  GC: (args) => {
    const sequence = toSequence(first(args));
    if (isError(sequence)) return sequence;
    return Number((gcContent(sequence) * 100).toFixed(1));
  },
  REVCOMP: (args) => {
    const sequence = toSequence(first(args));
    return isError(sequence) ? sequence : reverseComplement(sequence);
  },
  TRANSLATE: (args) => {
    const sequence = toSequence(first(args));
    return isError(sequence) ? sequence : translate(sequence, { toStop: true });
  },
  /** Length of a sequence, ignoring whitespace. */
  BP: (args) => {
    const sequence = toSequence(first(args));
    return isError(sequence) ? sequence : sequence.length;
  },
  /** Molecular weight of double-stranded DNA in g/mol, from its length. */
  DSMW: (args) => {
    const length = toNumber(first(args));
    if (isError(length)) return length;
    if (length <= 0) return ERRORS.num("Length must be positive");
    return Math.round(length * 617.96 + 36.04);
  },
  /** pmol of double-stranded DNA from mass in ng and length in bp. */
  NGTOPMOL: (args) => {
    const ng = toNumber(first(args));
    const bp = toNumber(args[1]?.[0] ?? null);
    if (isError(ng)) return ng;
    if (isError(bp)) return bp;
    if (bp <= 0) return ERRORS.num("Length must be positive");
    return Number(((ng * 1000) / (bp * 650)).toFixed(4));
  },
  /** The reverse: ng needed for a given pmol of a fragment. */
  PMOLTONG: (args) => {
    const pmol = toNumber(first(args));
    const bp = toNumber(args[1]?.[0] ?? null);
    if (isError(pmol)) return pmol;
    if (isError(bp)) return bp;
    return Number(((pmol * bp * 650) / 1000).toFixed(3));
  },
  /** Volume of stock needed for a dilution: C1V1 = C2V2, in whatever units you use throughout. */
  DILUTE: (args) => {
    const stock = toNumber(first(args));
    const finalConc = toNumber(args[1]?.[0] ?? null);
    const finalVolume = toNumber(args[2]?.[0] ?? null);
    if (isError(stock)) return stock;
    if (isError(finalConc)) return finalConc;
    if (isError(finalVolume)) return finalVolume;
    if (stock === 0) return ERRORS.div0();
    if (finalConc > stock) return ERRORS.num("The final concentration is higher than the stock");
    return Number(((finalConc * finalVolume) / stock).toFixed(4));
  },
  /** Moles from a mass and molecular weight; units follow the inputs. */
  MOLES: (args) => {
    const mass = toNumber(first(args));
    const mw = toNumber(args[1]?.[0] ?? null);
    if (isError(mass)) return mass;
    if (isError(mw)) return mw;
    if (mw === 0) return ERRORS.div0();
    return Number((mass / mw).toFixed(6));
  },
  /** Molarity from mass (ng), molecular weight (g/mol) and volume (µL), returned in µM. */
  MOLARITY: (args) => {
    const ng = toNumber(first(args));
    const mw = toNumber(args[1]?.[0] ?? null);
    const volumeUl = toNumber(args[2]?.[0] ?? null);
    if (isError(ng)) return ng;
    if (isError(mw)) return mw;
    if (isError(volumeUl)) return volumeUl;
    if (mw === 0 || volumeUl === 0) return ERRORS.div0();
    // ng/µL ÷ (g/mol) = nmol/mL = µmol/L = µM.
    return Number((ng / volumeUl / mw * 1000).toFixed(4));
  },
  /** Fold change, guarding against a zero baseline. */
  FOLD: (args) => {
    const value = toNumber(first(args));
    const baseline = toNumber(args[1]?.[0] ?? null);
    if (isError(value)) return value;
    if (isError(baseline)) return baseline;
    if (baseline === 0) return ERRORS.div0();
    return Number((value / baseline).toFixed(4));
  },
};

export interface FunctionDoc {
  name: string;
  signature: string;
  summary: string;
  group: "Maths" | "Statistics" | "Logic" | "Text" | "Dates" | "Molecular biology";
}

/** Shown in the formula helper, so the available functions are discoverable in the editor. */
export const FUNCTION_DOCS: FunctionDoc[] = [
  { name: "SUM", signature: "SUM(range)", summary: "Add up numbers", group: "Maths" },
  { name: "PRODUCT", signature: "PRODUCT(range)", summary: "Multiply numbers together", group: "Maths" },
  { name: "ROUND", signature: "ROUND(value, digits)", summary: "Round to a number of decimals", group: "Maths" },
  { name: "POWER", signature: "POWER(base, exponent)", summary: "Raise to a power", group: "Maths" },
  { name: "SQRT", signature: "SQRT(value)", summary: "Square root", group: "Maths" },
  { name: "LOG10", signature: "LOG10(value)", summary: "Base-10 logarithm", group: "Maths" },
  { name: "AVERAGE", signature: "AVERAGE(range)", summary: "Mean of the numbers", group: "Statistics" },
  { name: "MEDIAN", signature: "MEDIAN(range)", summary: "Middle value", group: "Statistics" },
  { name: "STDEV", signature: "STDEV(range)", summary: "Sample standard deviation", group: "Statistics" },
  { name: "SEM", signature: "SEM(range)", summary: "Standard error of the mean", group: "Statistics" },
  { name: "CV", signature: "CV(range)", summary: "Coefficient of variation, as a percentage", group: "Statistics" },
  { name: "COUNT", signature: "COUNT(range)", summary: "How many numbers", group: "Statistics" },
  { name: "MIN", signature: "MIN(range)", summary: "Smallest value", group: "Statistics" },
  { name: "MAX", signature: "MAX(range)", summary: "Largest value", group: "Statistics" },
  { name: "IF", signature: "IF(test, then, else)", summary: "Choose between two values", group: "Logic" },
  { name: "IFERROR", signature: "IFERROR(value, fallback)", summary: "Use a fallback when a formula fails", group: "Logic" },
  { name: "AND", signature: "AND(a, b, …)", summary: "True when everything is true", group: "Logic" },
  { name: "OR", signature: "OR(a, b, …)", summary: "True when anything is true", group: "Logic" },
  { name: "CONCAT", signature: "CONCAT(a, b, …)", summary: "Join text together", group: "Text" },
  { name: "LEN", signature: "LEN(text)", summary: "Number of characters", group: "Text" },
  { name: "UPPER", signature: "UPPER(text)", summary: "Convert to upper case", group: "Text" },
  { name: "TODAY", signature: "TODAY()", summary: "Today's date", group: "Dates" },
  { name: "NOW", signature: "NOW()", summary: "The current date and time", group: "Dates" },
  { name: "DAYS", signature: "DAYS(end, start)", summary: "Days between two dates", group: "Dates" },
  { name: "DATEADD", signature: "DATEADD(date, days)", summary: "Shift a date by days", group: "Dates" },
  { name: "TM", signature: "TM(sequence)", summary: "Melting temperature in °C, in PCR buffer", group: "Molecular biology" },
  { name: "GC", signature: "GC(sequence)", summary: "GC content as a percentage", group: "Molecular biology" },
  { name: "BP", signature: "BP(sequence)", summary: "Length of a sequence", group: "Molecular biology" },
  { name: "REVCOMP", signature: "REVCOMP(sequence)", summary: "Reverse complement", group: "Molecular biology" },
  { name: "TRANSLATE", signature: "TRANSLATE(sequence)", summary: "Translate to protein, to the first stop", group: "Molecular biology" },
  { name: "DILUTE", signature: "DILUTE(stock, final, volume)", summary: "Stock volume needed (C1V1 = C2V2)", group: "Molecular biology" },
  { name: "MOLARITY", signature: "MOLARITY(ng, mw, µL)", summary: "Concentration in µM", group: "Molecular biology" },
  { name: "NGTOPMOL", signature: "NGTOPMOL(ng, bp)", summary: "pmol of a dsDNA fragment", group: "Molecular biology" },
  { name: "PMOLTONG", signature: "PMOLTONG(pmol, bp)", summary: "ng needed for a given pmol", group: "Molecular biology" },
  { name: "DSMW", signature: "DSMW(bp)", summary: "Molecular weight of dsDNA", group: "Molecular biology" },
  { name: "MOLES", signature: "MOLES(mass, mw)", summary: "Moles from mass and molecular weight", group: "Molecular biology" },
  { name: "FOLD", signature: "FOLD(value, baseline)", summary: "Fold change over a baseline", group: "Molecular biology" },
];
