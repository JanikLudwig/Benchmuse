/** Minimal inline icon set (24px grid, stroke-based) so the app has no icon-font dependency. */
const PATHS = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  search: "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zm5.3-2.2L21 21",
  schema: "M4 5h16M4 12h16M4 19h10M8 3v4M14 10v4M10 17v4",
  dna: "M7 3c0 6 10 6 10 12s-10 6-10 6M17 3c0 6-10 6-10 12M8 7h8M8 17h8M10 12h4",
  entry: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7",
  protein: "M5 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0m8 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0M8 9V5m8 4V5m-8 14v-4m8 4v-4",
  entity: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5",
  plus: "M12 5v14M5 12h14",
  chevron: "M9 6l6 6-6 6",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function iconForItem(item: { type: string; entityType?: string | null }): IconName {
  if (item.type === "folder" || item.type === "project") return "folder";
  if (item.type === "entry") return "entry";
  if (item.entityType === "dna_sequence") return "dna";
  if (item.entityType === "aa_sequence") return "protein";
  return "entity";
}
