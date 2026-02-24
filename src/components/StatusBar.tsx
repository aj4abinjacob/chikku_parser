import React from "react";

interface StatusBarProps {
  totalRows: number;
  unfilteredRows: number | null;
  activeTable: string | null;
  tableCount: number;
}

export function StatusBar({
  totalRows,
  unfilteredRows,
  activeTable,
  tableCount,
}: StatusBarProps): React.ReactElement {
  const isFiltered = unfilteredRows !== null && totalRows !== unfilteredRows;
  const rowsDisplay = isFiltered
    ? `${totalRows.toLocaleString()} of ${unfilteredRows!.toLocaleString()} rows`
    : `${totalRows.toLocaleString()} rows`;

  return (
    <div className="status-bar">
      <span>
        {activeTable
          ? `${activeTable} | ${rowsDisplay} | ${tableCount} table(s) loaded`
          : "No table selected"}
      </span>
    </div>
  );
}
