import { GridCell } from "./gridSelection";

export const COMPACT_COLUMN_WIDTH = 150;
export const MAX_FITTED_COLUMN_WIDTH = 420;

export type ColumnWidthPreset = "fit" | "compact";
export interface ColumnWidthPresetState {
  mode: ColumnWidthPreset;
  previousWidths: Record<string, number>;
}

/** Presets share one baseline, so switching modes never replaces the user's widths. */
export function toggleColumnWidthPreset(
  widths: Record<string, number>,
  preset: ColumnWidthPresetState | null,
  mode: ColumnWidthPreset,
  presetWidths: Record<string, number>,
): { widths: Record<string, number>; preset: ColumnWidthPresetState | null } {
  if (preset?.mode === mode) return { widths: { ...preset.previousWidths }, preset: null };
  return {
    widths: { ...widths, ...presetWidths },
    preset: { mode, previousWidths: { ...(preset?.previousWidths ?? widths) } },
  };
}

/** Leave room for header controls, while keeping a wide schema navigable. */
export function initialColumnWidth(column: string, fontSize: number): number {
  return Math.min(340, Math.max(COMPACT_COLUMN_WIDTH, Math.ceil(column.length * fontSize * 0.62 + 72)));
}

/** Include the largest row label, cell padding and border at the row-number font. */
export function gridRowNumberWidth(totalRows: number, fontSize: number): number {
  const digits = String(Math.max(1, Math.floor(totalRows))).length;
  const numberFontSize = Math.max(11, Math.min(22, fontSize - 2));
  return Math.max(50, Math.ceil(digits * numberFontSize * 0.62 + 25));
}

export function fittedColumnWidth(headerWidth: number, sampleWidths: number[]): number {
  const measuredWidth = sampleWidths.reduce((width, sample) => Math.max(width, sample + 24), headerWidth + 72);
  return Math.min(MAX_FITTED_COLUMN_WIDTH, Math.max(COMPACT_COLUMN_WIDTH, Math.ceil(measuredWidth)));
}

export function moveGridCell(cell: GridCell | null, key: string, columns: string[], rowCount: number): GridCell | null {
  if (columns.length === 0 || rowCount === 0) return null;
  if (!cell || !columns.includes(cell.col) || cell.row >= rowCount) return { row: 0, col: columns[0] };
  const col = columns.indexOf(cell.col);
  return {
    row: Math.max(0, Math.min(rowCount - 1, cell.row + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0))),
    col: columns[Math.max(0, Math.min(columns.length - 1, col + (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0)))],
  };
}

/** Inspect raw values without routing wide integers through Number. */
export function rawCellValue(value: unknown): { text: string; kind: string } {
  if (value === null) return { text: "NULL", kind: "Null value" };
  if (value === undefined) return { text: "undefined", kind: "Missing value" };
  if (value === "") return { text: "", kind: "Empty string (0 characters)" };
  if (typeof value === "object") {
    try {
      return { text: JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2), kind: Array.isArray(value) ? "Array" : "Object" };
    } catch {
      return { text: String(value), kind: "Object" };
    }
  }
  return { text: String(value), kind: typeof value === "string" ? `Text (${value.length.toLocaleString()} characters)` : typeof value };
}

export type GridEmptyState = "error" | "hidden-columns" | "loading" | "filtered" | "empty" | null;

export function gridEmptyState(options: { hasError: boolean; columnCount: number; rowCount: number; loading: boolean; filtersActive: boolean }): GridEmptyState {
  // Hiding columns disables queries; recover visibility before retrying a stale failure.
  if (options.columnCount === 0) return "hidden-columns";
  if (options.hasError) return "error";
  if (options.rowCount > 0) return null;
  if (options.loading) return "loading";
  return options.filtersActive ? "filtered" : "empty";
}
