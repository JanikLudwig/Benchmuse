import { describe, expect, it } from "vitest";
import { meltingTemp, PCR_CONDITIONS } from "@/bio/thermo";
import { columnIndex, columnLetters, parseFormula, shiftFormulaRows, tokenize } from "./ast";
import {
  describeError,
  evaluateGrid,
  evaluateOne,
  formulaDependencies,
  isError,
  toText,
  type CellValue,
  type RawGrid,
} from "./evaluate";
import { FUNCTION_DOCS, FUNCTIONS } from "./functions";

/** Evaluate a one-cell formula against an optional grid, returning the value. */
function run(formula: string, grid: RawGrid = [], now = new Date("2026-10-17T09:30:00Z")): CellValue {
  return evaluateOne(formula, grid, { now });
}

const display = (formula: string, grid: RawGrid = []) => toText(run(formula, grid));

describe("tokenizer and parser", () => {
  it("separates references from function names", () => {
    expect(tokenize("A1+B2").map((t) => t.type)).toEqual(["ref", "operator", "ref", "end"]);
    expect(tokenize("SUM(A1:A3)").map((t) => t.type)).toEqual(["name", "lparen", "ref", "colon", "ref", "rparen", "end"]);
    // A name that merely starts like a reference is still a name.
    expect(tokenize("A1B(2)")[0]!.type).toBe("name");
  });

  it("accepts dollar signs in references and ignores them", () => {
    expect(parseFormula("=$A$1")).toEqual({ kind: "ref", column: 0, row: 0 });
  });

  it("converts column letters both ways", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("Z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnLetters(0)).toBe("A");
    expect(columnLetters(26)).toBe("AA");
    expect(columnLetters(701)).toBe("ZZ");
  });

  it("reports where a formula is malformed", () => {
    expect(() => parseFormula("=1+")).toThrow(/Expected a value/);
    expect(() => parseFormula("=SUM(1,2")).toThrow(/closing bracket/);
    expect(() => parseFormula('="unclosed')).toThrow(/Unclosed text/);
    expect(() => parseFormula("=")).toThrow(/empty/);
  });
});

describe("arithmetic", () => {
  it("follows operator precedence", () => {
    expect(run("=1+2*3")).toBe(7);
    expect(run("=(1+2)*3")).toBe(9);
    expect(run("=2^3^2")).toBe(512); // right-associative: 2^(3^2)
    expect(run("=2^-1")).toBe(0.5);
    expect(run("=10/4")).toBe(2.5);
  });

  /**
   * Excel, Google Sheets and LibreOffice all return 4 for `=-2^2`, having inherited the
   * precedence bug from VisiCalc. Benchmuse follows the arithmetic instead, because a notebook
   * records real quantities and has to agree with what was worked out on paper.
   */
  it("binds exponentiation tighter than a leading sign, as arithmetic does", () => {
    expect(run("=-2^2")).toBe(-4);
    expect(run("=-2^3")).toBe(-8);
    expect(run("=-3^2")).toBe(-9);
    // Parentheses still say what they say.
    expect(run("=(-2)^2")).toBe(4);
    // A signed exponent still parses, and binds to the power rather than the base.
    expect(run("=2^-2")).toBe(0.25);
    expect(run("=-2^-2")).toBe(-0.25);
    // The sign distributes over a product the same way.
    expect(run("=-2^2*3")).toBe(-12);
    expect(run("=1-2^2")).toBe(-3);
  });

  it("handles percentages and negatives", () => {
    expect(run("=50%")).toBe(0.5);
    expect(run("=200*10%")).toBe(20);
    expect(run("=-5+3")).toBe(-2);
  });

  it("reports division by zero", () => {
    const value = run("=1/0");
    expect(isError(value) && value.code).toBe("#DIV/0!");
    expect(describeError(value as never)).toBe("Division by zero");
  });

  it("joins text with &", () => {
    expect(run('="a"&"b"')).toBe("ab");
    expect(run('="Total: "&(2+3)')).toBe("Total: 5");
  });

  it("compares values", () => {
    expect(run("=2>1")).toBe(true);
    expect(run("=2<>2")).toBe(false);
    expect(run('="abc"="ABC"')).toBe(true); // text comparison ignores case
    expect(run("=3>=3")).toBe(true);
  });
});

describe("cell references", () => {
  const grid: RawGrid = [
    ["2", "3", "=A1*B1"],
    ["4", "5", "=A2*B2"],
    ["=SUM(A1:A2)", "=SUM(B1:B2)", "=SUM(C1:C2)"],
  ];

  it("reads other cells and ranges", () => {
    const result = evaluateGrid(grid);
    expect(result[0]![2]!.value).toBe(6);
    expect(result[1]![2]!.value).toBe(20);
    expect(result[2]![0]!.value).toBe(6);
    expect(result[2]![2]!.value).toBe(26);
  });

  it("marks which cells hold formulas", () => {
    const result = evaluateGrid(grid);
    expect(result[0]![0]!.isFormula).toBe(false);
    expect(result[0]![2]!.isFormula).toBe(true);
    expect(result[0]![2]!.raw).toBe("=A1*B1");
  });

  it("treats blank cells as zero in arithmetic but skips them in averages", () => {
    const sparse: RawGrid = [["5"], [""], ["7"]];
    expect(evaluateOne("=SUM(A1:A3)", sparse)).toBe(12);
    expect(evaluateOne("=AVERAGE(A1:A3)", sparse)).toBe(6); // blank is not counted
    expect(evaluateOne("=COUNT(A1:A3)", sparse)).toBe(2);
    expect(evaluateOne("=A2+1", sparse)).toBe(1);
  });

  it("reads a cell outside the grid as blank", () => {
    expect(evaluateOne("=Z99+1", [["1"]])).toBe(1);
  });

  it("detects a formula that refers to itself", () => {
    const cyclic: RawGrid = [["=B1", "=A1"]];
    const result = evaluateGrid(cyclic);
    expect(isError(result[0]![0]!.value) && (result[0]![0]!.value as never as { code: string }).code).toBe("#CYCLE!");
  });

  it("detects a longer cycle without hanging", () => {
    const cyclic: RawGrid = [["=B1"], ["=C1"], ["=A1"]].map((r) => r);
    const grid3: RawGrid = [["=B1", "=C1", "=A1"]];
    const result = evaluateGrid(grid3);
    expect(result[0]!.some((cell) => isError(cell.value))).toBe(true);
    expect(cyclic.length).toBe(3);
  });

  it("lists the cells a formula depends on", () => {
    expect(formulaDependencies("=SUM(A1:A3)+B5")).toEqual(["A1", "A2", "A3", "B5"]);
    expect(formulaDependencies("=not a formula")).toEqual([]);
  });
});

describe("spreadsheet functions", () => {
  const data: RawGrid = [["10"], ["20"], ["30"], ["40"]];

  it("aggregates", () => {
    expect(evaluateOne("=SUM(A1:A4)", data)).toBe(100);
    expect(evaluateOne("=AVERAGE(A1:A4)", data)).toBe(25);
    expect(evaluateOne("=MIN(A1:A4)", data)).toBe(10);
    expect(evaluateOne("=MAX(A1:A4)", data)).toBe(40);
    expect(evaluateOne("=MEDIAN(A1:A4)", data)).toBe(25);
    expect(evaluateOne("=COUNT(A1:A4)", data)).toBe(4);
  });

  it("computes the statistics an assay needs", () => {
    // Sample standard deviation of 10,20,30,40 is 12.909944…
    expect(evaluateOne("=ROUND(STDEV(A1:A4),4)", data)).toBe(12.9099);
    expect(evaluateOne("=ROUND(SEM(A1:A4),4)", data)).toBe(6.455);
    expect(evaluateOne("=ROUND(CV(A1:A4),2)", data)).toBe(51.64);
  });

  it("rounds predictably", () => {
    expect(run("=ROUND(2.345,2)")).toBe(2.35);
    expect(run("=ROUND(2.5,0)")).toBe(3);
    expect(run("=ROUNDUP(2.01,1)")).toBe(2.1);
    expect(run("=ROUNDDOWN(2.09,1)")).toBe(2);
  });

  it("branches and recovers from errors", () => {
    expect(run('=IF(2>1,"yes","no")')).toBe("yes");
    expect(run('=IF(FALSE,"yes","no")')).toBe("no");
    expect(run('=IFERROR(1/0,"n/a")')).toBe("n/a");
    expect(run("=IFERROR(4/2,0)")).toBe(2);
    expect(run("=AND(TRUE,2>1)")).toBe(true);
    expect(run("=OR(FALSE,FALSE)")).toBe(false);
    expect(run("=NOT(TRUE)")).toBe(false);
  });

  it("works with text", () => {
    expect(run('=CONCAT("a","b","c")')).toBe("abc");
    expect(run('=LEN("hello")')).toBe(5);
    expect(run('=UPPER("abc")')).toBe("ABC");
    expect(run('=LEFT("hello",2)')).toBe("he");
    expect(run('=RIGHT("hello",2)')).toBe("lo");
    expect(run('=TRIM("  a   b  ")')).toBe("a b");
  });

  it("works with dates", () => {
    expect(run("=TODAY()")).toBe("2026-10-17");
    expect(run("=NOW()")).toBe("2026-10-17 09:30");
    expect(run('=DAYS("2026-10-17","2026-10-10")')).toBe(7);
    expect(run('=DATEADD("2026-10-17",14)')).toBe("2026-10-31");
  });

  it("reports an unknown function by name", () => {
    const value = run("=NOTAFUNCTION(1)");
    expect(isError(value) && value.code).toBe("#NAME?");
    expect(isError(value) && value.detail).toMatch(/NOTAFUNCTION/);
  });
});

describe("molecular biology functions", () => {
  const primer = "GTAAAACGACGGCCAGT";

  it("computes melting temperature using the same engine as the primer designer", () => {
    const expected = Number(meltingTemp(primer, PCR_CONDITIONS).toFixed(1));
    expect(run(`=TM("${primer}")`)).toBe(expected);
    expect(expected).toBeGreaterThan(50);
  });

  it("reads a sequence from another cell, ignoring whitespace and numbers", () => {
    const grid: RawGrid = [["gta aaacg acggcc agt"], ["=TM(A1)"], ["=GC(A1)"], ["=BP(A1)"]];
    const result = evaluateGrid(grid);
    expect(result[1]![0]!.value).toBe(run(`=TM("${primer}")`));
    expect(result[2]![0]!.value).toBe(52.9);
    expect(result[3]![0]!.value).toBe(17);
  });

  it("reverse complements and translates", () => {
    expect(run('=REVCOMP("ATGC")')).toBe("GCAT");
    expect(run('=TRANSLATE("ATGAAAGGGTAA")')).toBe("MKG");
  });

  it("does the dilution arithmetic", () => {
    // 100 µM stock, want 10 µM in 50 µL: take 5 µL.
    expect(run("=DILUTE(100,10,50)")).toBe(5);
    // Asking for more concentrated than the stock is an error, not a silly number.
    const impossible = run("=DILUTE(10,100,50)");
    expect(isError(impossible) && impossible.code).toBe("#NUM!");
    expect(isError(run("=DILUTE(0,10,50)")) && (run("=DILUTE(0,10,50)") as never as { code: string }).code).toBe("#DIV/0!");
  });

  it("converts between mass and moles of DNA", () => {
    // 1 µg of a 1 kb fragment is about 1.54 pmol.
    expect(run("=NGTOPMOL(1000,1000)")).toBeCloseTo(1.5385, 3);
    expect(run("=PMOLTONG(1.5385,1000)")).toBeCloseTo(1000, 0);
    expect(run("=DSMW(1000)")).toBe(617996);
    // 50 ng of a 100 bp oligo in 10 µL.
    expect(run("=MOLARITY(50,65000,10)")).toBeCloseTo(0.0769, 3);
  });

  it("computes fold change against a baseline", () => {
    expect(run("=FOLD(2000,500)")).toBe(4);
    expect(isError(run("=FOLD(1,0)"))).toBe(true);
  });

  it("refuses something that is not a sequence", () => {
    const value = run('=TM("hello world")');
    expect(isError(value) && value.code).toBe("#VALUE!");
  });
});

describe("a realistic master mix table", () => {
  // Columns: component, stock conc, final conc, volume for one reaction, for eight reactions.
  const grid: RawGrid = [
    ["Component", "Stock (mM)", "Final (mM)", "Per rxn (µL)", "x8 (µL)"],
    ["dNTPs", "10", "0.2", "=DILUTE(B2,C2,$D$8)", "=D2*8"],
    ["Primer F", "10", "0.5", "=DILUTE(B3,C3,$D$8)", "=D3*8"],
    ["Primer R", "10", "0.5", "=DILUTE(B4,C4,$D$8)", "=D4*8"],
    ["MgCl2", "50", "1.5", "=DILUTE(B5,C5,$D$8)", "=D5*8"],
    ["Buffer", "10", "1", "=DILUTE(B6,C6,$D$8)", "=D6*8"],
    ["", "", "Subtotal", "=SUM(D2:D6)", "=D7*8"],
    ["", "", "Total volume", "25", ""],
    ["", "", "Water", "=D8-D7", "=D9*8"],
  ];

  it("computes every volume and the water needed to make up the reaction", () => {
    const result = evaluateGrid(grid);
    const value = (row: number, column: number) => result[row]![column]!.value;

    expect(value(1, 3)).toBe(0.5); // dNTPs: 0.2/10 * 25
    expect(value(2, 3)).toBe(1.25); // primers: 0.5/10 * 25
    expect(value(4, 3)).toBe(0.75); // MgCl2: 1.5/50 * 25
    expect(value(5, 3)).toBe(2.5); // buffer: 1/10 * 25
    expect(value(6, 3)).toBe(6.25); // subtotal
    expect(value(8, 3)).toBe(18.75); // water to reach 25 µL
    expect(value(6, 4)).toBe(50); // subtotal for eight reactions
  });

  it("updates when a stock concentration changes", () => {
    const changed = grid.map((row) => [...row]);
    changed[4]![1] = "25"; // MgCl2 stock halved
    const result = evaluateGrid(changed);
    expect(result[4]![3]!.value).toBe(1.5);
    expect(result[6]![3]!.value).toBe(7);
    expect(result[8]![3]!.value).toBe(18);
  });
});

describe("column types", () => {
  it("parses literals according to the column", () => {
    const grid: RawGrid = [["5", "5", "yes"]];
    const result = evaluateGrid(grid, { columnTypes: ["number", "text", "checkbox"] });
    expect(result[0]![0]!.value).toBe(5);
    expect(result[0]![1]!.value).toBe("5");
    expect(result[0]![2]!.value).toBe(true);
  });

  it("recognises numbers in untyped columns", () => {
    const result = evaluateGrid([["5", "abc", "TRUE"]]);
    expect(result[0]![0]!.value).toBe(5);
    expect(result[0]![1]!.value).toBe("abc");
    expect(result[0]![2]!.value).toBe(true);
  });
});

describe("display", () => {
  it("trims floating-point noise", () => {
    expect(display("=0.1+0.2")).toBe("0.3");
    expect(display("=1/3")).toBe("0.333333333333");
    expect(display("=2*3")).toBe("6");
  });

  it("shows errors as their code", () => {
    expect(display("=1/0")).toBe("#DIV/0!");
  });
});

describe("function catalogue", () => {
  it("documents every function it offers", () => {
    for (const doc of FUNCTION_DOCS) {
      expect(FUNCTIONS[doc.name], `${doc.name} is documented but not implemented`).toBeDefined();
    }
    expect(FUNCTION_DOCS.length).toBeGreaterThan(30);
  });

  it("has a molecular biology group, which is the point of the exercise", () => {
    const bio = FUNCTION_DOCS.filter((d) => d.group === "Molecular biology");
    expect(bio.map((d) => d.name)).toContain("TM");
    expect(bio.map((d) => d.name)).toContain("DILUTE");
    expect(bio.length).toBeGreaterThanOrEqual(8);
  });
});

describe("filling a formula down", () => {
  const down = (formula: string, by = 1) => shiftFormulaRows(formula, by);

  it("moves a relative reference by the number of rows filled", () => {
    expect(down("=B2*2")).toBe("=B3*2");
    expect(down("=A1+B1", 4)).toBe("=A5+B5");
  });

  it("leaves a row locked with $ alone, as a spreadsheet does", () => {
    expect(down("=B2*$D$8")).toBe("=B3*$D$8");
    expect(down("=B$2*2")).toBe("=B$2*2");
  });

  it("shifts the row but never the column", () => {
    expect(down("=SUM(A1:C1)")).toBe("=SUM(A2:C2)");
  });

  /**
   * The cases a plain search-and-replace gets wrong. Each one was a bug before this was
   * rewritten to walk the formula instead of pattern-matching it.
   */
  it("does not mistake part of a function name for a reference", () => {
    expect(down("=LOG10(A1)")).toBe("=LOG10(A2)");
    expect(down("=LOG10(LOG10(B4))")).toBe("=LOG10(LOG10(B5))");
  });

  it("does not touch anything inside quoted text", () => {
    expect(down('=IF(A1>5,"above A1","below A1")')).toBe('=IF(A2>5,"above A1","below A1")');
    expect(down('=CONCAT("Tube B2: ",B2)')).toBe('=CONCAT("Tube B2: ",B3)');
  });

  it("does not rewrite the exponent of a number in scientific notation", () => {
    expect(down("=A1*1e5")).toBe("=A2*1e5");
  });

  it("leaves a column name longer than three letters alone", () => {
    expect(down("=TRANSLATE(A1)")).toBe("=TRANSLATE(A2)");
    expect(down("=REVCOMP(B2)")).toBe("=REVCOMP(B3)");
  });

  it("keeps a reference that would move above row 1 rather than inventing row 0", () => {
    expect(down("=A1*2", -1)).toBe("=A1*2");
  });

  it("ignores a literal, which is not a formula at all", () => {
    expect(down("B2")).toBe("B2");
    expect(down("A1 stock")).toBe("A1 stock");
  });

  it("fills a lab formula down a column of samples", () => {
    // A dilution table: each row dilutes its own stock into a shared final volume.
    const source = "=DILUTE(B2,C2,$E$1)";
    expect(down(source, 1)).toBe("=DILUTE(B3,C3,$E$1)");
    expect(down(source, 7)).toBe("=DILUTE(B9,C9,$E$1)");
  });
});

/**
 * The spreadsheet the demo entry ships with. It is the first thing anyone sees, and it is also
 * the pattern a real master mix uses: every volume derives from two cells at the bottom, so
 * changing the reaction volume or the number of reactions rescales the whole sheet.
 */
describe("a master mix that rescales from two cells", () => {
  const COLUMN_TYPES = ["text", "number", "number", "number", "number"];
  const mix = (reactionVolume: string, reactions: string) => [
    ["5x Q5 reaction buffer", "5", "1", "=DILUTE(B1,C1,$B$10)", "=D1*$B$11"],
    ["dNTP mix (mM each)", "10", "0.2", "=DILUTE(B2,C2,$B$10)", "=D2*$B$11"],
    ["Primer M13 fwd (uM)", "10", "0.5", "=DILUTE(B3,C3,$B$10)", "=D3*$B$11"],
    ["Primer M13 rev (uM)", "10", "0.5", "=DILUTE(B4,C4,$B$10)", "=D4*$B$11"],
    ["Template colony lysate (ng/uL)", "10", "0.2", "=DILUTE(B5,C5,$B$10)", "=D5*$B$11"],
    ["Q5 polymerase (U/uL)", "2", "0.02", "=DILUTE(B6,C6,$B$10)", "=D6*$B$11"],
    ["Nuclease-free water", "", "", "=$B$10-SUM(D1:D6)", "=D7*$B$11"],
    ["Total", "", "", "=SUM(D1:D7)", "=SUM(E1:E7)"],
    ["", "", "", "", ""],
    ["Reaction volume (uL)", reactionVolume, "", "", ""],
    ["Reactions, including dead volume", reactions, "", "", ""],
  ];
  const perReaction = (grid: string[][], row: number) =>
    evaluateGrid(grid, { columnTypes: COLUMN_TYPES })[row]![3]!.value;
  const inMix = (grid: string[][], row: number) =>
    evaluateGrid(grid, { columnTypes: COLUMN_TYPES })[row]![4]!.value;

  it("works out each component by C1V1", () => {
    const grid = mix("50", "4");
    expect(perReaction(grid, 0)).toBe(10); // 5x buffer to 1x in 50 uL
    expect(perReaction(grid, 1)).toBe(1); // 10 mM dNTPs to 0.2 mM
    expect(perReaction(grid, 2)).toBe(2.5); // 10 uM primer to 0.5 uM
    expect(perReaction(grid, 5)).toBe(0.5); // 2 U/uL polymerase to 0.02 U/uL
  });

  it("makes water the balance, so the reaction always totals its volume", () => {
    const grid = mix("50", "4");
    expect(perReaction(grid, 6)).toBe(32.5);
    expect(perReaction(grid, 7)).toBe(50);
  });

  it("multiplies the mix by the number of reactions", () => {
    const grid = mix("50", "4");
    expect(inMix(grid, 0)).toBe(40);
    expect(inMix(grid, 7)).toBe(200);
  });

  it("rescales from the two cells alone, with no formula edited", () => {
    const grid = mix("25", "10");
    expect(perReaction(grid, 0)).toBe(5);
    expect(perReaction(grid, 7)).toBe(25);
    // Water still balances at the smaller volume.
    expect(perReaction(grid, 6)).toBe(25 - (5 + 0.5 + 1.25 + 1.25 + 0.5 + 0.25));
    expect(inMix(grid, 7)).toBe(250);
  });

  it("flags a final concentration that is higher than the stock", () => {
    const grid = mix("50", "4");
    grid[1]![2] = "20"; // asking for 20 mM dNTPs from a 10 mM stock
    expect(toText(perReaction(grid, 1) as never)).toBe("#NUM!");
  });
});
