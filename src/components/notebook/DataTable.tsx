"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { shiftFormulaRows } from "@/lib/formula/ast";
import { columnLetters, describeError, evaluateGrid, isError, toText, type EvaluatedCell } from "@/lib/formula/evaluate";
import { FUNCTION_DOCS } from "@/lib/formula/functions";
import { Button, cx, ErrorText } from "../ui";
// Type-only, so none of the server's database code reaches the client bundle; it keeps the
// grid and the stored column definition from drifting apart.
import type { TableColumn } from "@/server/db/schema";

export type { TableColumn };

export interface TableData {
  id: string;
  name: string;
  columns: TableColumn[];
  rows: string[][];
}

interface Cell {
  row: number;
  column: number;
}

const DEFAULT_WIDTH = 140;
const ROW_HEADER_WIDTH = 44;
const SAVE_DELAY_MS = 700;

/**
 * A spreadsheet inside a notebook entry.
 *
 * Keyboard behaviour follows Excel closely, because that is the muscle memory every scientist
 * already has: type to replace, F2 to edit in place, Enter and Tab to commit and move, Escape
 * to cancel, Ctrl+D to fill down, and paste from a real spreadsheet to fill a region.
 */
export function DataTable({
  table,
  readOnly,
  onDelete,
}: {
  table: TableData;
  readOnly?: boolean;
  onDelete?: () => void;
}) {
  const [columns, setColumns] = useState<TableColumn[]>(table.columns);
  const [rows, setRows] = useState<string[][]>(table.rows);
  const [name, setName] = useState(table.name);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<{ cell: Cell; value: string; selectAll: boolean } | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [error, setError] = useState("");

  const gridRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<{ columns: TableColumn[]; rows: string[][]; name: string } | null>(null);
  const inFlight = useRef(false);

  const evaluated = useMemo(
    () => evaluateGrid(rows, { columnTypes: columns.map((c) => c.type) }),
    [rows, columns],
  );

  // ---------------------------------------------------------------------------------------
  // Saving

  const flush = useCallback(async () => {
    if (inFlight.current || !pending.current) return;
    const payload = pending.current;
    pending.current = null;
    inFlight.current = true;
    setStatus("saving");
    try {
      await api("PUT", `/tables/${table.id}`, payload);
      setStatus(pending.current ? "dirty" : "saved");
      setError("");
    } catch (e) {
      setStatus("error");
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
      if (pending.current) void flush();
    }
  }, [table.id]);

  const queueSave = useCallback(
    (next: { columns?: TableColumn[]; rows?: string[][]; name?: string }) => {
      if (readOnly) return;
      pending.current = {
        columns: next.columns ?? pending.current?.columns ?? columns,
        rows: next.rows ?? pending.current?.rows ?? rows,
        name: next.name ?? pending.current?.name ?? name,
      };
      setStatus("dirty");
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [columns, rows, name, flush, readOnly],
  );

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // ---------------------------------------------------------------------------------------
  // Grid mutation

  const width = columns.length;

  const setCell = useCallback(
    (row: number, column: number, value: string) => {
      setRows((current) => {
        const next = current.map((r) => [...r]);
        while (next.length <= row) next.push(Array.from({ length: width }, () => ""));
        next[row]![column] = value;
        queueSave({ rows: next });
        return next;
      });
    },
    [queueSave, width],
  );

  const setRegion = useCallback(
    (start: Cell, block: string[][]) => {
      setRows((current) => {
        const next = current.map((r) => [...r]);
        const neededRows = start.row + block.length;
        while (next.length < neededRows) next.push(Array.from({ length: width }, () => ""));
        block.forEach((blockRow, r) => {
          blockRow.forEach((value, c) => {
            const column = start.column + c;
            if (column < width) next[start.row + r]![column] = value;
          });
        });
        queueSave({ rows: next });
        return next;
      });
    },
    [queueSave, width],
  );

  const addRows = useCallback(
    (count = 1, at?: number) => {
      setRows((current) => {
        const blank = Array.from({ length: count }, () => Array.from({ length: width }, () => ""));
        const index = at ?? current.length;
        const next = [...current.slice(0, index), ...blank, ...current.slice(index)];
        queueSave({ rows: next });
        return next;
      });
    },
    [queueSave, width],
  );

  const removeRow = useCallback(
    (index: number) => {
      setRows((current) => {
        if (current.length <= 1) return current;
        const next = current.filter((_, i) => i !== index);
        queueSave({ rows: next });
        return next;
      });
    },
    [queueSave],
  );

  const addColumn = useCallback(
    (at?: number) => {
      const index = at ?? columns.length;
      const column: TableColumn = { id: `new-${Date.now()}`, name: `Column ${columns.length + 1}`, type: "text" };
      const nextColumns = [...columns.slice(0, index), column, ...columns.slice(index)];
      const nextRows = rows.map((row) => [...row.slice(0, index), "", ...row.slice(index)]);
      setColumns(nextColumns);
      setRows(nextRows);
      queueSave({ columns: nextColumns, rows: nextRows });
    },
    [columns, rows, queueSave],
  );

  const removeColumn = useCallback(
    (index: number) => {
      if (columns.length <= 1) return;
      const nextColumns = columns.filter((_, i) => i !== index);
      const nextRows = rows.map((row) => row.filter((_, i) => i !== index));
      setColumns(nextColumns);
      setRows(nextRows);
      queueSave({ columns: nextColumns, rows: nextRows });
    },
    [columns, rows, queueSave],
  );

  const updateColumn = useCallback(
    (index: number, patch: Partial<TableColumn>) => {
      const nextColumns = columns.map((c, i) => (i === index ? { ...c, ...patch } : c));
      setColumns(nextColumns);
      queueSave({ columns: nextColumns });
    },
    [columns, queueSave],
  );

  // ---------------------------------------------------------------------------------------
  // Selection

  const selection = useMemo(() => {
    if (!anchor || !focus) return null;
    return {
      top: Math.min(anchor.row, focus.row),
      bottom: Math.max(anchor.row, focus.row),
      left: Math.min(anchor.column, focus.column),
      right: Math.max(anchor.column, focus.column),
    };
  }, [anchor, focus]);

  const inSelection = (row: number, column: number) =>
    !!selection && row >= selection.top && row <= selection.bottom && column >= selection.left && column <= selection.right;

  const moveTo = useCallback(
    (row: number, column: number, extend = false) => {
      const target = {
        row: Math.max(0, Math.min(rows.length - 1, row)),
        column: Math.max(0, Math.min(width - 1, column)),
      };
      setFocus(target);
      if (!extend) setAnchor(target);
      // Keep the moved-to cell on screen.
      requestAnimationFrame(() => {
        gridRef.current?.querySelector<HTMLElement>(`[data-cell="${target.row}-${target.column}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },
    [rows.length, width],
  );

  const startEditing = useCallback(
    (cell: Cell, initial?: string) => {
      if (readOnly) return;
      setEditing({
        cell,
        value: initial ?? rows[cell.row]?.[cell.column] ?? "",
        selectAll: initial === undefined,
      });
    },
    [rows, readOnly],
  );

  const commitEdit = useCallback(
    (move: "down" | "right" | "up" | "left" | "none" = "down") => {
      if (!editing) return;
      setCell(editing.cell.row, editing.cell.column, editing.value);
      const { row, column } = editing.cell;
      setEditing(null);
      if (move === "down") moveTo(row + 1 >= rows.length ? row : row + 1, column);
      else if (move === "up") moveTo(row - 1, column);
      else if (move === "right") moveTo(row, column + 1);
      else if (move === "left") moveTo(row, column - 1);
      gridRef.current?.focus();
    },
    [editing, setCell, moveTo, rows.length],
  );

  useEffect(() => {
    if (!editing) return;
    const input = editorRef.current;
    if (!input) return;
    input.focus();
    if (editing.selectAll) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
    // Only run when the edited cell changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.cell.row, editing?.cell.column]);

  // ---------------------------------------------------------------------------------------
  // Keyboard

  function onGridKeyDown(event: React.KeyboardEvent) {
    if (editing || !focus) return;
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === "c") {
      copySelection();
      return;
    }
    if (meta && event.key.toLowerCase() === "x" && !readOnly) {
      copySelection();
      clearSelection();
      event.preventDefault();
      return;
    }
    if (meta && event.key.toLowerCase() === "d" && !readOnly) {
      fillDown();
      event.preventDefault();
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      setAnchor({ row: 0, column: 0 });
      setFocus({ row: rows.length - 1, column: width - 1 });
      event.preventDefault();
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        moveTo(focus.row + 1, focus.column, event.shiftKey);
        break;
      case "ArrowUp":
        moveTo(focus.row - 1, focus.column, event.shiftKey);
        break;
      case "ArrowLeft":
        moveTo(focus.row, focus.column - 1, event.shiftKey);
        break;
      case "ArrowRight":
        moveTo(focus.row, focus.column + 1, event.shiftKey);
        break;
      case "Tab":
        moveTo(focus.row, focus.column + (event.shiftKey ? -1 : 1));
        break;
      case "Enter":
      case "F2":
        startEditing(focus);
        break;
      case "Home":
        moveTo(focus.row, 0, event.shiftKey);
        break;
      case "End":
        moveTo(focus.row, width - 1, event.shiftKey);
        break;
      case "Backspace":
      case "Delete":
        if (!readOnly) clearSelection();
        break;
      case "Escape":
        setAnchor(focus);
        break;
      default:
        // Any printable key starts an edit, replacing the cell, exactly as a spreadsheet does.
        if (!meta && !readOnly && event.key.length === 1) startEditing(focus, event.key);
        else return;
    }
    event.preventDefault();
  }

  function clearSelection() {
    if (!selection) return;
    setRows((current) => {
      const next = current.map((r) => [...r]);
      for (let row = selection.top; row <= selection.bottom; row++) {
        for (let column = selection.left; column <= selection.right; column++) {
          if (next[row]) next[row]![column] = "";
        }
      }
      queueSave({ rows: next });
      return next;
    });
  }

  function fillDown() {
    if (!selection || selection.top === selection.bottom) return;
    setRows((current) => {
      const next = current.map((r) => [...r]);
      for (let column = selection.left; column <= selection.right; column++) {
        const source = next[selection.top]?.[column] ?? "";
        for (let row = selection.top + 1; row <= selection.bottom; row++) {
          if (next[row]) next[row]![column] = shiftFormulaRows(source, row - selection.top);
        }
      }
      queueSave({ rows: next });
      return next;
    });
  }

  function selectionAsTsv(): string {
    if (!selection) return "";
    const lines: string[] = [];
    for (let row = selection.top; row <= selection.bottom; row++) {
      const cells: string[] = [];
      for (let column = selection.left; column <= selection.right; column++) {
        // Copy computed values, so pasting into Excel gives numbers rather than formulas.
        cells.push(toText(evaluated[row]?.[column]?.value ?? null));
      }
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  function copySelection() {
    const text = selectionAsTsv();
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  function onPaste(event: React.ClipboardEvent) {
    if (readOnly || !focus || editing) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const block = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    setRegion(focus, block);
    setAnchor(focus);
    setFocus({
      row: Math.min(rows.length + block.length, focus.row + block.length - 1),
      column: Math.min(width - 1, focus.column + (block[0]?.length ?? 1) - 1),
    });
  }

  // ---------------------------------------------------------------------------------------
  // Rendering

  const activeCell = focus ? evaluated[focus.row]?.[focus.column] : undefined;
  const activeRaw = focus ? rows[focus.row]?.[focus.column] ?? "" : "";

  return (
    <div className="my-4 rounded-lg border border-slate-200 bg-white" contentEditable={false}>
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <input
          value={name}
          disabled={readOnly}
          onChange={(e) => {
            setName(e.target.value);
            queueSave({ name: e.target.value });
          }}
          aria-label="Table name"
          className="min-w-32 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold hover:border-slate-300 focus:border-brand-500 focus:bg-white focus:outline-none"
        />
        <span className="text-xs text-slate-500" role="status">
          {status === "saved" && "Saved"}
          {status === "dirty" && "Unsaved"}
          {status === "saving" && "Saving…"}
          {status === "error" && <span className="text-red-600">Not saved</span>}
        </span>
        {!readOnly && (
          <div className="flex gap-1">
            <Button size="sm" onClick={() => addRows(1)}>+ Row</Button>
            <Button size="sm" onClick={() => addColumn()}>+ Column</Button>
          </div>
        )}
        <a
          href={`/api/v1/tables/${table.id}/csv`}
          className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          CSV
        </a>
        {!readOnly && onDelete && (
          <Button size="sm" variant="ghost" onClick={onDelete}>Remove table</Button>
        )}
      </header>

      {/* Formula bar: shows what is really in the cell, and lets it be edited directly. */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5">
        <span className="w-12 shrink-0 font-mono text-xs text-slate-500">
          {focus ? `${columnLetters(focus.column)}${focus.row + 1}` : "—"}
        </span>
        <input
          value={editing ? editing.value : activeRaw}
          disabled={readOnly || !focus}
          placeholder={focus ? "Value, or = to start a formula" : "Select a cell"}
          onChange={(e) => focus && setEditing({ cell: focus, value: e.target.value, selectAll: false })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitEdit("down");
              e.preventDefault();
            } else if (e.key === "Escape") {
              setEditing(null);
              gridRef.current?.focus();
            }
          }}
          className="flex-1 rounded border border-transparent px-1 py-0.5 font-mono text-xs hover:border-slate-300 focus:border-brand-500 focus:outline-none"
        />
        {activeCell && isError(activeCell.value) && (
          <span className="text-xs text-red-600">{describeError(activeCell.value)}</span>
        )}
        <FunctionHelp />
      </div>

      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label={name}
        onKeyDown={onGridKeyDown}
        onPaste={onPaste}
        className="max-h-[32rem] overflow-auto outline-none focus:ring-1 focus:ring-inset focus:ring-brand-500"
      >
        <table className="border-collapse text-sm" style={{ minWidth: "100%" }}>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-slate-200 bg-slate-100" style={{ width: ROW_HEADER_WIDTH }} />
              {columns.map((column, index) => (
                <ColumnHeader
                  key={column.id}
                  column={column}
                  index={index}
                  readOnly={readOnly}
                  selected={!!selection && index >= selection.left && index <= selection.right}
                  onChange={(patch) => updateColumn(index, patch)}
                  onInsert={() => addColumn(index + 1)}
                  onRemove={() => removeColumn(index)}
                  onSelect={() => {
                    setAnchor({ row: 0, column: index });
                    setFocus({ row: rows.length - 1, column: index });
                  }}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th
                  scope="row"
                  onClick={() => {
                    setAnchor({ row: rowIndex, column: 0 });
                    setFocus({ row: rowIndex, column: width - 1 });
                  }}
                  className={cx(
                    "sticky left-0 z-10 cursor-pointer select-none border-b border-r border-slate-200 px-1 text-center text-xs font-normal tabular-nums",
                    selection && rowIndex >= selection.top && rowIndex <= selection.bottom ? "bg-brand-100 text-brand-800" : "bg-slate-50 text-slate-500",
                  )}
                  style={{ width: ROW_HEADER_WIDTH }}
                >
                  <span className="group relative inline-flex items-center justify-center">
                    {rowIndex + 1}
                    {!readOnly && rows.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRow(rowIndex);
                        }}
                        title="Delete this row"
                        className="absolute -right-3 hidden text-slate-400 hover:text-red-600 group-hover:block"
                      >
                        ×
                      </button>
                    )}
                  </span>
                </th>
                {columns.map((column, columnIndex) => {
                  const cell = evaluated[rowIndex]?.[columnIndex];
                  const isEditing = editing?.cell.row === rowIndex && editing.cell.column === columnIndex;
                  const isFocus = focus?.row === rowIndex && focus.column === columnIndex;
                  return (
                    <td
                      key={column.id}
                      data-cell={`${rowIndex}-${columnIndex}`}
                      role="gridcell"
                      aria-selected={inSelection(rowIndex, columnIndex)}
                      onMouseDown={(e) => {
                        if (isEditing) return;
                        if (editing) commitEdit("none");
                        const cellRef = { row: rowIndex, column: columnIndex };
                        setFocus(cellRef);
                        if (e.shiftKey) return;
                        setAnchor(cellRef);
                        gridRef.current?.focus();
                      }}
                      onMouseEnter={(e) => {
                        // Dragging with the button held extends the selection.
                        if (e.buttons === 1 && !editing) setFocus({ row: rowIndex, column: columnIndex });
                      }}
                      onDoubleClick={() => startEditing({ row: rowIndex, column: columnIndex })}
                      className={cx(
                        "relative border-b border-r border-slate-200 p-0 align-top",
                        inSelection(rowIndex, columnIndex) && !isFocus && "bg-brand-50",
                        isFocus && "ring-2 ring-inset ring-brand-600",
                      )}
                      style={{ width: column.width ?? DEFAULT_WIDTH, minWidth: 60 }}
                    >
                      {isEditing ? (
                        <input
                          ref={editorRef}
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value, selectAll: false })}
                          onBlur={() => commitEdit("none")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              commitEdit(e.shiftKey ? "up" : "down");
                              e.preventDefault();
                            } else if (e.key === "Tab") {
                              commitEdit(e.shiftKey ? "left" : "right");
                              e.preventDefault();
                            } else if (e.key === "Escape") {
                              setEditing(null);
                              gridRef.current?.focus();
                              e.preventDefault();
                            }
                          }}
                          className="w-full bg-white px-1.5 py-1 font-mono text-xs outline-none"
                        />
                      ) : (
                        <CellView cell={cell} column={column} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500">
        <span>
          {rows.length} row{rows.length === 1 ? "" : "s"} · {columns.length} column{columns.length === 1 ? "" : "s"}
          {selection && (selection.top !== selection.bottom || selection.left !== selection.right) && (
            <SelectionSummary evaluated={evaluated} selection={selection} />
          )}
        </span>
        {!readOnly && <span className="hidden sm:inline">Type to edit · Enter or Tab to move · Ctrl+D fills down · paste from Excel</span>}
      </footer>

      {error && (
        <div className="px-3 pb-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}

/** Sum, average and count of the selected numbers, as a spreadsheet status bar shows. */
function SelectionSummary({
  evaluated,
  selection,
}: {
  evaluated: EvaluatedCell[][];
  selection: { top: number; bottom: number; left: number; right: number };
}) {
  const values: number[] = [];
  for (let row = selection.top; row <= selection.bottom; row++) {
    for (let column = selection.left; column <= selection.right; column++) {
      const value = evaluated[row]?.[column]?.value;
      if (typeof value === "number" && Number.isFinite(value)) values.push(value);
    }
  }
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  const round = (n: number) => Number(n.toPrecision(10));
  return (
    <span className="ml-3 tabular-nums">
      Sum {round(sum)} · Average {round(sum / values.length)} · Count {values.length}
    </span>
  );
}

function CellView({ cell, column }: { cell: EvaluatedCell | undefined; column: TableColumn }) {
  if (!cell) return <div className="px-1.5 py-1">&nbsp;</div>;
  const { value, isFormula } = cell;

  if (isError(value)) {
    return (
      <div title={describeError(value)} className="px-1.5 py-1 font-mono text-xs text-red-600">
        {value.code}
      </div>
    );
  }
  if (column.type === "checkbox") {
    return <div className="px-1.5 py-1 text-center">{value === true ? "✓" : ""}</div>;
  }

  let text = toText(value);
  if (typeof value === "number" && column.decimals !== undefined) text = value.toFixed(column.decimals);
  const numeric = typeof value === "number";

  return (
    <div
      className={cx("truncate px-1.5 py-1", numeric && "text-right tabular-nums", isFormula && "text-slate-900")}
      title={isFormula ? `${cell.raw} = ${text}` : undefined}
    >
      {text || " "}
      {isFormula && <span className="ml-0.5 align-super text-[8px] text-brand-500">fx</span>}
    </div>
  );
}

function ColumnHeader({
  column,
  index,
  readOnly,
  selected,
  onChange,
  onInsert,
  onRemove,
  onSelect,
}: {
  column: TableColumn;
  index: number;
  readOnly?: boolean;
  selected: boolean;
  onChange: (patch: Partial<TableColumn>) => void;
  onInsert: () => void;
  onRemove: () => void;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <th
      scope="col"
      className={cx(
        "relative border-b border-r border-slate-200 px-1.5 py-1 text-left align-bottom text-xs font-semibold",
        selected ? "bg-brand-100 text-brand-900" : "bg-slate-100 text-slate-700",
      )}
      style={{ width: column.width ?? DEFAULT_WIDTH, minWidth: 60 }}
    >
      <div className="flex items-center justify-between gap-1">
        <button onClick={onSelect} className="font-mono text-[10px] font-normal text-slate-400 hover:text-slate-700" title="Select this column">
          {columnLetters(index)}
        </button>
        {!readOnly && (
          <button onClick={() => setOpen((v) => !v)} aria-label={`Options for ${column.name}`} className="text-slate-400 hover:text-slate-700">
            ⌄
          </button>
        )}
      </div>
      <input
        value={column.name}
        disabled={readOnly}
        onChange={(e) => onChange({ name: e.target.value })}
        className="w-full rounded border border-transparent bg-transparent px-0.5 text-xs font-semibold hover:border-slate-300 focus:border-brand-500 focus:bg-white focus:outline-none"
      />
      {column.unit && <span className="block text-[10px] font-normal text-slate-500">{column.unit}</span>}

      {open && !readOnly && (
        <div className="absolute left-0 top-full z-30 mt-1 w-52 rounded-md border border-slate-200 bg-white p-2 text-xs font-normal shadow-lg">
          <label className="mb-1.5 block">
            <span className="text-slate-500">Type</span>
            <select
              value={column.type}
              onChange={(e) => onChange({ type: e.target.value as TableColumn["type"] })}
              className="mt-0.5 w-full rounded border border-slate-300 px-1 py-0.5"
            >
              {["text", "number", "date", "checkbox", "select"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="mb-1.5 block">
            <span className="text-slate-500">Unit</span>
            <input
              value={column.unit ?? ""}
              placeholder="µL, ng/µL, mM"
              onChange={(e) => onChange({ unit: e.target.value })}
              className="mt-0.5 w-full rounded border border-slate-300 px-1 py-0.5"
            />
          </label>
          {column.type === "number" && (
            <label className="mb-1.5 block">
              <span className="text-slate-500">Decimal places</span>
              <input
                type="number"
                min={0}
                max={10}
                value={column.decimals ?? ""}
                onChange={(e) => onChange({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="mt-0.5 w-full rounded border border-slate-300 px-1 py-0.5"
              />
            </label>
          )}
          <div className="mt-2 flex justify-between">
            <button onClick={() => { onInsert(); setOpen(false); }} className="text-brand-600 hover:underline">
              Insert right
            </button>
            <button onClick={() => { onRemove(); setOpen(false); }} className="text-red-600 hover:underline">
              Delete column
            </button>
          </div>
        </div>
      )}
    </th>
  );
}

/** A browsable list of functions, so the formula language is discoverable from the table. */
function FunctionHelp() {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof FUNCTION_DOCS>();
    for (const doc of FUNCTION_DOCS) {
      byGroup.set(doc.group, [...(byGroup.get(doc.group) ?? []), doc]);
    }
    return [...byGroup.entries()];
  }, []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Functions you can use"
        className="rounded border border-slate-300 px-1.5 py-0.5 font-mono text-xs text-slate-600 hover:bg-slate-50"
      >
        fx
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-80 w-80 overflow-auto rounded-md border border-slate-200 bg-white p-3 text-xs shadow-lg">
          {groups.map(([group, docs]) => (
            <div key={group} className="mb-3 last:mb-0">
              <h4 className="mb-1 font-semibold text-slate-700">{group}</h4>
              <ul className="space-y-0.5">
                {docs.map((doc) => (
                  <li key={doc.name} className="flex gap-2">
                    <code className="shrink-0 font-mono text-brand-700">{doc.signature}</code>
                    <span className="text-slate-500">{doc.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
