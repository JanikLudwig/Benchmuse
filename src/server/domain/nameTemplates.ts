/**
 * Registry ID name templates, e.g. `PLS-{n:4}` -> `PLS-0001`, `ab{yy}{mm}-{n}` -> `ab2610-17`.
 *
 * Tokens:
 *   {n} / {n:W}   per-schema sequence number, optionally zero-padded to width W (1-12). Required, exactly once.
 *   {yyyy} {yy} {mm} {dd}   registration date (UTC)
 * Literal text may contain letters, digits, and `-_.` only, so IDs stay URL- and filename-safe.
 */

export type TemplatePart =
  | { kind: "literal"; text: string }
  | { kind: "number"; width: number }
  | { kind: "date"; token: "yyyy" | "yy" | "mm" | "dd" };

export type ParsedTemplate = { ok: true; parts: TemplatePart[] } | { ok: false; error: string };

const TOKEN = /\{([a-z]+)(?::(\d+))?\}/g;
const LITERAL = /^[A-Za-z0-9\-_.]*$/;

export function parseNameTemplate(template: string): ParsedTemplate {
  if (!template || template.length > 64) return { ok: false, error: "template must be 1-64 characters" };
  const parts: TemplatePart[] = [];
  let last = 0;
  let numberTokens = 0;

  for (const match of template.matchAll(TOKEN)) {
    const literal = template.slice(last, match.index);
    if (literal) {
      if (!LITERAL.test(literal)) return { ok: false, error: `invalid characters in '${literal}'` };
      parts.push({ kind: "literal", text: literal });
    }
    const [, name, widthRaw] = match;
    if (name === "n") {
      const width = widthRaw === undefined ? 0 : Number(widthRaw);
      if (width > 12) return { ok: false, error: "{n:W} width must be at most 12" };
      parts.push({ kind: "number", width });
      numberTokens++;
    } else if (name === "yyyy" || name === "yy" || name === "mm" || name === "dd") {
      if (widthRaw !== undefined) return { ok: false, error: `{${name}} does not take a width` };
      parts.push({ kind: "date", token: name });
    } else {
      return { ok: false, error: `unknown token {${name}}` };
    }
    last = match.index! + match[0].length;
  }

  const tail = template.slice(last);
  if (tail) {
    if (!LITERAL.test(tail)) return { ok: false, error: `invalid characters in '${tail}'` };
    parts.push({ kind: "literal", text: tail });
  }
  if (numberTokens !== 1) return { ok: false, error: "template must contain exactly one {n} token" };
  return { ok: true, parts };
}

export function renderNameTemplate(parts: readonly TemplatePart[], number: number, date: Date): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case "literal":
          return part.text;
        case "number":
          return String(number).padStart(part.width, "0");
        case "date": {
          const yyyy = String(date.getUTCFullYear());
          if (part.token === "yyyy") return yyyy;
          if (part.token === "yy") return yyyy.slice(-2);
          if (part.token === "mm") return String(date.getUTCMonth() + 1).padStart(2, "0");
          return String(date.getUTCDate()).padStart(2, "0");
        }
      }
    })
    .join("");
}
