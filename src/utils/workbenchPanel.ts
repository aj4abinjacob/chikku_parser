export type WorkbenchTab = "filters" | "colops" | "rowops" | "qc";
export interface WorkbenchRequest { tab: WorkbenchTab; key: number; }
export type WorkbenchHeights = Partial<Record<WorkbenchTab, number>>;

/** Reserve 180px for the table when space permits, with a usable minimum for the workbench. */
export function getWorkbenchHeightLimits(availableHeight: number): { min: number; max: number } {
  const max = Math.min(500, Math.max(120, Math.floor(availableHeight - 180)));
  return { min: Math.min(180, max), max };
}

export function getWorkbenchPanelHeight(
  tab: WorkbenchTab,
  filterRows: number,
  availableHeight: number,
  manualHeight?: number
): number {
  const { min, max } = getWorkbenchHeightLimits(availableHeight);
  const preferred = manualHeight ?? (tab === "filters"
    ? 210 + Math.max(0, filterRows - 1) * 38
    : tab === "qc" ? 340 : 300);
  return Math.min(max, Math.max(min, preferred));
}
