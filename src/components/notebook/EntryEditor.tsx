"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Range } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, upload, type UploadedFile } from "@/lib/api";
import { Button, cx, Dialog, Label, Select } from "../ui";
import { Attachment, DataTableNode, LabImage } from "./blocks";
import { EntityMention, ResultsTable } from "./extensions";
import { SlashMenu, type SlashCommand } from "./slashMenu";
import type { TableData } from "./DataTable";

type SaveState = { kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "error"; message: string };

const AUTOSAVE_MS = 800;

/** Image types we display inline; anything else becomes an attachment chip instead. */
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const isInlineImage = (file: File) => INLINE_IMAGE_TYPES.includes(file.type.toLowerCase());

/** `2026-10-17` — ISO order, so dates sort correctly and never read ambiguously across regions. */
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const localTimestamp = (d: Date) =>
  `${isoDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

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
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState("");
  /** null when the dialog is closed; otherwise where the inserted block should go. */
  const [resultsRequest, setResultsRequest] = useState<{ range: Range | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  // useEditor captures its callbacks once, so autosave state lives in refs, never in closures.
  const editorRef = useRef<Editor | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Where a slash command asked for the inserted block to go. */
  const insertAt = useRef<Range | null>(null);

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

  // -------------------------------------------------------------------------------------------
  // Inserting uploaded files

  /**
   * Upload files and insert a block for each: a figure for images, a download chip otherwise.
   * Blocks are inserted after the upload resolves, so the document never holds a dangling id.
   */
  const insertUploads = useCallback(async (files: File[], at?: Range | null) => {
    const editor = editorRef.current;
    if (!editor || !files.length) return;
    setUploadError("");
    setUploading((n) => n + files.length);
    try {
      const stored = await upload(files);
      const byId = new Map(stored.map((s) => [s.name, s]));
      const nodes = files.map((file) => nodeForUpload(byId.get(file.name) ?? stored[0]!, isInlineImage(file)));
      const chain = editor.chain().focus();
      if (at) chain.insertContentAt(at, nodes);
      else chain.insertContent(nodes);
      chain.run();
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setUploading((n) => Math.max(0, n - files.length));
    }
  }, []);

  const insertDataTable = useCallback(
    async (at?: Range | null) => {
      const editor = editorRef.current;
      if (!editor) return;
      try {
        const table = await api<TableData>("POST", "/tables", { entryId, name: "Table" });
        const node = { type: "dataTable", attrs: { tableId: table.id } };
        const chain = editor.chain().focus();
        if (at) chain.insertContentAt(at, node);
        else chain.insertContent(node);
        chain.run();
      } catch (e) {
        setUploadError(errorMessage(e));
      }
    },
    [entryId],
  );

  // -------------------------------------------------------------------------------------------
  // Slash commands. Read through a ref so the editor is built once but always sees the latest.

  const commandsRef = useRef<SlashCommand[]>([]);
  commandsRef.current = buildCommands({
    onImage: (at) => {
      insertAt.current = at;
      imageInput.current?.click();
    },
    onFile: (at) => {
      insertAt.current = at;
      fileInput.current?.click();
    },
    onDataTable: (at) => void insertDataTable(at),
    onResultsTable: (at) => setResultsRequest({ range: at }),
    hasResultSchemas: resultSchemas.length > 0,
  });

  const editor = useEditor({
    immediatelyRender: false, // server-rendered page: create the editor on the client only
    editable: !readOnly,
    content: initialContent,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: "Write up your experiment… press / for blocks, @ to mention an entity",
      }),
      TableKit.configure({ table: { resizable: false } }),
      EntityMention,
      ResultsTable.configure({ entryId, readOnly }),
      DataTableNode.configure({ readOnly }),
      LabImage.configure({ readOnly }),
      Attachment.configure({ readOnly }),
      SlashMenu.configure({ commands: () => commandsRef.current }),
    ],
    editorProps: {
      attributes: { class: "prose-notebook min-h-[24rem] px-10 py-8 focus:outline-none", "aria-label": "Entry content" },
      // Pasting a screenshot is how most gel and plate images get into a notebook, so it has to
      // work the same way as dragging a file in.
      handlePaste: (_view, event) => {
        if (readOnly) return false;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        void insertUploads(files);
        return true;
      },
      handleDrop: (_view, event) => {
        if (readOnly) return false;
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        void insertUploads(files);
        return true;
      },
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

  const onPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const at = insertAt.current;
    insertAt.current = null;
    // Reset so picking the same file twice in a row still fires a change event.
    event.target.value = "";
    void insertUploads(files, at);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      {!readOnly && editor && (
        <Toolbar
          editor={editor}
          save={save}
          uploading={uploading}
          uploadError={uploadError}
          onImage={() => {
            insertAt.current = null;
            imageInput.current?.click();
          }}
          onFile={() => {
            insertAt.current = null;
            fileInput.current?.click();
          }}
          onDataTable={() => void insertDataTable()}
          onResultsTable={() => setResultsRequest({ range: null })}
        />
      )}
      <EditorContent editor={editor} />

      <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={onPicked} />
      <input ref={fileInput} type="file" multiple hidden onChange={onPicked} />

      <InsertResultsDialog
        open={resultsRequest !== null}
        onClose={() => setResultsRequest(null)}
        schemas={resultSchemas}
        onInsert={(schemaId) => {
          const chain = editor?.chain().focus();
          if (!chain) return;
          const node = { type: "resultsTable", attrs: { schemaId } };
          if (resultsRequest?.range) chain.insertContentAt(resultsRequest.range, node);
          else chain.insertContent(node);
          chain.run();
        }}
      />
    </div>
  );
}

/** The node to insert for one uploaded file. */
function nodeForUpload(file: UploadedFile, asImage: boolean) {
  return asImage
    ? { type: "labImage", attrs: { fileId: file.id, caption: "", alt: file.name, width: 100 } }
    : { type: "attachment", attrs: { fileId: file.id, name: file.name, sizeBytes: file.sizeBytes } };
}

function buildCommands({
  onImage,
  onFile,
  onDataTable,
  onResultsTable,
  hasResultSchemas,
}: {
  onImage: (at: Range) => void;
  onFile: (at: Range) => void;
  onDataTable: (at: Range) => void;
  onResultsTable: (at: Range) => void;
  hasResultSchemas: boolean;
}): SlashCommand[] {
  /** Most commands just replace the typed `/query` with a block. */
  const replace = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

  const commands: SlashCommand[] = [
    {
      title: "Spreadsheet",
      hint: "Formulas, units, Excel paste",
      group: "Data",
      keywords: ["table", "excel", "formula", "calculate", "grid", "sheet"],
      run: (editor, range) => {
        replace(editor, range).run();
        onDataTable(range);
      },
    },
    {
      title: "Simple table",
      hint: "Plain rows and columns",
      group: "Data",
      keywords: ["grid"],
      run: (editor, range) => replace(editor, range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      title: "Image",
      hint: "Gel, plate, microscopy",
      group: "Attachments",
      keywords: ["photo", "picture", "figure", "gel", "upload"],
      run: (editor, range) => {
        replace(editor, range).run();
        onImage(range);
      },
    },
    {
      title: "File",
      hint: "Attach any file for download",
      group: "Attachments",
      keywords: ["attachment", "upload", "pdf", "document"],
      run: (editor, range) => {
        replace(editor, range).run();
        onFile(range);
      },
    },
    {
      title: "Today's date",
      hint: isoDate(new Date()),
      group: "Insert",
      keywords: ["date", "today", "when"],
      run: (editor, range) => replace(editor, range).insertContent(isoDate(new Date())).run(),
    },
    {
      title: "Timestamp",
      hint: localTimestamp(new Date()),
      group: "Insert",
      keywords: ["now", "time", "clock"],
      run: (editor, range) => replace(editor, range).insertContent(localTimestamp(new Date())).run(),
    },
    {
      title: "Divider",
      hint: "Separate sections",
      group: "Insert",
      keywords: ["rule", "line", "hr", "break"],
      run: (editor, range) => replace(editor, range).setHorizontalRule().run(),
    },
    {
      title: "Heading 1",
      hint: "Section title",
      group: "Text",
      keywords: ["h1", "title"],
      run: (editor, range) => replace(editor, range).setNode("heading", { level: 1 }).run(),
    },
    {
      title: "Heading 2",
      hint: "Subsection",
      group: "Text",
      keywords: ["h2"],
      run: (editor, range) => replace(editor, range).setNode("heading", { level: 2 }).run(),
    },
    {
      title: "Heading 3",
      hint: "Minor heading",
      group: "Text",
      keywords: ["h3"],
      run: (editor, range) => replace(editor, range).setNode("heading", { level: 3 }).run(),
    },
    {
      title: "Bulleted list",
      hint: "Steps in any order",
      group: "Text",
      keywords: ["ul", "unordered", "points"],
      run: (editor, range) => replace(editor, range).toggleBulletList().run(),
    },
    {
      title: "Numbered list",
      hint: "Protocol steps in order",
      group: "Text",
      keywords: ["ol", "ordered", "protocol", "steps"],
      run: (editor, range) => replace(editor, range).toggleOrderedList().run(),
    },
    {
      title: "Quote",
      hint: "Cite a protocol or paper",
      group: "Text",
      keywords: ["blockquote", "citation"],
      run: (editor, range) => replace(editor, range).toggleBlockquote().run(),
    },
    {
      title: "Code block",
      hint: "Script or sequence output",
      group: "Text",
      keywords: ["pre", "script", "monospace"],
      run: (editor, range) => replace(editor, range).toggleCodeBlock().run(),
    },
  ];

  if (hasResultSchemas) {
    commands.splice(1, 0, {
      title: "Results table",
      hint: "Typed rows validated by a schema",
      group: "Data",
      keywords: ["structured", "schema", "measurements"],
      run: (editor, range) => {
        replace(editor, range).run();
        onResultsTable(range);
      },
    });
  }

  return commands;
}

function InsertResultsDialog({
  open,
  onClose,
  schemas,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  schemas: { id: string; name: string }[];
  onInsert: (schemaId: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Insert results table">
      {schemas.length ? (
        <form
          action={(form) => {
            onInsert(String(form.get("schemaId")));
            onClose();
          }}
          className="space-y-4"
        >
          <p className="text-sm text-slate-600">
            Rows entered in a results table are validated against the schema and stored as structured results, linked to this entry.
          </p>
          <label className="block">
            <Label required>Result schema</Label>
            <Select name="schemaId">
              {schemas.map((s) => (
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
  );
}

function Toolbar({
  editor,
  save,
  uploading,
  uploadError,
  onImage,
  onFile,
  onDataTable,
  onResultsTable,
}: {
  editor: Editor;
  save: SaveState;
  uploading: number;
  uploadError: string;
  onImage: () => void;
  onFile: () => void;
  onDataTable: () => void;
  onResultsTable: () => void;
}) {
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
      {tool("Σ Sheet", false, onDataTable, "Insert a spreadsheet with formulas")}
      {tool("Image", false, onImage, "Insert an image")}
      {tool("File", false, onFile, "Attach a file")}
      {tool("Date", false, () => chain().insertContent(isoDate(new Date())).run(), `Insert today's date`)}
      <Button size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onResultsTable}>
        + Results table
      </Button>

      <span className="ml-auto flex items-center gap-2 text-xs text-slate-500" role="status">
        {uploading > 0 && <span>Uploading {uploading} file{uploading === 1 ? "" : "s"}…</span>}
        {uploadError && <span className="text-red-600">{uploadError}</span>}
        {save.kind === "saved" && "All changes saved"}
        {save.kind === "dirty" && "Unsaved changes"}
        {save.kind === "saving" && "Saving…"}
        {save.kind === "error" && <span className="text-red-600">Save failed: {save.message}</span>}
      </span>
    </div>
  );
}
