import type { AuditChanges } from "@/server/db/schema";

const ACTION_LABEL: Record<string, string> = {
  create: "Created",
  update: "Edited",
  archive: "Archived",
  unarchive: "Unarchived",
  register: "Registered",
  move: "Moved",
};

const fmt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function show(value: unknown, names: Record<string, string>): string {
  if (value === null || value === undefined || value === "") return "∅";
  if (Array.isArray(value)) return value.map((v) => show(v, names)).join(", ") || "∅";
  if (typeof value === "string") return names[value] ?? (value.length > 60 ? `${value.slice(0, 57)}…` : value);
  const json = JSON.stringify(value);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

export function AuditTimeline({
  events,
  userNames,
  valueNames = {},
  fieldLabels = {},
}: {
  events: { id: string; action: string; actorId: string; at: Date; changes: AuditChanges }[];
  userNames: Record<string, string>;
  /** display names for IDs that appear as values (dropdown options, linked entities) */
  valueNames?: Record<string, string>;
  /** `fields.<name>` -> display name */
  fieldLabels?: Record<string, string>;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 font-semibold">History</h2>
      <ol className="space-y-3">
        {events.map((e) => {
          const changes = Object.entries(e.changes).filter(([key]) => !(e.action === "create" && key === "name"));
          return (
            <li key={e.id} className="text-sm">
              <div>
                <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                <span className="text-slate-500"> by {userNames[e.actorId] ?? e.actorId} · {fmt.format(e.at)} UTC</span>
              </div>
              {changes.length > 0 && (
                <ul className="mt-1 space-y-0.5 border-l-2 border-slate-100 pl-3 text-xs text-slate-600">
                  {changes.map(([key, { from, to }]) => (
                    <li key={key}>
                      <span className="font-medium text-slate-700">{fieldLabels[key] ?? key.replace(/^fields\./, "")}</span>:{" "}
                      <span className="text-slate-400 line-through">{show(from, valueNames)}</span> → {show(to, valueNames)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
