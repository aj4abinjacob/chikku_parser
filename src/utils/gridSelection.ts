export interface GridCell {
  row: number;
  col: string;
}

export function cellKey(row: number, col: string): string {
  return `${row}:${col}`;
}

export function buildCellRange(columns: string[], from: GridCell, to: GridCell): Set<string> {
  const fromCol = columns.indexOf(from.col);
  const toCol = columns.indexOf(to.col);
  const selected = new Set<string>();
  if (fromCol < 0 || toCol < 0) return selected;

  for (let row = Math.min(from.row, to.row); row <= Math.max(from.row, to.row); row++) {
    for (let col = Math.min(fromCol, toCol); col <= Math.max(fromCol, toCol); col++) {
      selected.add(cellKey(row, columns[col]));
    }
  }
  return selected;
}

export function getSelectionText(
  selected: Set<string>,
  columns: string[],
  getCellText: (row: number, col: string) => string
): string {
  const visibleColumns = new Set(columns);
  const cells = [...selected].map((key) => {
    const separator = key.indexOf(":");
    return { row: Number(key.slice(0, separator)), col: key.slice(separator + 1) };
  }).filter((cell) => visibleColumns.has(cell.col));
  const rows = [...new Set(cells.map((cell) => cell.row))].sort((a, b) => a - b);
  const selectedColumns = new Set(cells.map((cell) => cell.col));
  const orderedColumns = columns.filter((column) => selectedColumns.has(column));

  return rows.map((row) => orderedColumns.map((col) => (
    selected.has(cellKey(row, col)) ? getCellText(row, col) : ""
  )).join("\t")).join("\n");
}
