import React from "react";
import { PivotViewConfig } from "../types";

interface StatusBarProps {
  totalRows: number;
  unfilteredRows: number | null;
  activeTable: string | null;
  pivotConfig?: PivotViewConfig | null;
  groupCount: number;
  filterPanelOpen: boolean;
  onToggleFilterPanel: () => void;
  activeFilterCount: number;
  sidebarVisible: boolean;
}

export function StatusBar({
  totalRows,
  unfilteredRows,
  activeTable,
  pivotConfig,
  groupCount,
  filterPanelOpen,
  onToggleFilterPanel,
  activeFilterCount,
  sidebarVisible,
}: StatusBarProps): React.ReactElement {
  const isFiltered = unfilteredRows !== null && totalRows !== unfilteredRows;
  const rowsDisplay = isFiltered
    ? `${totalRows.toLocaleString()} of ${unfilteredRows!.toLocaleString()} rows`
    : `${totalRows.toLocaleString()} rows`;

  const groupDisplay = groupCount > 0 ? ` | ${groupCount.toLocaleString()} groups` : "";

  const pivotDisplay =
    pivotConfig && pivotConfig.groupColumns.length > 0
      ? ` | Grouped by: ${pivotConfig.groupColumns.map((gc) => gc.column).join(" > ")}`
      : "";

  return (
    <div className="status-bar">
      <span className="status-bar-rows" style={{ marginLeft: "auto" }}>
        {activeTable
          ? `${rowsDisplay}${groupDisplay}${pivotDisplay}`
          : "No table selected"}
      </span>
      {activeTable && (
        <div
          className={`filter-toggle${filterPanelOpen ? " active" : ""}`}
          style={{ left: sidebarVisible ? "var(--sidebar-width)" : "36px" }}
          onClick={onToggleFilterPanel}
        >
          <span className="filter-toggle-label">Filters</span>
          {activeFilterCount > 0 && !filterPanelOpen && (
            <span className="filter-toggle-badge">{activeFilterCount}</span>
          )}
        </div>
      )}
    </div>
  );
}
