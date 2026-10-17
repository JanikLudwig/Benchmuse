/**
 * Prefixed opaque IDs (e.g. `ent_8fK2LqZ0aB`). The prefix makes an ID self-describing in logs,
 * URLs and API payloads, and lets `kindOfId` route a bare ID to the right table.
 */

export const ID_PREFIXES = {
  user: "usr",
  project: "prj",
  folder: "fld",
  schema: "sch",
  field: "sfd",
  dropdown: "drp",
  dropdownOption: "dro",
  entity: "ent",
  entry: "etr",
  result: "res",
  location: "loc",
  box: "box",
  plate: "plt",
  container: "con",
  annotation: "ann",
  file: "fil",
  alignment: "aln",
  read: "rea",
  lineage: "lin",
  session: "ses",
  token: "tok",
  apiKey: "key",
  auditEvent: "aud",
} as const;

export type ObjectKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[ObjectKind];

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_BODY_LENGTH = 12; // 62^12 ≈ 3e21: collision-safe for any single deployment

export function newId(kind: ObjectKind): string {
  let body = "";
  while (body.length < ID_BODY_LENGTH) {
    // 256 % 62 != 0, so reject bytes >= 248 to keep the distribution uniform.
    for (const b of crypto.getRandomValues(new Uint8Array(ID_BODY_LENGTH))) {
      if (b < 248 && body.length < ID_BODY_LENGTH) body += ALPHABET[b % 62];
    }
  }
  return `${ID_PREFIXES[kind]}_${body}`;
}

const KIND_BY_PREFIX = new Map<string, ObjectKind>(
  Object.entries(ID_PREFIXES).map(([kind, prefix]) => [prefix, kind as ObjectKind]),
);

export function kindOfId(id: string): ObjectKind | null {
  const match = /^([a-z]+)_[0-9A-Za-z]{12}$/.exec(id);
  return match ? (KIND_BY_PREFIX.get(match[1]!) ?? null) : null;
}

export function isIdOf(kind: ObjectKind, id: unknown): id is string {
  return typeof id === "string" && kindOfId(id) === kind;
}
