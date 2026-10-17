"use client";

import { mergeAttributes, Node, type Editor, type Range } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import Link from "next/link";
import { forwardRef, useImperativeHandle, useState } from "react";
import { ResultsTableView } from "./ResultsTableView";

// ---------------------------------------------------------------------------------------------
// @-mentions of entities. Stored as { type: "entityMention", attrs: { id, label } } so the server
// can find backlinks (see mentionedEntityIds / getBacklinks).

interface MentionItem {
  id: string;
  name: string;
  registryId: string | null;
}

function MentionChip({ node }: NodeViewProps) {
  const { id, label } = node.attrs as { id: string; label: string };
  return (
    <NodeViewWrapper as="span" className="inline">
      <Link
        href={`/entities/${id}`}
        data-mention=""
        contentEditable={false}
        className="rounded bg-brand-50 px-1 py-0.5 text-[0.95em] font-medium text-brand-700 no-underline hover:bg-brand-100"
      >
        @{label}
      </Link>
    </NodeViewWrapper>
  );
}

interface MentionListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const MentionList = forwardRef<MentionListHandle, SuggestionProps<MentionItem, MentionItem>>(function MentionList(props, ref) {
  const [index, setIndex] = useState(0);
  const items = props.items;
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") setIndex((i) => (i + 1) % items.length);
      else if (event.key === "ArrowUp") setIndex((i) => (i - 1 + items.length) % items.length);
      else if (event.key === "Enter" || event.key === "Tab") props.command(items[index]!);
      else return false;
      return true;
    },
  }));
  return (
    <div className="z-50 w-72 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
      {props.loading && !items.length ? (
        <p className="px-3 py-1.5 text-slate-500">Searching…</p>
      ) : items.length ? (
        items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.command(item)}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${i === index ? "bg-brand-50" : ""}`}
          >
            <span>{item.name}</span>
            {item.registryId && <span className="font-mono text-xs text-slate-500">{item.registryId}</span>}
          </button>
        ))
      ) : (
        <p className="px-3 py-1.5 text-slate-500">No matching entities</p>
      )}
    </div>
  );
});

export const EntityMention = Node.create({
  name: "entityMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { id: { default: null }, label: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-entity-id]", getAttrs: (el) => ({ id: el.getAttribute("data-entity-id"), label: el.textContent?.replace(/^@/, "") }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-entity-id": node.attrs.id }), `@${node.attrs.label}`];
  },
  renderText({ node }) {
    return `@${node.attrs.label}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(MentionChip, { as: "span" });
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<MentionItem, MentionItem>({
        editor: this.editor,
        pluginKey: new PluginKey("entityMention"),
        char: "@",
        debounce: 120,
        items: async ({ query, signal }) => {
          const params = new URLSearchParams({ filter: "type:EQ:entity", limit: "8", sort: "modified_at:desc", ...(query && { q: query }) });
          try {
            const res = await fetch(`/api/v1/search?${params}`, { signal });
            return res.ok ? ((await res.json()).items as MentionItem[]) : [];
          } catch {
            return [];
          }
        },
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: MentionItem }) => {
          const label = props.registryId ? `${props.name} (${props.registryId})` : props.name;
          editor
            .chain()
            .focus()
            .insertContentAt(range, [{ type: "entityMention", attrs: { id: props.id, label } }, { type: "text", text: " " }])
            .run();
        },
        render: () => {
          let renderer: ReactRenderer<MentionListHandle, SuggestionProps<MentionItem, MentionItem>> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(MentionList, { props, editor: props.editor });
              unmount = props.mount(renderer.element);
            },
            onUpdate: (props) => renderer?.updateProps(props),
            onKeyDown: (props) => {
              if (props.event.key === "Escape") return false;
              return renderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              unmount?.();
              renderer?.destroy();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------------------------------------
// Structured results table: the document stores only { schemaId }; rows live in the `results`
// table linked to this entry, so they are validated, typed and queryable outside the notebook.

export interface ResultsTableOptions {
  entryId: string;
  readOnly: boolean;
}

export const ResultsTable = Node.create<ResultsTableOptions>({
  name: "resultsTable",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { entryId: "", readOnly: false };
  },
  addAttributes() {
    return { schemaId: { default: null } };
  },
  parseHTML() {
    return [{ tag: "div[data-results-table]", getAttrs: (el) => ({ schemaId: el.getAttribute("data-schema-id") }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-results-table": "", "data-schema-id": node.attrs.schemaId })];
  },
  addNodeView() {
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <NodeViewWrapper className="my-4" data-drag-handle>
        <ResultsTableView
          entryId={(props.extension.options as ResultsTableOptions).entryId}
          schemaId={props.node.attrs.schemaId as string}
          readOnly={(props.extension.options as ResultsTableOptions).readOnly}
          onRemove={props.deleteNode}
        />
      </NodeViewWrapper>
    ));
  },
});

