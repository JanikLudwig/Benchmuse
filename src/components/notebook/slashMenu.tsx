"use client";

/**
 * The `/` menu: every block an entry can hold, reachable without leaving the keyboard.
 *
 * The commands themselves are supplied by the editor rather than defined here, because several
 * of them need UI the extension cannot own — a file picker, a schema dialog — and because what
 * a reader is allowed to insert depends on their role.
 */

import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface SlashCommand {
  title: string;
  hint: string;
  group: string;
  /** extra words that should match this command, beyond its title */
  keywords?: string[];
  run: (editor: Editor, range: Range) => void;
}

export interface SlashMenuOptions {
  /** Read through a function so the editor can change the commands without rebuilding it. */
  commands: () => SlashCommand[];
}

function matches(command: SlashCommand, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    command.title.toLowerCase().includes(needle) ||
    command.group.toLowerCase().startsWith(needle) ||
    (command.keywords ?? []).some((word) => word.toLowerCase().includes(needle))
  );
}

interface SlashListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const SlashList = forwardRef<SlashListHandle, SuggestionProps<SlashCommand, SlashCommand>>(function SlashList(props, ref) {
  const [index, setIndex] = useState(0);
  const items = props.items;
  const listRef = useRef<HTMLDivElement>(null);

  // A new query produces a new list, so the highlight has to go back to the top.
  useEffect(() => setIndex(0), [items]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

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

  if (!items.length) {
    return (
      <div className="z-50 w-72 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-lg">
        Nothing matches that
      </div>
    );
  }

  let lastGroup = "";
  return (
    <div ref={listRef} className="z-50 max-h-80 w-80 overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
      {items.map((item, i) => {
        const heading = item.group !== lastGroup ? item.group : null;
        lastGroup = item.group;
        return (
          <div key={item.title}>
            {heading && (
              <p className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{heading}</p>
            )}
            <button
              type="button"
              data-index={i}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => props.command(item)}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${i === index ? "bg-brand-50" : ""}`}
            >
              <span className="font-medium text-slate-800">{item.title}</span>
              <span className="truncate text-xs text-slate-500">{item.hint}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
});

export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",

  addOptions() {
    return { commands: () => [] };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashCommand, SlashCommand>({
        editor: this.editor,
        pluginKey: new PluginKey("slashMenu"),
        char: "/",
        startOfLine: false,
        // A slash inside code is a slash, not a menu.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return !["codeBlock"].includes($from.parent.type.name) && !state.doc.rangeHasMark(range.from, range.to, state.schema.marks.code!);
        },
        items: ({ query }) => options.commands().filter((command) => matches(command, query)),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let renderer: ReactRenderer<SlashListHandle, SuggestionProps<SlashCommand, SlashCommand>> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashList, { props, editor: props.editor });
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
