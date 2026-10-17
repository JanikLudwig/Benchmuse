import { describe, expect, it } from "vitest";
import { isIdOf, kindOfId, newId } from "./ids";
import { validateFieldDefinition, validateFieldValues, type FieldDefinition } from "./fields";
import { parseNameTemplate, renderNameTemplate } from "./nameTemplates";
import { parseFilter, parseSort, serializeFilter } from "./filters";

describe("ids", () => {
  it("generates prefixed, unique ids that round-trip to their kind", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("entity")));
    expect(ids.size).toBe(2000);
    for (const id of ids) {
      expect(id).toMatch(/^ent_[0-9A-Za-z]{12}$/);
      expect(kindOfId(id)).toBe("entity");
    }
  });

  it("rejects ids of other kinds and garbage", () => {
    expect(isIdOf("entity", newId("entry"))).toBe(false);
    expect(kindOfId("nope")).toBeNull();
    expect(kindOfId("zzz_abcdefghijkl")).toBeNull();
    expect(kindOfId("ent_short")).toBeNull();
    expect(isIdOf("entity", 42)).toBe(false);
  });
});

const field = (overrides: Partial<FieldDefinition> & Pick<FieldDefinition, "name" | "type">): FieldDefinition => ({
  id: newId("field"),
  displayName: overrides.name,
  isRequired: false,
  isMulti: false,
  ...overrides,
});

describe("field definitions", () => {
  it("accepts a well-formed definition", () => {
    expect(validateFieldDefinition({ name: "strain", displayName: "Strain", type: "text", isRequired: false, isMulti: false })).toEqual([]);
  });

  it("rejects bad names and misplaced options", () => {
    const errors = validateFieldDefinition({
      name: "Bad Name",
      displayName: "",
      type: "text",
      isRequired: false,
      isMulti: false,
      dropdownId: newId("dropdown"),
    });
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining("snake_case"),
      "displayName is required",
      "dropdownId is only valid on dropdown fields",
    ]);
  });

  it("requires a dropdownId on dropdown fields", () => {
    expect(validateFieldDefinition({ name: "color", displayName: "Color", type: "dropdown", isRequired: false, isMulti: false })).toHaveLength(1);
  });
});

describe("field values", () => {
  const dropdownId = newId("dropdown");
  const fields: FieldDefinition[] = [
    field({ name: "strain", type: "text", isRequired: true }),
    field({ name: "passage", type: "integer" }),
    field({ name: "od600", type: "float" }),
    field({ name: "verified", type: "boolean" }),
    field({ name: "received_on", type: "date" }),
    field({ name: "measured_at", type: "datetime" }),
    field({ name: "media", type: "dropdown", dropdownId }),
    field({ name: "parents", type: "entity_link", isMulti: true }),
    field({ name: "meta", type: "json" }),
    field({ name: "old", type: "text", archivedAt: new Date() }),
  ];

  it("normalizes valid input and collects references", () => {
    const optionId = newId("dropdownOption");
    const [p1, p2] = [newId("entity"), newId("entity")];
    const result = validateFieldValues(
      fields,
      {
        strain: "K-12",
        passage: "3",
        od600: 0.42,
        verified: "true",
        received_on: "2026-02-28",
        measured_at: "2026-02-28T09:30:00+02:00",
        media: optionId,
        parents: [p1, p2, p1],
        meta: { lot: "A1" },
      },
      "create",
    );
    expect(result).toEqual({
      ok: true,
      values: {
        strain: "K-12",
        passage: 3,
        od600: 0.42,
        verified: true,
        received_on: "2026-02-28",
        measured_at: "2026-02-28T07:30:00.000Z",
        media: optionId,
        parents: [p1, p2],
        meta: { lot: "A1" },
      },
      references: [
        { fieldName: "media", kind: "dropdown_option", id: optionId, dropdownId },
        { fieldName: "parents", kind: "entity", id: p1, targetSchemaId: null },
        { fieldName: "parents", kind: "entity", id: p2, targetSchemaId: null },
      ],
    });
  });

  it("fills absent optional fields with null on create", () => {
    const result = validateFieldValues(fields, { strain: "BL21" }, "create");
    expect(result.ok && result.values).toMatchObject({ strain: "BL21", passage: null, parents: null });
  });

  it("reports every problem at once", () => {
    const result = validateFieldValues(
      fields,
      {
        passage: 1.5,
        received_on: "2026-02-30",
        measured_at: "2026-02-28T09:30:00",
        parents: ["ent_x", newId("entry")],
        unknown_thing: 1,
        old: "nope",
      },
      "create",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field).sort()).toEqual(
      ["measured_at", "old", "parents[0]", "parents[1]", "passage", "received_on", "strain", "unknown_thing"].sort(),
    );
  });

  it("treats update as a partial patch but refuses to clear required fields", () => {
    expect(validateFieldValues(fields, { passage: 7 }, "update")).toEqual({ ok: true, values: { passage: 7 }, references: [] });
    const cleared = validateFieldValues(fields, { strain: "" }, "update");
    expect(cleared.ok).toBe(false);
  });

  it("rejects lists for single-valued fields and scalars for multi fields", () => {
    const result = validateFieldValues(fields, { strain: ["a"], parents: newId("entity") }, "update");
    expect(result.ok).toBe(false);
  });
});

describe("name templates", () => {
  it("renders numbers and dates", () => {
    const parsed = parseNameTemplate("PLS{yy}{mm}-{n:4}");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(renderNameTemplate(parsed.parts, 17, new Date("2026-10-17T12:00:00Z"))).toBe("PLS2610-0017");
    expect(renderNameTemplate(parsed.parts, 123456, new Date("2026-01-01T00:00:00Z"))).toBe("PLS2601-123456");
  });

  it.each([
    ["", "1-64"],
    ["PLS", "exactly one {n}"],
    ["{n}{n}", "exactly one {n}"],
    ["P S-{n}", "invalid characters"],
    ["{n:20}", "at most 12"],
    ["{foo}-{n}", "unknown token"],
  ])("rejects %j", (template, message) => {
    const parsed = parseNameTemplate(template);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});

describe("filter grammar", () => {
  it("round-trips clauses, including values with reserved characters", () => {
    const text = serializeFilter([
      { property: "type", operator: "IS_ONE_OF", values: ["entity", "entry"] },
      { property: "archived", operator: "IS_FALSE", values: [] },
      { property: "field.note", operator: "CONTAINS", values: ["a:b;c,d"] },
    ]);
    expect(text).toBe("type:IS_ONE_OF:entity,entry;archived:IS_FALSE;field.note:CONTAINS:a%3Ab%3Bc%2Cd");
    expect(parseFilter(text)).toEqual({
      ok: true,
      value: [
        { property: "type", operator: "IS_ONE_OF", values: ["entity", "entry"] },
        { property: "archived", operator: "IS_FALSE", values: [] },
        { property: "field.note", operator: "CONTAINS", values: ["a:b;c,d"] },
      ],
    });
  });

  it.each(["type", "type:LIKE:x", "archived:IS_FALSE:x", "name:EQ", "name:EQ:a,b", "Name:EQ:a", "a:EQ:b:c"])(
    "rejects %j",
    (text) => expect(parseFilter(text).ok).toBe(false),
  );

  it("parses sorts", () => {
    expect(parseSort("modified_at:desc;name")).toEqual({
      ok: true,
      value: [
        { property: "modified_at", direction: "desc" },
        { property: "name", direction: "asc" },
      ],
    });
    expect(parseSort("name:up").ok).toBe(false);
  });
});
