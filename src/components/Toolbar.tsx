import React from "react";
import { Button, Intent } from "@blueprintjs/core";

interface ToolbarProps {
  tableCount: number;
  onCombine: () => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

export function Toolbar({
  tableCount,
  onCombine,
  sidebarVisible,
  onToggleSidebar,
}: ToolbarProps): React.ReactElement {
  return (
    <div className="toolbar">
      <Button
        icon={sidebarVisible ? "panel-stats" : "panel-stats"}
        onClick={onToggleSidebar}
        small
        minimal
        title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
      />
      {tableCount >= 2 && (
        <Button
          intent={Intent.PRIMARY}
          icon="merge-columns"
          text={`Combine ${tableCount} Tables`}
          onClick={onCombine}
          small
        />
      )}
    </div>
  );
}
