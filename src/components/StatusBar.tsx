import React from "react";

interface StatusBarProps {
  totalRows: number;
  activeTable: string | null;
  tableCount: number;
}

export function StatusBar({
  totalRows,
  activeTable,
  tableCount,
}: StatusBarProps): React.ReactElement {
  return (
    <div className="status-bar">
      <span>
        {activeTable
          ? `${activeTable} | ${totalRows.toLocaleString()} rows | ${tableCount} table(s) loaded`
          : "No table selected"}
      </span>
    </div>
  );
}
