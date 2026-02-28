import React from "react";
import { Button, HTMLSelect, Icon } from "@blueprintjs/core";
import { PivotViewConfig, PivotAggFunction } from "../types";

const AGG_OPTIONS: { value: PivotAggFunction; label: string }[] = [
  { value: "SUM", label: "SUM" },
  { value: "COUNT", label: "COUNT" },
  { value: "COUNT_DISTINCT", label: "COUNT DISTINCT" },
  { value: "AVG", label: "AVG" },
  { value: "MIN", label: "MIN" },
  { value: "MAX", label: "MAX" },
  { value: "MEDIAN", label: "MEDIAN" },
];

interface PivotToolbarProps {
  pivotConfig: PivotViewConfig;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onToggleGrandTotal: () => void;
  onDefaultAggChange: (fn: PivotAggFunction) => void;
  onExitPivot: () => void;
}

export function PivotToolbar({
  pivotConfig,
  onExpandAll,
  onCollapseAll,
  onToggleGrandTotal,
  onDefaultAggChange,
  onExitPivot,
}: PivotToolbarProps): React.ReactElement {
  return (
    <div className="pivot-toolbar">
      <Button
        icon="cross"
        minimal
        small
        onClick={onExitPivot}
        title="Exit pivot view"
        className="pivot-toolbar-exit"
      />
      <span className="pivot-toolbar-label">Pivot View</span>
      {pivotConfig.groupColumns.length > 0 && (
        <div className="pivot-toolbar-breadcrumb">
          {pivotConfig.groupColumns.map((gc, i) => (
            <React.Fragment key={gc.column}>
              {i > 0 && <Icon icon="chevron-right" size={10} className="pivot-breadcrumb-sep" />}
              <span className="pivot-breadcrumb-item">
                {gc.column}
                <Icon
                  icon={gc.direction === "ASC" ? "chevron-up" : "chevron-down"}
                  size={10}
                />
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="pivot-toolbar-spacer" />
      <Button
        icon="expand-all"
        minimal
        small
        onClick={onExpandAll}
        title="Expand all groups"
      />
      <Button
        icon="collapse-all"
        minimal
        small
        onClick={onCollapseAll}
        title="Collapse all groups"
      />
      <Button
        icon="panel-stats"
        minimal
        small
        active={pivotConfig.showGrandTotal}
        onClick={onToggleGrandTotal}
        title="Toggle grand total row"
      />
      <HTMLSelect
        value={pivotConfig.defaultAggFunction}
        onChange={(e) => onDefaultAggChange(e.target.value as PivotAggFunction)}
        options={AGG_OPTIONS}
        minimal
        className="pivot-toolbar-agg-select"
      />
    </div>
  );
}
