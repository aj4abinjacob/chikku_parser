import { FilterGroup, FilterNode, ViewState, isColumnComparisonOperator, isFilterGroup } from "../types";

export function createDefaultViewState(columns: readonly string[] = []): ViewState {
  return {
    visibleColumns: [...columns],
    columnOrder: [...columns],
    filters: { logic: "AND", children: [] },
    sortColumns: [],
    pivotConfig: null,
  };
}

function mapFilterColumns(group: FilterGroup, mapColumn: (column: string) => string | null): FilterGroup {
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      const nested = mapFilterColumns(child, mapColumn);
      if (nested.children.length > 0) children.push(nested);
      continue;
    }
    const column = mapColumn(child.column);
    if (!column) continue;
    let next = column === child.column ? child : { ...child, column };
    if (isColumnComparisonOperator(child.operator) && child.value) {
      const value = mapColumn(child.value);
      if (!value) continue;
      if (value !== child.value) next = { ...next, value };
    }
    children.push(next);
  }
  return children.length === group.children.length && children.every((child, index) => child === group.children[index])
    ? group
    : { ...group, children };
}

/** Apply explicit renames together, including swaps, before reconciling a schema. */
export function renameViewColumns(view: ViewState, renames: Readonly<Record<string, string>>): ViewState {
  const rename = (column: string) => Object.prototype.hasOwnProperty.call(renames, column) ? renames[column] : column;
  return {
    ...view,
    visibleColumns: view.visibleColumns.map(rename),
    columnOrder: view.columnOrder.map(rename),
    filters: mapFilterColumns(view.filters, rename),
    sortColumns: view.sortColumns.map((sort) => ({ ...sort, column: rename(sort.column) })),
    pivotConfig: view.pivotConfig ? {
      ...view.pivotConfig,
      groupColumns: view.pivotConfig.groupColumns.map((group) => ({ ...group, column: rename(group.column) })),
    } : null,
  };
}

/** Keep surviving preferences; newly introduced columns start visible. */
export function reconcileViewState(view: ViewState, columns: readonly string[]): ViewState {
  const available = new Set(columns);
  const previousColumns = new Set(view.columnOrder);
  const added = columns.filter((column) => !previousColumns.has(column));
  const columnOrder = [...new Set([...view.columnOrder.filter((column) => available.has(column)), ...added])];
  const visible = new Set([...view.visibleColumns.filter((column) => available.has(column)), ...added]);
  const groupColumns = view.pivotConfig?.groupColumns.filter((group) => available.has(group.column)) ?? [];
  const sameColumns = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((column, index) => column === right[index]);
  const nextOrder = sameColumns(columnOrder, view.columnOrder) ? view.columnOrder : columnOrder;
  const visibleColumns = columnOrder.filter((column) => visible.has(column));
  const nextVisible = sameColumns(visibleColumns, view.visibleColumns) ? view.visibleColumns : visibleColumns;
  const filters = mapFilterColumns(view.filters, (column) => available.has(column) ? column : null);
  const sortColumns = view.sortColumns.every((sort) => available.has(sort.column))
    ? view.sortColumns
    : view.sortColumns.filter((sort) => available.has(sort.column));
  const pivotConfig = view.pivotConfig && groupColumns.length > 0
    ? groupColumns.length === view.pivotConfig.groupColumns.length ? view.pivotConfig : { ...view.pivotConfig, groupColumns }
    : null;
  if (nextOrder === view.columnOrder && nextVisible === view.visibleColumns && filters === view.filters
    && sortColumns === view.sortColumns && pivotConfig === view.pivotConfig) return view;
  return { ...view, columnOrder: nextOrder, visibleColumns: nextVisible, filters, sortColumns, pivotConfig };
}

/** An in-memory view belongs to a loaded file, not to the shared grid. */
export class TableViewStore {
  private readonly views = new Map<string, ViewState>();

  get(tableName: string, columns: readonly string[]): ViewState {
    const saved = this.views.get(tableName);
    const view = saved ? reconcileViewState(saved, columns) : createDefaultViewState(columns);
    this.views.set(tableName, view);
    return view;
  }

  update(tableName: string, updater: ViewState | ((current: ViewState) => ViewState)): ViewState {
    const current = this.views.get(tableName) ?? createDefaultViewState();
    const next = typeof updater === "function" ? updater(current) : updater;
    this.views.set(tableName, next);
    return next;
  }

  delete(tableName: string): void {
    this.views.delete(tableName);
  }

  retain(tableNames: readonly string[]): void {
    const keep = new Set(tableNames);
    for (const tableName of this.views.keys()) {
      if (!keep.has(tableName)) this.views.delete(tableName);
    }
  }

  clear(): void {
    this.views.clear();
  }
}

/** Only the latest schema request may update the shared grid. */
export class SchemaRequestGate {
  private generation = 0;

  invalidate(): void {
    this.generation++;
  }

  start(): () => boolean {
    const generation = ++this.generation;
    return () => generation === this.generation;
  }
}
