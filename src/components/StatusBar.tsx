import React from "react";
import { PivotViewConfig } from "../types";

interface StatusBarProps {
  totalRows: number;
  unfilteredRows: number | null;
  activeTable: string | null;
  tableCount: number;
  pivotConfig?: PivotViewConfig | null;
}

export function StatusBar({
  totalRows,
  unfilteredRows,
  activeTable,
  tableCount,
  pivotConfig,
}: StatusBarProps): React.ReactElement {
  const isFiltered = unfilteredRows !== null && totalRows !== unfilteredRows;
  const rowsDisplay = isFiltered
    ? `${totalRows.toLocaleString()} of ${unfilteredRows!.toLocaleString()} rows`
    : `${totalRows.toLocaleString()} rows`;

  const pivotDisplay =
    pivotConfig && pivotConfig.groupColumns.length > 0
      ? ` | Grouped by: ${pivotConfig.groupColumns.map((gc) => gc.column).join(" > ")}`
      : "";

  return (
    <div className="status-bar">
      <span>
        {activeTable
          ? `${activeTable} | ${rowsDisplay}${pivotDisplay} | ${tableCount} table(s) loaded`
          : "No table selected"}
      </span>
    </div>
  );
}
