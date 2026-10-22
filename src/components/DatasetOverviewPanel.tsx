import React from "react";
import { Button, Icon, Spinner } from "@blueprintjs/core";
import { ColumnInfo, ColumnStatsTopValue, DatasetOverview, LoadedTable } from "../types";
import { SoftSelect } from "./SoftSelect";

interface DatasetOverviewPanelProps {
  table: LoadedTable;
  schema: ColumnInfo[];
  onGetOverview: () => Promise<DatasetOverview>;
  onGetTopValues: (column: string) => Promise<ColumnStatsTopValue[]>;
}

type TypeGroup = "Number" | "Text" | "Date & time" | "Boolean" | "Other";

const TYPE_GROUPS: Array<{ label: TypeGroup; className: string }> = [
  { label: "Number", className: "is-number" },
  { label: "Text", className: "is-text" },
  { label: "Date & time", className: "is-date" },
  { label: "Boolean", className: "is-boolean" },
  { label: "Other", className: "is-other" },
];

function classifyType(columnType: string): TypeGroup {
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i.test(columnType)) {
    return "Number";
  }
  if (/^(DATE|TIME|TIMESTAMP|INTERVAL)/i.test(columnType)) return "Date & time";
  if (/^BOOLEAN/i.test(columnType)) return "Boolean";
  if (/^(VARCHAR|CHAR|BPCHAR|TEXT|STRING|UUID)/i.test(columnType)) return "Text";
  return "Other";
}

function formatNumber(value: number): string {
  if (Math.abs(value) < 10_000) return value.toLocaleString();
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number): string {
  if (value > 99 && value < 100) return `${value.toFixed(1)}%`;
  if (value === 0 || value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

function getDisplayFileName(table: LoadedTable): string {
  if (table.filePath.startsWith("(")) return table.tableName;
  return table.filePath.split(/[/\\]/).pop() || table.tableName;
}

function chooseDistributionColumn(overview: DatasetOverview): string {
  const populated = overview.columns.filter((column) => (
    column.uniqueCount > 1 && column.missingCount < overview.rowCount
  ));
  const usefulCardinalityLimit = Math.max(12, Math.min(100, overview.rowCount * 0.25));
  const categorical = populated.find((column) => (
    classifyType(column.columnType) !== "Number" && column.uniqueCount <= usefulCardinalityLimit
  ));
  if (categorical) return categorical.column;

  const lowCardinality = populated.find((column) => column.uniqueCount <= usefulCardinalityLimit);
  if (lowCardinality) return lowCardinality.column;

  const firstText = populated.find((column) => classifyType(column.columnType) === "Text");
  return firstText?.column ?? populated[0]?.column ?? overview.columns[0]?.column ?? "";
}

export function DatasetOverviewPanel({
  table,
  schema,
  onGetOverview,
  onGetTopValues,
}: DatasetOverviewPanelProps): React.ReactElement {
  const [overview, setOverview] = React.useState<DatasetOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedColumn, setSelectedColumn] = React.useState("");
  const [topValues, setTopValues] = React.useState<ColumnStatsTopValue[]>([]);
  const [distributionLoading, setDistributionLoading] = React.useState(false);
  const [distributionError, setDistributionError] = React.useState(false);
  const overviewRequestId = React.useRef(0);
  const distributionRequestId = React.useRef(0);

  const loadOverview = React.useCallback(() => {
    const requestId = overviewRequestId.current + 1;
    overviewRequestId.current = requestId;
    setLoading(true);
    setError(null);

    onGetOverview()
      .then((nextOverview) => {
        if (overviewRequestId.current !== requestId) return;
        setOverview(nextOverview);
        setSelectedColumn((current) => (
          nextOverview.columns.some((column) => column.column === current)
            ? current
            : chooseDistributionColumn(nextOverview)
        ));
        setLoading(false);
      })
      .catch((err) => {
        if (overviewRequestId.current !== requestId) return;
        setError(err instanceof Error ? err.message : "Unable to load the data overview");
        setLoading(false);
      });
  }, [onGetOverview]);

  React.useEffect(() => {
    loadOverview();
    return () => {
      overviewRequestId.current += 1;
    };
  }, [loadOverview]);

  React.useEffect(() => {
    if (!selectedColumn || !overview || overview.rowCount === 0) {
      setTopValues([]);
      return;
    }

    const requestId = distributionRequestId.current + 1;
    distributionRequestId.current = requestId;
    setDistributionLoading(true);
    setDistributionError(false);
    onGetTopValues(selectedColumn)
      .then((values) => {
        if (distributionRequestId.current !== requestId) return;
        setTopValues(values);
        setDistributionLoading(false);
      })
      .catch(() => {
        if (distributionRequestId.current !== requestId) return;
        setTopValues([]);
        setDistributionLoading(false);
        setDistributionError(true);
      });

    return () => {
      distributionRequestId.current += 1;
    };
  }, [onGetTopValues, overview, selectedColumn]);

  if (loading && !overview) {
    return (
      <div className="dataset-overview dataset-overview-state">
        <Spinner size={22} />
        <strong>Profiling the dataset</strong>
        <span>Checking completeness and value patterns…</span>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="dataset-overview dataset-overview-state is-error">
        <Icon icon="warning-sign" size={18} />
        <strong>Summary unavailable</strong>
        <span>{error}</span>
        <Button small icon="refresh" text="Try again" onClick={loadOverview} />
      </div>
    );
  }

  if (!overview) return <div className="dataset-overview" />;

  const totalCells = overview.rowCount * overview.columns.length;
  const missingCells = overview.columns.reduce((sum, column) => sum + column.missingCount, 0);
  const completeCells = Math.max(0, totalCells - missingCells);
  const completeness = totalCells > 0 ? (completeCells / totalCells) * 100 : 100;
  const missingColumns = overview.columns
    .filter((column) => column.missingCount > 0)
    .sort((a, b) => b.missingCount - a.missingCount);
  const completeColumns = overview.columns.length - missingColumns.length;
  const highCardinalityColumns = overview.rowCount > 1
    ? overview.columns.filter((column) => column.uniqueCount / overview.rowCount >= 0.95).length
    : 0;
  const typeCounts = TYPE_GROUPS.map((group) => ({
    ...group,
    count: schema.filter((column) => classifyType(column.column_type) === group.label).length,
  })).filter((group) => group.count > 0);
  const selectedStats = overview.columns.find((column) => column.column === selectedColumn) ?? null;
  const selectedPresentCount = selectedStats
    ? Math.max(0, overview.rowCount - selectedStats.missingCount)
    : 0;
  const shownValueCount = topValues.reduce((sum, value) => sum + value.count, 0);
  const otherValueCount = Math.max(0, selectedPresentCount - shownValueCount);
  const distributionValues = otherValueCount > 0
    ? [...topValues, { value: "Other", count: otherValueCount }]
    : topValues;
  const ringStyle = {
    "--dataset-completeness": `${Math.max(0, Math.min(100, completeness)) * 3.6}deg`,
  } as React.CSSProperties;

  return (
    <div className="dataset-overview">
      <div className="dataset-overview-titlebar">
        <div className="dataset-overview-title">
          <span>Data overview</span>
          <strong title={getDisplayFileName(table)}>{getDisplayFileName(table)}</strong>
        </div>
        <Button
          minimal
          small
          icon="refresh"
          title="Refresh overview"
          aria-label="Refresh overview"
          loading={loading}
          onClick={loadOverview}
        />
      </div>

      {overview.isFiltered && (
        <div className="dataset-overview-filter-note">
          <Icon icon="filter" size={11} />
          <span>Showing the filtered view</span>
        </div>
      )}

      <div className="dataset-overview-metrics">
        <div className="dataset-overview-metric">
          <span>Rows</span>
          <strong>{formatNumber(overview.rowCount)}</strong>
          {overview.isFiltered && <small>of {formatNumber(overview.totalRows)}</small>}
        </div>
        <div className="dataset-overview-metric">
          <span>Columns</span>
          <strong>{formatNumber(overview.columns.length)}</strong>
          <small>{typeCounts.length} data type{typeCounts.length === 1 ? "" : "s"}</small>
        </div>
      </div>

      {overview.rowCount === 0 ? (
        <section className="dataset-overview-card dataset-overview-empty">
          <span className="dataset-overview-empty-icon">
            <Icon icon="search" size={17} />
          </span>
          <strong>No rows to profile</strong>
          <span>
            {overview.isFiltered
              ? "Adjust the active filters to bring rows back into view."
              : "This dataset has columns, but it does not contain any rows."}
          </span>
        </section>
      ) : (
        <>
      <section className="dataset-overview-card dataset-overview-health">
        <div className="dataset-overview-ring" style={ringStyle} aria-label={`${formatPercent(completeness)} complete`}>
          <div>
            <strong>{formatPercent(completeness)}</strong>
            <span>complete</span>
          </div>
        </div>
        <div className="dataset-overview-health-copy">
          <span className="dataset-overview-eyebrow">Dataset health</span>
          <strong>{missingCells === 0 ? "Ready to explore" : `${formatNumber(missingCells)} missing value${missingCells === 1 ? "" : "s"}`}</strong>
          <span>{completeColumns} of {overview.columns.length} columns are complete</span>
        </div>
      </section>

      <section className="dataset-overview-card">
        <div className="dataset-overview-section-heading">
          <div>
            <span className="dataset-overview-eyebrow">Structure</span>
            <strong>Data type mix</strong>
          </div>
        </div>
        <div className="dataset-type-bar" aria-label="Column type distribution">
          {typeCounts.map((group) => (
            <span
              key={group.label}
              className={group.className}
              style={{ flexGrow: group.count }}
              title={`${group.label}: ${group.count}`}
            />
          ))}
        </div>
        <div className="dataset-type-legend">
          {typeCounts.map((group) => (
            <div key={group.label}>
              <span className={`dataset-type-dot ${group.className}`} />
              <span>{group.label}</span>
              <strong>{group.count}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="dataset-overview-signals" aria-label="Column signals">
        <div>
          <Icon icon="tick-circle" size={13} />
          <strong>{completeColumns}</strong>
          <span>complete</span>
        </div>
        <div className={missingColumns.length > 0 ? "has-warning" : ""}>
          <Icon icon="error" size={13} />
          <strong>{missingColumns.length}</strong>
          <span>with gaps</span>
        </div>
        <div>
          <Icon icon="key" size={13} />
          <strong>{highCardinalityColumns}</strong>
          <span>high-cardinality</span>
        </div>
      </div>

      <section className="dataset-overview-card">
        <div className="dataset-overview-section-heading">
          <div>
            <span className="dataset-overview-eyebrow">Completeness</span>
            <strong>{missingColumns.length > 0 ? "Columns needing attention" : "No gaps found"}</strong>
          </div>
          {missingColumns.length > 0 && <small>Top {Math.min(5, missingColumns.length)}</small>}
        </div>
        {missingColumns.length === 0 ? (
          <div className="dataset-overview-clean">
            <Icon icon="tick-circle" size={15} />
            <span>Every column has a value in every row.</span>
          </div>
        ) : (
          <div className="dataset-missing-list">
            {missingColumns.slice(0, 5).map((column) => {
              const percent = overview.rowCount > 0 ? (column.missingCount / overview.rowCount) * 100 : 0;
              return (
                <div className="dataset-missing-row" key={column.column}>
                  <div>
                    <strong title={column.column}>{column.column}</strong>
                    <span>{formatPercent(percent)}</span>
                  </div>
                  <div className="dataset-missing-track">
                    <span style={{ width: `${Math.max(1.5, Math.min(100, percent))}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {overview.columns.length > 0 && (
        <section className="dataset-overview-card dataset-distribution-card">
          <div className="dataset-overview-section-heading">
            <div>
              <span className="dataset-overview-eyebrow">Distribution</span>
              <strong>Most common values</strong>
            </div>
          </div>
          <SoftSelect
            value={selectedColumn}
            onChange={(event) => setSelectedColumn(event.target.value)}
            options={overview.columns.map((column) => ({
              value: column.column,
              label: column.column,
            }))}
            fill
            small
            aria-label="Choose a column for the value distribution"
            popoverClassName="dataset-overview-column-popover"
          />
          {distributionLoading ? (
            <div className="dataset-distribution-state">
              <Spinner size={16} />
              <span>Loading values…</span>
            </div>
          ) : distributionError ? (
            <div className="dataset-distribution-state is-error">
              <Icon icon="warning-sign" size={13} />
              <span>Could not load this distribution.</span>
            </div>
          ) : distributionValues.length === 0 ? (
            <div className="dataset-distribution-state">
              <span>No populated values in this column.</span>
            </div>
          ) : (
            <div className="dataset-distribution-list">
              {distributionValues.map((value) => {
                const percent = selectedPresentCount > 0 ? (value.count / selectedPresentCount) * 100 : 0;
                return (
                  <div className="dataset-distribution-row" key={value.value}>
                    <div>
                      <strong title={value.value}>{value.value || "Empty string"}</strong>
                      <span>{formatPercent(percent)}</span>
                    </div>
                    <div className="dataset-distribution-track">
                      <span style={{ width: `${Math.max(1.5, Math.min(100, percent))}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
        </>
      )}
    </div>
  );
}
