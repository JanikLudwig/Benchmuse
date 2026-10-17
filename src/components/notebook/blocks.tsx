"use client";

/**
 * Block types a notebook entry can hold beyond text: spreadsheets, images and file attachments.
 *
 * All three keep their payload outside the document. The document stores only an id, so a
 * 20 MB gel photo never travels with the entry's JSON, the same file can be referenced twice
 * without being stored twice, and a table's formulas stay queryable outside the notebook.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, fileContentUrl, formatBytes } from "@/lib/api";
import { DataTable, type TableData } from "./DataTable";

// ---------------------------------------------------------------------------------------------
// Spreadsheet

export interface DataTableOptions {
  readOnly: boolean;
}

function DataTableBlock({ node, extension, deleteNode }: NodeViewProps) {
  const tableId = node.attrs.tableId as string | null;
  const { readOnly } = extension.options as DataTableOptions;
  const [table, setTable] = useState<TableData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tableId) return;
    let live = true;
    api<TableData>("GET", `/tables/${tableId}`)
      .then((t) => live && setTable(t))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [tableId]);

  if (!tableId) {
    return (
      <NodeViewWrapper className="my-4" data-drag-handle>
        <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
          This table is missing its id.{" "}
          {!readOnly && (
            <button onClick={deleteNode} className="text-brand-600 underline">
              Remove it
            </button>
          )}
        </p>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper data-drag-handle>
      {error ? (
        <p className="my-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
          This table could not be loaded ({error}).{" "}
          {!readOnly && (
            <button onClick={deleteNode} className="text-brand-600 underline">
              Remove it
            </button>
          )}
        </p>
      ) : table ? (
        <DataTable table={table} readOnly={readOnly} onDelete={deleteNode} />
      ) : (
        <div className="my-4 h-24 animate-pulse rounded-lg border border-slate-200 bg-slate-50" />
      )}
    </NodeViewWrapper>
  );
}

export const DataTableNode = Node.create<DataTableOptions>({
  name: "dataTable",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { readOnly: false };
  },
  addAttributes() {
    return { tableId: { default: null } };
  },
  parseHTML() {
    return [{ tag: "div[data-data-table]", getAttrs: (el) => ({ tableId: el.getAttribute("data-table-id") }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-data-table": "", "data-table-id": node.attrs.tableId })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DataTableBlock);
  },
});

// ---------------------------------------------------------------------------------------------
// Images

export interface LabImageOptions {
  readOnly: boolean;
}

const MIN_IMAGE_WIDTH = 15;

function LabImageView({ node, extension, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { fileId, caption, width, alt } = node.attrs as {
    fileId: string | null;
    caption: string;
    width: number;
    alt: string;
  };
  const { readOnly } = extension.options as LabImageOptions;
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  /** Drag the right edge to resize. Width is stored as a percentage so it survives reflow. */
  const startResize = useCallback(
    (event: React.PointerEvent) => {
      if (readOnly) return;
      event.preventDefault();
      const frame = frameRef.current?.parentElement;
      if (!frame) return;
      const available = frame.getBoundingClientRect().width;
      const startX = event.clientX;
      const startWidth = width;

      const onMove = (move: PointerEvent) => {
        const delta = ((move.clientX - startX) / available) * 100;
        updateAttributes({ width: Math.round(Math.max(MIN_IMAGE_WIDTH, Math.min(100, startWidth + delta))) });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [readOnly, updateAttributes, width],
  );

  if (!fileId || failed) {
    return (
      <NodeViewWrapper className="my-4">
        <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
          This image could not be loaded.{" "}
          {!readOnly && (
            <button onClick={deleteNode} className="text-brand-600 underline">
              Remove it
            </button>
          )}
        </p>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="my-4" data-drag-handle>
      <figure className="group relative m-0" style={{ width: `${width}%` }} ref={frameRef}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served from our own API, not a known-size asset */}
        <img
          src={fileContentUrl(fileId)}
          alt={alt || caption || "Image in this entry"}
          onError={() => setFailed(true)}
          className={`block w-full rounded border ${selected ? "border-brand-500 ring-2 ring-brand-200" : "border-slate-200"}`}
        />
        {!readOnly && (
          <>
            <span
              onPointerDown={startResize}
              title="Drag to resize"
              className="absolute -right-1 top-1/2 hidden h-10 w-2 -translate-y-1/2 cursor-col-resize rounded-full bg-brand-500/80 group-hover:block"
            />
            <button
              onClick={deleteNode}
              title="Remove image"
              className="absolute right-1 top-1 hidden rounded bg-white/90 px-1.5 text-sm text-slate-600 shadow hover:text-red-600 group-hover:block"
            >
              ×
            </button>
          </>
        )}
        <figcaption className="mt-1">
          <input
            value={caption ?? ""}
            disabled={readOnly}
            placeholder={readOnly ? "" : "Add a caption"}
            onChange={(e) => updateAttributes({ caption: e.target.value })}
            aria-label="Image caption"
            className="w-full rounded border border-transparent bg-transparent px-1 text-sm italic text-slate-600 placeholder:not-italic hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none"
          />
        </figcaption>
      </figure>
    </NodeViewWrapper>
  );
}

export const LabImage = Node.create<LabImageOptions>({
  name: "labImage",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { readOnly: false };
  },
  addAttributes() {
    return {
      fileId: { default: null },
      caption: { default: "" },
      alt: { default: "" },
      width: { default: 100 },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure[data-lab-image]",
        getAttrs: (el) => ({
          fileId: el.getAttribute("data-file-id"),
          caption: el.querySelector("figcaption")?.textContent ?? "",
          width: Number(el.getAttribute("data-width")) || 100,
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Exported HTML keeps a real <img>, so a printed or emailed entry still shows the figure.
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-lab-image": "",
        "data-file-id": node.attrs.fileId,
        "data-width": String(node.attrs.width),
      }),
      ["img", { src: fileContentUrl(node.attrs.fileId as string), alt: node.attrs.alt || node.attrs.caption || "" }],
      ["figcaption", {}, node.attrs.caption ?? ""],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LabImageView);
  },
});

// ---------------------------------------------------------------------------------------------
// File attachments

export interface AttachmentOptions {
  readOnly: boolean;
}

/** A hint at what the file is, from its extension. Deliberately plain text, not an icon font. */
function fileKind(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["gb", "gbk", "genbank", "ape", "dna"].includes(ext)) return "GenBank";
  if (["fa", "fasta", "fna", "faa", "seq"].includes(ext)) return "FASTA";
  if (["ab1", "abi", "fsa"].includes(ext)) return "Sanger";
  if (["csv", "tsv"].includes(ext)) return "Table";
  if (["xlsx", "xls"].includes(ext)) return "Excel";
  if (ext === "pdf") return "PDF";
  if (["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "svg"].includes(ext)) return "Image";
  if (["doc", "docx"].includes(ext)) return "Word";
  if (["zip", "gz", "tar"].includes(ext)) return "Archive";
  return ext.toUpperCase().slice(0, 6) || "File";
}

function AttachmentView({ node, extension, deleteNode }: NodeViewProps) {
  const { fileId, name, sizeBytes } = node.attrs as { fileId: string | null; name: string; sizeBytes: number };
  const { readOnly } = extension.options as AttachmentOptions;

  return (
    <NodeViewWrapper className="my-2" data-drag-handle>
      <div className="group flex max-w-md items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500 ring-1 ring-slate-200">
          {fileKind(name)}
        </span>
        <span className="min-w-0 flex-1">
          <a
            href={fileId ? fileContentUrl(fileId) : undefined}
            download={name}
            className="block truncate text-sm font-medium text-brand-700 hover:underline"
          >
            {name || "Attachment"}
          </a>
          {sizeBytes > 0 && <span className="text-xs text-slate-500">{formatBytes(sizeBytes)}</span>}
        </span>
        {!readOnly && (
          <button onClick={deleteNode} title="Remove attachment" className="shrink-0 text-slate-400 hover:text-red-600">
            ×
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const Attachment = Node.create<AttachmentOptions>({
  name: "attachment",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { readOnly: false };
  },
  addAttributes() {
    return {
      fileId: { default: null },
      name: { default: "" },
      sizeBytes: { default: 0 },
    };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-attachment]",
        getAttrs: (el) => ({
          fileId: el.getAttribute("data-file-id"),
          name: el.getAttribute("data-name") ?? el.textContent ?? "",
          sizeBytes: Number(el.getAttribute("data-size")) || 0,
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-attachment": "",
        "data-file-id": node.attrs.fileId,
        "data-name": node.attrs.name,
        "data-size": String(node.attrs.sizeBytes),
      }),
      ["a", { href: fileContentUrl(node.attrs.fileId as string) }, node.attrs.name as string],
    ];
  },
  renderText({ node }) {
    return `[${node.attrs.name}]`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView);
  },
});
