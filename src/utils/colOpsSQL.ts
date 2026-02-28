import { ColOpType, FilterGroup } from "../types";
import { escapeIdent, buildFilterGroupClause } from "./sqlBuilder";

/**
 * Escape regex metacharacters for use in regexp_replace when useRegex=false.
 */
function escapeRegexMeta(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a SQL expression that extracts all matches of a regex group and
 * joins them with a separator using regexp_extract_all + array_to_string.
 */
export function buildAllMatchesExtractExpr(
  colExpr: string,
  pattern: string,
  groupIdx: string,
  separator: string
): string {
  const sep = separator.replace(/'/g, "''");
  return `array_to_string(regexp_extract_all(${colExpr}, '${pattern}', ${groupIdx || "1"}), '${sep}')`;
}

/**
 * Build an UPDATE SQL for a column operation, optionally scoped by filters.
 */
export function buildColOpUpdateSQL(
  tableName: string,
  column: string,
  opType: ColOpType,
  params: Record<string, string>,
  filters: FilterGroup
): string {
  const col = escapeIdent(column);
  const table = escapeIdent(tableName);
  let setExpr: string;

  switch (opType) {
    case "assign_value": {
      const val = params.value?.replace(/'/g, "''") ?? "";
      setExpr = `'${val}'`;
      break;
    }
    case "find_replace": {
      const useRegex = params.useRegex === "true";
      const pattern = useRegex
        ? params.pattern?.replace(/'/g, "''") ?? ""
        : escapeRegexMeta(params.pattern ?? "").replace(/'/g, "''");
      const replacement = params.replacement?.replace(/'/g, "''") ?? "";
      setExpr = `regexp_replace(CAST(${col} AS VARCHAR), '${pattern}', '${replacement}', 'g')`;
      break;
    }
    case "regex_extract": {
      const pattern = (params.pattern ?? "").replace(/'/g, "''");
      const groupIdx = params.groupIndex ?? "1";
      if (params.allMatches === "true") {
        setExpr = buildAllMatchesExtractExpr(
          `CAST(${col} AS VARCHAR)`,
          pattern,
          groupIdx,
          params.separator ?? ""
        );
      } else {
        setExpr = `regexp_extract(CAST(${col} AS VARCHAR), '${pattern}', ${groupIdx})`;
      }
      break;
    }
    case "extract_numbers": {
      setExpr = `regexp_extract(CAST(${col} AS VARCHAR), '(-?[0-9]+\\.?[0-9]*)', 1)`;
      break;
    }
    case "trim": {
      setExpr = `TRIM(CAST(${col} AS VARCHAR))`;
      break;
    }
    case "upper": {
      setExpr = `UPPER(CAST(${col} AS VARCHAR))`;
      break;
    }
    case "lower": {
      setExpr = `LOWER(CAST(${col} AS VARCHAR))`;
      break;
    }
    case "clear_null": {
      setExpr = "NULL";
      break;
    }
    case "prefix_suffix": {
      const prefix = params.prefix?.replace(/'/g, "''") ?? "";
      const suffix = params.suffix?.replace(/'/g, "''") ?? "";
      setExpr = `'${prefix}' || CAST(${col} AS VARCHAR) || '${suffix}'`;
      break;
    }
    default:
      throw new Error(`Unknown column operation type: ${opType}`);
  }

  let sql = `UPDATE ${table} SET ${col} = ${setExpr}`;

  const whereClause = buildFilterGroupClause(filters);
  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  return sql;
}

/**
 * Build a human-readable description for a column operation step.
 */
export function buildStepDescription(
  opType: ColOpType,
  column: string,
  params: Record<string, string>
): string {
  switch (opType) {
    case "assign_value":
      return `Set "${column}" to "${params.value ?? ""}"`;
    case "find_replace":
      return `Replace "${params.pattern ?? ""}" with "${params.replacement ?? ""}" in "${column}"`;
    case "regex_extract":
      return params.allMatches === "true"
        ? `Regex extract all matches from "${column}"${params.separator ? ` (sep: "${params.separator}")` : ""}`
        : `Regex extract from "${column}"`;
    case "extract_numbers":
      return `Extract numbers from "${column}"`;
    case "trim":
      return `Trim "${column}"`;
    case "upper":
      return `Uppercase "${column}"`;
    case "lower":
      return `Lowercase "${column}"`;
    case "clear_null":
      return `Clear "${column}" to NULL`;
    case "prefix_suffix": {
      const parts: string[] = [];
      if (params.prefix) parts.push(`prefix "${params.prefix}"`);
      if (params.suffix) parts.push(`suffix "${params.suffix}"`);
      return `Add ${parts.join(" and ")} to "${column}"`;
    }
    default:
      return `${opType} on "${column}"`;
  }
}
