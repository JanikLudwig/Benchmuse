/**
 * Formula grammar: tokenizer and parser.
 *
 * The dialect is the one scientists already know from Excel and Google Sheets — `=B2*2`,
 * `=SUM(A1:A10)`, `=IF(C2>5,"high","low")` — so nobody has to learn a new one to use a
 * notebook table.
 */

export type TokenType =
  | "number"
  | "string"
  | "ref"
  | "name"
  | "operator"
  | "comma"
  | "lparen"
  | "rparen"
  | "colon"
  | "percent"
  | "end";

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

export class FormulaSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = "FormulaSyntaxError";
  }
}

const OPERATORS = ["<>", "<=", ">=", "=", "<", ">", "+", "-", "*", "/", "^", "&"];
// A1, $A$1, AB12 — the dollar signs are accepted and ignored, since a notebook table has no
// fill-down semantics that would make them mean anything different.
const REF_PATTERN = /^\$?([A-Z]{1,3})\$?([0-9]{1,7})/;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const source = input.trim();

  while (i < source.length) {
    const ch = source[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '"') {
      let value = "";
      i++;
      while (i < source.length) {
        if (source[i] === '"') {
          // A doubled quote inside a string is a literal quote, as in Excel.
          if (source[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          break;
        }
        value += source[i];
        i++;
      }
      if (i >= source.length) throw new FormulaSyntaxError("Unclosed text value", i);
      i++;
      tokens.push({ type: "string", value, position: i });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new FormulaSyntaxError("Malformed number", i);
      tokens.push({ type: "number", value: match[0], position: i });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z$_]/.test(ch)) {
      const rest = source.slice(i).toUpperCase();
      const refMatch = REF_PATTERN.exec(rest);
      // `A1` is a reference, but `SUM(` is a function name even though it starts the same way.
      const afterRef = refMatch ? rest.slice(refMatch[0].length) : "";
      if (refMatch && !/^[A-Z0-9_]/.test(afterRef)) {
        tokens.push({ type: "ref", value: `${refMatch[1]}${refMatch[2]}`, position: i });
        i += refMatch[0].length;
        continue;
      }
      const nameMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(i));
      if (!nameMatch) throw new FormulaSyntaxError(`Unexpected character '${ch}'`, i);
      tokens.push({ type: "name", value: nameMatch[0].toUpperCase(), position: i });
      i += nameMatch[0].length;
      continue;
    }

    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator) {
      tokens.push({ type: "operator", value: operator, position: i });
      i += operator.length;
      continue;
    }

    const simple: Record<string, TokenType> = { ",": "comma", ";": "comma", "(": "lparen", ")": "rparen", ":": "colon", "%": "percent" };
    const type = simple[ch];
    if (type) {
      tokens.push({ type, value: ch, position: i });
      i++;
      continue;
    }

    throw new FormulaSyntaxError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ type: "end", value: "", position: source.length });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST

export type Node =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "ref"; column: number; row: number }
  | { kind: "range"; from: { column: number; row: number }; to: { column: number; row: number } }
  | { kind: "unary"; operator: "-" | "+"; operand: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

/** Convert spreadsheet letters to a zero-based column index: A->0, Z->25, AA->26. */
export function columnIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** The inverse: 0 -> A, 26 -> AA. */
export function columnLetters(index: number): string {
  let out = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseRef(text: string): { column: number; row: number } {
  const match = /^([A-Z]+)([0-9]+)$/.exec(text.toUpperCase());
  if (!match) throw new FormulaSyntaxError(`Not a cell reference: ${text}`, 0);
  return { column: columnIndex(match[1]!), row: Number(match[2]) - 1 };
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index]!;
  }
  private next(): Token {
    return this.tokens[this.index++]!;
  }
  private expect(type: TokenType, what: string): Token {
    const token = this.next();
    if (token.type !== type) throw new FormulaSyntaxError(`Expected ${what}`, token.position);
    return token;
  }

  parse(): Node {
    const node = this.comparison();
    if (this.peek().type !== "end") throw new FormulaSyntaxError("Unexpected text after the formula", this.peek().position);
    return node;
  }

  private comparison(): Node {
    let left = this.concat();
    while (this.peek().type === "operator" && ["=", "<>", "<", ">", "<=", ">="].includes(this.peek().value)) {
      const operator = this.next().value;
      left = { kind: "binary", operator, left, right: this.concat() };
    }
    return left;
  }

  private concat(): Node {
    let left = this.additive();
    while (this.peek().type === "operator" && this.peek().value === "&") {
      this.next();
      left = { kind: "binary", operator: "&", left, right: this.additive() };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    while (this.peek().type === "operator" && ["+", "-"].includes(this.peek().value)) {
      const operator = this.next().value;
      left = { kind: "binary", operator, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.unary();
    while (this.peek().type === "operator" && ["*", "/"].includes(this.peek().value)) {
      const operator = this.next().value;
      left = { kind: "binary", operator, left, right: this.unary() };
    }
    return left;
  }

  /**
   * Exponentiation binds tighter than a leading sign, so `-2^2` is -(2^2) = -4.
   *
   * Excel, Google Sheets and LibreOffice all give 4 here, having inherited the bug from VisiCalc.
   * Benchmuse does not copy it: a notebook records real quantities, and a formula that disagrees
   * with the arithmetic a scientist did on paper is worse than one that disagrees with Excel.
   */
  private unary(): Node {
    if (this.peek().type === "operator" && ["-", "+"].includes(this.peek().value)) {
      const operator = this.next().value as "-" | "+";
      return { kind: "unary", operator, operand: this.unary() };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.postfix();
    if (this.peek().type === "operator" && this.peek().value === "^") {
      this.next();
      // Right-associative, so 2^3^2 is 2^(3^2). The exponent goes through `unary` so that a
      // signed exponent such as 2^-3 still parses.
      return { kind: "binary", operator: "^", left: base, right: this.unary() };
    }
    return base;
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.peek().type === "percent") {
      this.next();
      node = { kind: "binary", operator: "/", left: node, right: { kind: "number", value: 100 } };
    }
    return node;
  }

  private primary(): Node {
    const token = this.next();

    if (token.type === "number") return { kind: "number", value: Number(token.value) };
    if (token.type === "string") return { kind: "string", value: token.value };

    if (token.type === "ref") {
      const from = parseRef(token.value);
      if (this.peek().type === "colon") {
        this.next();
        const end = this.expect("ref", "a cell reference after ':'");
        return { kind: "range", from, to: parseRef(end.value) };
      }
      return { kind: "ref", ...from };
    }

    if (token.type === "name") {
      if (token.value === "TRUE") return { kind: "boolean", value: true };
      if (token.value === "FALSE") return { kind: "boolean", value: false };
      if (this.peek().type !== "lparen") throw new FormulaSyntaxError(`Unknown name '${token.value}'`, token.position);
      this.next();
      const args: Node[] = [];
      if (this.peek().type !== "rparen") {
        for (;;) {
          args.push(this.comparison());
          if (this.peek().type === "comma") {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expect("rparen", "a closing bracket");
      return { kind: "call", name: token.value, args };
    }

    if (token.type === "lparen") {
      const inner = this.comparison();
      this.expect("rparen", "a closing bracket");
      return inner;
    }

    throw new FormulaSyntaxError("Expected a value", token.position);
  }
}

export function parseFormula(input: string): Node {
  const body = input.startsWith("=") ? input.slice(1) : input;
  if (!body.trim()) throw new FormulaSyntaxError("Formula is empty", 0);
  return new Parser(tokenize(body)).parse();
}

/**
 * Shift the row in every relative reference, so filling `=B2*2` down one row gives `=B3*2`.
 *
 * This walks the text rather than matching a pattern against the whole formula, because a
 * pattern would also hit things that merely look like references: the `G10` in `LOG10`, an `A1`
 * inside a quoted string, the `e5` in `1e5`. A reference is only rewritten when it stands alone
 * and its row is not locked with `$`.
 */
export function shiftFormulaRows(formula: string, rowOffset: number): string {
  if (!formula.trimStart().startsWith("=") || rowOffset === 0) return formula;

  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i]!;

    // Text is copied through untouched: "A1" in a string is a label, not a reference.
    if (ch === '"') {
      const start = i;
      i++;
      while (i < formula.length) {
        if (formula[i] === '"') {
          if (formula[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += formula.slice(start, i);
      continue;
    }

    const match = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/.exec(formula.slice(i));
    const previous = i > 0 ? formula[i - 1]! : "";
    const following = match ? formula[i + match[0].length] ?? "" : "";
    const standsAlone =
      !!match &&
      // Mid-identifier, as in the `G10` of `LOG10`.
      !/[A-Za-z0-9_$.]/.test(previous) &&
      // A trailing `(` makes it a function name; a trailing letter or digit makes it longer.
      !/[A-Za-z0-9_(]/.test(following);

    if (match && standsAlone) {
      const [whole, columnLock, letters, rowLock, digits] = match;
      const shifted = rowLock === "$" ? Number(digits) : Number(digits) + rowOffset;
      // A reference shifted off the top of the grid is left as it was rather than invented.
      if (shifted >= 1) {
        out += `${columnLock}${letters}${rowLock}${shifted}`;
        i += whole.length;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

/** Every cell a formula depends on, for dependency ordering and cycle detection. */
export function referencedCells(node: Node): { column: number; row: number }[] {
  const out: { column: number; row: number }[] = [];
  const walk = (n: Node) => {
    switch (n.kind) {
      case "ref":
        out.push({ column: n.column, row: n.row });
        break;
      case "range":
        for (let row = Math.min(n.from.row, n.to.row); row <= Math.max(n.from.row, n.to.row); row++) {
          for (let column = Math.min(n.from.column, n.to.column); column <= Math.max(n.from.column, n.to.column); column++) {
            out.push({ column, row });
          }
        }
        break;
      case "unary":
        walk(n.operand);
        break;
      case "binary":
        walk(n.left);
        walk(n.right);
        break;
      case "call":
        n.args.forEach(walk);
        break;
    }
  };
  walk(node);
  return out;
}
