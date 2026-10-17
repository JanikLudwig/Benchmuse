/**
 * Evaluating a grid of cells.
 *
 * Cells hold raw text exactly as typed, as in a spreadsheet: text beginning with `=` is a
 * formula, anything else is a literal. Evaluation walks the dependency graph, so a formula that
 * refers to another formula sees its computed value, and a cycle reports `#CYCLE!` on the cells
 * involved rather than hanging.
 */

import {
  columnLetters,
  FormulaSyntaxError,
  parseFormula,
  referencedCells,
  type Node,
} from "./ast";
import {
  ERRORS,
  FUNCTIONS,
  FormulaError,
  isError,
  toBoolean,
  toNumber,
  toText,
  type CellValue,
  type FunctionContext,
} from "./functions";

export type { CellValue } from "./functions";
export { FormulaError, isError, toText, formatNumber } from "./functions";

/** The grid as stored: a sparse map from "row,column" to the text the user typed. */
export type RawGrid = (string | null | undefined)[][];

export interface EvaluatedCell {
  /** what the user typed */
  raw: string;
  /** the computed value, or the literal */
  value: CellValue;
  /** true when the raw text is a formula */
  isFormula: boolean;
}

export interface EvaluateOptions {
  now?: Date;
  /** column types, used to parse literals (a "number" column turns "5" into 5) */
  columnTypes?: (string | undefined)[];
}

const key = (row: number, column: number) => `${row},${column}`;

/** Parse a literal cell the way its column asks. */
function parseLiteral(raw: string, type: string | undefined): CellValue {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (type === "text") return raw;
  if (type === "checkbox") return /^(true|yes|y|1|x|✓)$/i.test(trimmed);
  if (type === "number") {
    const n = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(n) ? n : raw;
  }
  // Untyped columns behave like a spreadsheet: numbers and booleans are recognised.
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed.replace(/,/g, ""))) {
    return Number(trimmed.replace(/,/g, ""));
  }
  if (/^(TRUE|FALSE)$/i.test(trimmed)) return trimmed.toUpperCase() === "TRUE";
  return raw;
}

export function isFormula(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trimStart().startsWith("=");
}

/**
 * Evaluate every cell in the grid.
 *
 * Returns a parallel grid of results. Evaluation is memoised and depth-limited, so a large
 * table with deep formula chains stays linear in the number of cells.
 */
export function evaluateGrid(grid: RawGrid, opts: EvaluateOptions = {}): EvaluatedCell[][] {
  const context: FunctionContext = { now: opts.now ?? new Date() };
  const cache = new Map<string, CellValue>();
  const visiting = new Set<string>();
  const parsed = new Map<string, Node | FormulaError>();

  const rawAt = (row: number, column: number): string =>
    row >= 0 && column >= 0 && row < grid.length ? (grid[row]?.[column] ?? "") : "";

  function astFor(row: number, column: number): Node | FormulaError {
    const id = key(row, column);
    const existing = parsed.get(id);
    if (existing) return existing;
    try {
      const node = parseFormula(rawAt(row, column));
      parsed.set(id, node);
      return node;
    } catch (error) {
      const failure =
        error instanceof FormulaSyntaxError ? ERRORS.name(error.message) : ERRORS.value("Could not read this formula");
      parsed.set(id, failure);
      return failure;
    }
  }

  function valueAt(row: number, column: number): CellValue {
    const id = key(row, column);
    const cached = cache.get(id);
    if (cached !== undefined) return cached;

    const raw = rawAt(row, column);
    if (!isFormula(raw)) {
      const literal = parseLiteral(raw, opts.columnTypes?.[column]);
      cache.set(id, literal);
      return literal;
    }

    if (visiting.has(id)) {
      // Do not cache the cycle marker: the same cell may be reached legitimately elsewhere.
      return ERRORS.cycle();
    }
    visiting.add(id);
    try {
      const ast = astFor(row, column);
      const value = isError(ast) ? ast : evaluateNode(ast);
      cache.set(id, value);
      return value;
    } finally {
      visiting.delete(id);
    }
  }

  /** A node evaluated in the context of the whole grid; ranges expand to arrays. */
  function evaluateNode(node: Node): CellValue {
    const values = evaluateToList(node);
    return values[0] ?? null;
  }

  function evaluateToList(node: Node): CellValue[] {
    switch (node.kind) {
      case "number":
        return [node.value];
      case "string":
        return [node.value];
      case "boolean":
        return [node.value];
      case "ref":
        return [valueAt(node.row, node.column)];
      case "range": {
        const out: CellValue[] = [];
        const rowStart = Math.min(node.from.row, node.to.row);
        const rowEnd = Math.max(node.from.row, node.to.row);
        const colStart = Math.min(node.from.column, node.to.column);
        const colEnd = Math.max(node.from.column, node.to.column);
        if ((rowEnd - rowStart + 1) * (colEnd - colStart + 1) > 100_000) return [ERRORS.ref("Range is too large")];
        for (let row = rowStart; row <= rowEnd; row++) {
          for (let column = colStart; column <= colEnd; column++) out.push(valueAt(row, column));
        }
        return out;
      }
      case "unary": {
        const operand = toNumber(evaluateNode(node.operand));
        if (isError(operand)) return [operand];
        return [node.operator === "-" ? -operand : operand];
      }
      case "binary":
        return [evaluateBinary(node)];
      case "call": {
        const fn = FUNCTIONS[node.name];
        if (!fn) return [ERRORS.name(`There is no function called ${node.name}`)];
        const args = node.args.map(evaluateToList);
        try {
          return [fn(args, context)];
        } catch {
          return [ERRORS.value(`${node.name} could not be worked out`)];
        }
      }
    }
  }

  function evaluateBinary(node: Extract<Node, { kind: "binary" }>): CellValue {
    const left = evaluateNode(node.left);
    const right = evaluateNode(node.right);
    if (isError(left)) return left;
    if (isError(right)) return right;

    if (node.operator === "&") return toText(left) + toText(right);

    if (["=", "<>", "<", ">", "<=", ">="].includes(node.operator)) {
      return compare(node.operator, left, right);
    }

    const a = toNumber(left);
    const b = toNumber(right);
    if (isError(a)) return a;
    if (isError(b)) return b;

    switch (node.operator) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? ERRORS.div0() : a / b;
      case "^": {
        const result = a ** b;
        return Number.isFinite(result) ? result : ERRORS.num();
      }
      default:
        return ERRORS.value(`Unknown operator ${node.operator}`);
    }
  }

  function compare(operator: string, left: CellValue, right: CellValue): CellValue {
    // Compare as numbers when both sides look numeric, otherwise as text, as a spreadsheet does.
    const a = toNumber(left);
    const b = toNumber(right);
    const numeric = !isError(a) && !isError(b) && (typeof left !== "string" || left.trim() !== "" || left === "");
    const [x, y]: [number | string, number | string] = numeric && !isError(a) && !isError(b)
      ? [a, b]
      : [toText(left).toLowerCase(), toText(right).toLowerCase()];

    switch (operator) {
      case "=": return x === y;
      case "<>": return x !== y;
      case "<": return x < y;
      case ">": return x > y;
      case "<=": return x <= y;
      case ">=": return x >= y;
      default: return ERRORS.value(`Unknown comparison ${operator}`);
    }
  }

  const width = grid.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  return grid.map((row, rowIndex) =>
    Array.from({ length: width }, (_, column) => {
      const raw = row?.[column] ?? "";
      return { raw, value: valueAt(rowIndex, column), isFormula: isFormula(raw) };
    }),
  );
}

/** Evaluate one formula against a grid, for a formula bar preview. */
export function evaluateOne(formula: string, grid: RawGrid, opts: EvaluateOptions = {}): CellValue {
  const probeRow = grid.length;
  const extended = [...grid, [formula]];
  const result = evaluateGrid(extended, opts);
  return result[probeRow]?.[0]?.value ?? null;
}

/** Which cells a formula reads, as A1 labels, for highlighting while editing. */
export function formulaDependencies(formula: string): string[] {
  try {
    return referencedCells(parseFormula(formula)).map((c) => `${columnLetters(c.column)}${c.row + 1}`);
  } catch {
    return [];
  }
}

/** Human-readable explanation of a formula error, for a tooltip. */
export function describeError(error: FormulaError): string {
  switch (error.code) {
    case "#DIV/0!": return error.detail ?? "Division by zero";
    case "#REF!": return error.detail ?? "Refers to a cell that does not exist";
    case "#NAME?": return error.detail ?? "Unknown function or name";
    case "#VALUE!": return error.detail ?? "Wrong kind of value";
    case "#NUM!": return error.detail ?? "The result is not a valid number";
    case "#CYCLE!": return error.detail ?? "This formula refers to itself";
    case "#N/A": return error.detail ?? "No value available";
    default: return error.detail ?? error.code;
  }
}

export { columnLetters, columnIndex } from "./ast";
