"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, cx, Dialog, Label, Select } from "../ui";
import { EntityMention, ResultsTable } from "./extensions";

type SaveState = { kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "error"; message: string };

const AUTOSAVE_MS = 800;

export function EntryEditor({
  entryId,
  initialContent,
  readOnly,
  resultSchemas,
}: {
  entryId: string;
  initialContent: Record<string, unknown>;
  readOnly: boolean;
  resultSchemas: { id: string; name: string }[];
}) {
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  // useEditor captures its callbacks once, so autosave state lives in refs, never in closures.
  const editorRef = useRef<Editor | null>(null);

  // Saves are serialized: if one is running, mark pending and save again once it finishes.
  const flush = useRef(() => {
    const current = editorRef.current;
    if (!current) return;
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    setSave({ kind: "saving" });
    inFlight.current = api("PATCH", `/entries/${entryId}`, { content: current.getJSON() })
      .then(() => setSave((s) => (s.kind === "saving" ? { kind: "saved" } : s)))
      .catch((e) => setSave({ kind: "error", message: errorMessage(e) }))
      .finally(() => {
        inFlight.current = null;
        if (pending.current) {
          pending.current = false;
          flush.current();
        }
      });
  });

  const editor = useEditor({
    immediatelyRender: false, // server-rendered page: create the editor on the client only
    editable: !readOnly,
    content: initialContent,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: "Write up your experiment… type @ to mention an entity" }),
      TableKit.configure({ table: { resizable: false } }),
      EntityMention,
      ResultsTable.configure({ entryId, readOnly }),
    ],
    editorProps: {
      attributes: { class: "prose-notebook min-h-[24rem] px-10 py-8 focus:outline-none", "aria-label": "Entry content" },
    },
    onCreate: ({ editor: created }) => {
      editorRef.current = created;
    },
    onUpdate: ({ editor: updated }) => {
      editorRef.current = updated;
      setSave({ kind: "dirty" });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flush.current(), AUTOSAVE_MS);
    },
  });

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save.kind === "dirty" || save.kind === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save.kind]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      {!readOnly && editor && <Toolbar editor={editor} resultSchemas={resultSchemas} save={save} />}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor, resultSchemas, save }: { editor: Editor; resultSchemas: { id: string; name: string }[]; save: SaveState }) {
  const [resultsOpen, setResultsOpen] = useState(false);
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      code: e.isActive("codeBlock"),
      quote: e.isActive("blockquote"),
      inTable: e.isActive("table"),
    }),
  });
  const chain = () => editor.chain().focus();
  const tool = (label: string, isActive: boolean, run: () => void, title?: string) => (
    <button
      type="button"
      title={title ?? label}
      aria-pressed={isActive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cx("h-7 min-w-7 rounded px-1.5 text-sm", isActive ? "bg-brand-100 text-brand-700" : "text-slate-600 hover:bg-slate-100")}
    >
      {label}
    </button>
  );

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-white/95 px-3 py-1.5 backdrop-blur">
      {tool("B", active.bold, () => chain().toggleBold().run(), "Bold")}
      {tool("I", active.italic, () => chain().toggleItalic().run(), "Italic")}
      {tool("U", active.underline, () => chain().toggleUnderline().run(), "Underline")}
      <span className="mx-1 h-5 w-px bg-slate-200" />
      {tool("H1", active.h1, () => chain().toggleHeading({ level: 1 }).run(), "Heading 1")}
      {tool("H2", active.h2, () => chain().toggleHeading({ level: 2 }).run(), "Heading 2")}
      {tool("• List", active.bullet, () => chain().toggleBulletList().run(), "Bulleted list")}
      {tool("1. List", active.ordered, () => chain().toggleOrderedList().run(), "Numbered list")}
      {tool("Quote", active.quote, () => chain().toggleBlockquote().run())}
      {tool("Code", active.code, () => chain().toggleCodeBlock().run(), "Code block")}
      <span className="mx-1 h-5 w-px bg-slate-200" />
      {active.inTable ? (
        <>
          {tool("+Row", false, () => chain().addRowAfter().run(), "Add row")}
          {tool("+Col", false, () => chain().addColumnAfter().run(), "Add column")}
          {tool("−Row", false, () => chain().deleteRow().run(), "Delete row")}
          {tool("−Col", false, () => chain().deleteColumn().run(), "Delete column")}
          {tool("✕Table", false, () => chain().deleteTable().run(), "Delete table")}
        </>
      ) : (
        tool("Table", false, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), "Insert table")
      )}
      <Button size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => setResultsOpen(true)}>
        + Results table
      </Button>
      <span className="ml-auto text-xs text-slate-500" role="status">
        {save.kind === "saved" && "All changes saved"}
        {save.kind === "dirty" && "Unsaved changes"}
        {save.kind === "saving" && "Saving…"}
        {save.kind === "error" && <span className="text-red-600">Save failed: {save.message}</span>}
      </span>
      <Dialog open={resultsOpen} onClose={() => setResultsOpen(false)} title="Insert results table">
        {resultSchemas.length ? (
          <form
            action={(form) => {
              chain().insertContent({ type: "resultsTable", attrs: { schemaId: form.get("schemaId") } }).run();
              setResultsOpen(false);
            }}
            className="space-y-4"
          >
            <p className="text-sm text-slate-600">
              Rows entered in a results table are validated against the schema and stored as structured results, linked to this entry.
            </p>
            <label className="block">
              <Label required>Result schema</Label>
              <Select name="schemaId">
                {resultSchemas.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </label>
            <div className="flex justify-end">
              <Button type="submit" variant="primary">Insert</Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-slate-600">
            There are no result schemas yet. Create one under <a className="text-brand-600 underline" href="/schemas">Schemas</a> first.
          </p>
        )}
      </Dialog>
    </div>
  );
}
