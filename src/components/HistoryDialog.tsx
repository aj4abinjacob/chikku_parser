import React, { useState, useCallback } from "react";
import {
  Alert,
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Intent,
  ProgressBar,
  Spinner,
  Tag,
} from "@blueprintjs/core";
import { LoadedTable, TableHistory, HistoryEntry, HistoryOpSource } from "../types";

interface HistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  tables: LoadedTable[];
  activeTable: string | null;
  histories: Map<string, TableHistory>;
  onRevertToEntry: (tableName: string, entryId: number, onProgress?: (step: number, total: number, description: string) => void) => Promise<void>;
  onExportHistory: () => void;
  onImportHistory: () => void;
}

const SOURCE_LABELS: Record<HistoryOpSource, string> = {
  col_op: "Column Op",
  row_op: "Row Op",
  data_op: "Data Op",
  cell_edit: "Cell Edit",
};

const SOURCE_INTENTS: Record<HistoryOpSource, Intent> = {
  col_op: Intent.PRIMARY,
  row_op: Intent.SUCCESS,
  data_op: Intent.WARNING,
  cell_edit: Intent.NONE,
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ReplayProgress {
  step: number;
  total: number;
  description: string;
}

export function HistoryDialog({
  isOpen,
  onClose,
  tables,
  activeTable,
  histories,
  onRevertToEntry,
  onExportHistory,
  onImportHistory,
}: HistoryDialogProps): React.ReactElement {
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [revertTarget, setRevertTarget] = useState<{ tableName: string; entry: HistoryEntry } | null>(null);
  const [replayTarget, setReplayTarget] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [replayProgress, setReplayProgress] = useState<ReplayProgress | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Track which step index is currently being replayed (for highlighting)
  const [activeStepIdx, setActiveStepIdx] = useState<number | null>(null);

  // On dialog open, select the active table
  React.useEffect(() => {
    if (isOpen) {
      setSelectedTable(activeTable);
      setRevertError(null);
      setReplayProgress(null);
      setSuccessMessage(null);
      setActiveStepIdx(null);
    }
  }, [isOpen, activeTable]);

  const currentHistory = selectedTable ? histories.get(selectedTable) : undefined;
  const isGenerated = currentHistory?.sourceInfo.isGenerated ?? false;

  const progressCallback = useCallback((step: number, total: number, description: string) => {
    setReplayProgress({ step, total, description });
    // step is 1-indexed; step 0 means "re-reading file"
    setActiveStepIdx(step === 0 ? -1 : step - 1);
  }, []);

  const handleRevertConfirm = useCallback(async () => {
    if (!revertTarget) return;
    setReverting(true);
    setRevertError(null);
    setSuccessMessage(null);
    setReplayProgress(null);
    try {
      await onRevertToEntry(revertTarget.tableName, revertTarget.entry.id, progressCallback);
      const stepCount = revertTarget.entry.id === -1
        ? 0
        : (histories.get(revertTarget.tableName)?.entries.filter((e) => e.id <= revertTarget.entry.id).length ?? 0);
      setRevertTarget(null);
      setReplayProgress(null);
      setActiveStepIdx(null);
      if (revertTarget.entry.id === -1) {
        setSuccessMessage("Reverted to original file successfully.");
      } else {
        setSuccessMessage(`Reverted to step "${revertTarget.entry.description}" (${stepCount} operation${stepCount !== 1 ? "s" : ""} replayed).`);
      }
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : String(err));
      setReplayProgress(null);
      setActiveStepIdx(null);
    } finally {
      setReverting(false);
    }
  }, [revertTarget, onRevertToEntry, histories, progressCallback]);

  const handleReplayConfirm = useCallback(async () => {
    if (!replayTarget) return;
    const history = histories.get(replayTarget);
    if (!history || history.entries.length === 0) return;
    const totalOps = history.entries.length;
    setReverting(true);
    setRevertError(null);
    setSuccessMessage(null);
    setReplayProgress(null);
    try {
      const lastEntry = history.entries[history.entries.length - 1];
      await onRevertToEntry(replayTarget, lastEntry.id, progressCallback);
      setReplayTarget(null);
      setReplayProgress(null);
      setActiveStepIdx(null);
      setSuccessMessage(`All ${totalOps} operation${totalOps !== 1 ? "s" : ""} applied successfully.`);
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : String(err));
      setReplayProgress(null);
      setActiveStepIdx(null);
    } finally {
      setReverting(false);
    }
  }, [replayTarget, histories, onRevertToEntry, progressCallback]);

  // Tables that have history
  const tablesWithHistory = tables.filter((t) => {
    const h = histories.get(t.tableName);
    return h && h.entries.length > 0;
  });

  // Also include selected table even if no history
  const displayTables = tables.filter((t) => {
    const h = histories.get(t.tableName);
    return (h && h.entries.length > 0) || t.tableName === selectedTable;
  });

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Operation History"
      icon="history"
      style={{ width: 720, maxWidth: "92vw" }}
      canOutsideClickClose={false}
    >
      <DialogBody>
        <div className="ghist-body">
          {/* Left: table list */}
          <div className="ghist-table-list">
            {displayTables.length === 0 && (
              <div className="ghist-empty-tables">No files loaded</div>
            )}
            {displayTables.map((t) => {
              const h = histories.get(t.tableName);
              const entryCount = h?.entries.length ?? 0;
              return (
                <div
                  key={t.tableName}
                  className={`ghist-table-item${t.tableName === selectedTable ? " active" : ""}`}
                  onClick={() => {
                    setSelectedTable(t.tableName);
                    setSuccessMessage(null);
                    setRevertError(null);
                  }}
                >
                  <span className="ghist-table-name">{t.tableName}</span>
                  {entryCount > 0 && (
                    <Tag minimal round className="ghist-table-count">{entryCount}</Tag>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right: timeline */}
          <div className="ghist-timeline-area">
            {!selectedTable && (
              <div className="ghist-empty-state">Select a table to view its history</div>
            )}

            {selectedTable && isGenerated && (
              <Callout
                intent={Intent.WARNING}
                icon="info-sign"
                className="ghist-generated-warning"
              >
                This is a generated table. Revert is not available for generated tables.
              </Callout>
            )}

            {selectedTable && currentHistory && currentHistory.entries.length === 0 && (
              <div className="ghist-empty-state">No operations recorded for this table</div>
            )}

            {selectedTable && currentHistory && currentHistory.entries.length > 0 && (
              <div className="ghist-timeline">
                {!isGenerated && (
                  <div className="ghist-replay-header">
                    <span className="ghist-replay-label">
                      {currentHistory.entries.length} operation{currentHistory.entries.length !== 1 ? "s" : ""}
                    </span>
                    <Button
                      small
                      intent={Intent.PRIMARY}
                      icon="play"
                      text="Replay All"
                      title="Re-read source file and replay all operations"
                      onClick={() => {
                        setSuccessMessage(null);
                        setRevertError(null);
                        setReplayTarget(selectedTable);
                      }}
                      disabled={reverting}
                    />
                  </div>
                )}
                <div className={`ghist-entry ghist-entry-initial${activeStepIdx === -1 ? " ghist-entry-active" : ""}`}>
                  <div className="ghist-entry-step">
                    {activeStepIdx === -1 ? <Spinner size={14} /> : "0"}
                  </div>
                  <div className="ghist-entry-content">
                    <span className="ghist-entry-desc">File loaded</span>
                    <span className="ghist-entry-meta">
                      {currentHistory.initialSchema.length} columns
                    </span>
                  </div>
                  {!isGenerated && currentHistory.entries.length > 0 && !reverting && (
                    <Button
                      small
                      minimal
                      intent={Intent.DANGER}
                      icon="undo"
                      className="ghist-revert-btn"
                      title="Revert to original file (undo all operations)"
                      onClick={() => {
                        setSuccessMessage(null);
                        setRevertError(null);
                        setRevertTarget({
                          tableName: selectedTable,
                          entry: { id: -1, source: "data_op", description: "", timestamp: 0, sqlStatements: [] },
                        });
                      }}
                    />
                  )}
                </div>
                {currentHistory.entries.map((entry, idx) => {
                  const isActive = activeStepIdx !== null && activeStepIdx === idx;
                  const isDone = activeStepIdx !== null && activeStepIdx > idx;
                  return (
                    <div key={entry.id} className={`ghist-entry${isActive ? " ghist-entry-active" : ""}${isDone ? " ghist-entry-done" : ""}`}>
                      <div className="ghist-entry-step">
                        {isActive ? (
                          <Spinner size={14} />
                        ) : isDone ? (
                          <Icon icon="tick" size={12} intent={Intent.SUCCESS} />
                        ) : (
                          idx + 1
                        )}
                      </div>
                      <div className="ghist-entry-content">
                        <Tag
                          minimal
                          intent={SOURCE_INTENTS[entry.source]}
                          className="ghist-entry-badge"
                        >
                          {SOURCE_LABELS[entry.source]}
                        </Tag>
                        <span className="ghist-entry-desc">{entry.description}</span>
                        <span className="ghist-entry-time">{formatRelativeTime(entry.timestamp)}</span>
                      </div>
                      {!isGenerated && !reverting && (
                        <Button
                          small
                          minimal
                          intent={Intent.DANGER}
                          icon="undo"
                          className="ghist-revert-btn"
                          title={`Revert to this step (undo steps after #${idx + 1})`}
                          onClick={() => {
                            setSuccessMessage(null);
                            setRevertError(null);
                            setRevertTarget({ tableName: selectedTable, entry });
                          }}
                          disabled={idx === currentHistory.entries.length - 1 && currentHistory.entries.length === 1}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Progress bar during replay */}
            {replayProgress && replayProgress.total > 0 && (
              <div className="ghist-progress-bar-area">
                <ProgressBar
                  intent={Intent.PRIMARY}
                  value={replayProgress.step / replayProgress.total}
                  stripes={true}
                  animate={true}
                />
                <span className="ghist-progress-text">
                  Step {replayProgress.step} of {replayProgress.total}: {replayProgress.description}
                </span>
              </div>
            )}

            {replayProgress && replayProgress.total === 0 && (
              <div className="ghist-replay-status">
                <Spinner size={16} />
                <span>{replayProgress.description}</span>
              </div>
            )}

            {/* Success message */}
            {successMessage && (
              <Callout intent={Intent.SUCCESS} icon="tick-circle" className="ghist-success-msg">
                {successMessage}
              </Callout>
            )}

            {/* Error message */}
            {revertError && (
              <Callout intent={Intent.DANGER} icon="error" className="ghist-error-msg">
                {revertError}
              </Callout>
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <div className="ghist-footer">
            <div className="ghist-footer-left">
              <Button
                icon="export"
                text="Save History"
                onClick={onExportHistory}
                small
                disabled={tablesWithHistory.length === 0}
              />
              <Button
                icon="import"
                text="Load History"
                onClick={onImportHistory}
                small
              />
            </div>
            <Button text="Close" onClick={onClose} />
          </div>
        }
      />

      {/* Revert confirmation */}
      <Alert
        isOpen={revertTarget !== null && !reverting}
        onConfirm={handleRevertConfirm}
        onCancel={() => setRevertTarget(null)}
        cancelButtonText="Cancel"
        confirmButtonText="Revert"
        intent={Intent.DANGER}
        icon="undo"
        loading={reverting}
      >
        {revertTarget && (
          <>
            <p>
              <strong>Revert "{revertTarget.tableName}"</strong>
              {revertTarget.entry.id === -1
                ? " to original file (undo all operations)?"
                : ` to step "${revertTarget.entry.description}"?`}
            </p>
            <p>
              This will re-read the source file and replay operations up to the selected point.
              Any undo history (Column Ops / Row Ops backups) will be cleared.
            </p>
          </>
        )}
      </Alert>

      {/* Replay All confirmation */}
      <Alert
        isOpen={replayTarget !== null && !reverting}
        onConfirm={handleReplayConfirm}
        onCancel={() => setReplayTarget(null)}
        cancelButtonText="Cancel"
        confirmButtonText="Replay All"
        intent={Intent.PRIMARY}
        icon="play"
        loading={reverting}
      >
        {replayTarget && (
          <>
            <p>
              <strong>Replay all operations on "{replayTarget}"?</strong>
            </p>
            <p>
              This will re-read the source file and replay all {histories.get(replayTarget)?.entries.length ?? 0} recorded
              operation{(histories.get(replayTarget)?.entries.length ?? 0) !== 1 ? "s" : ""} in order.
              Any existing undo history will be cleared.
            </p>
          </>
        )}
      </Alert>
    </Dialog>
  );
}
