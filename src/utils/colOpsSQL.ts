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
 * Build the SET expression for a column operation (without UPDATE wrapper).
 * Used for both UPDATE SQL and live preview queries.
 */
export function buildColOpExpr(
  column: string,
  opType: ColOpType,
  params: Record<string, string>
): string {
  const col = escapeIdent(column);

  switch (opType) {
    case "assign_value": {
      const val = params.value?.replace(/'/g, "''") ?? "";
      return `'${val}'`;
    }
    case "find_replace": {
      const useRegex = params.useRegex === "true";
      const pattern = useRegex
        ? params.pattern?.replace(/'/g, "''") ?? ""
        : escapeRegexMeta(params.pattern ?? "").replace(/'/g, "''");
      const replacement = params.replacement?.replace(/'/g, "''") ?? "";
      return `regexp_replace(CAST(${col} AS VARCHAR), '${pattern}', '${replacement}', 'g')`;
    }
    case "regex_extract": {
      const pattern = (params.pattern ?? "").replace(/'/g, "''");
      const groupIdx = params.groupIndex ?? "1";
      if (params.allMatches === "true") {
        return buildAllMatchesExtractExpr(
          `CAST(${col} AS VARCHAR)`,
          pattern,
          groupIdx,
          params.separator ?? ""
        );
      }
      return `regexp_extract(CAST(${col} AS VARCHAR), '${pattern}', ${groupIdx})`;
    }
    case "extract_numbers": {
      const numMode = params.mode ?? "first";
      const numType = params.numberType ?? "any";
      // Pattern: integers only, floats only (must have decimal), or any number
      const numPattern = numType === "integer"
        ? "(-?[0-9]+)"
        : numType === "float"
          ? "(-?[0-9]+\\.[0-9]+)"
          : "(-?[0-9]+\\.?[0-9]*)";
      if (numMode === "all") {
        const sep = (params.separator ?? ",").replace(/'/g, "''");
        return `array_to_string(regexp_extract_all(CAST(${col} AS VARCHAR), '${numPattern}', 1), '${sep}')`;
      }
      const baseExpr = `regexp_extract(CAST(${col} AS VARCHAR), '${numPattern}', 1)`;
      // Cast to numeric type if requested (TRY_CAST returns NULL on failure)
      if (numType === "integer") return `TRY_CAST(${baseExpr} AS BIGINT)`;
      if (numType === "float") return `TRY_CAST(${baseExpr} AS DOUBLE)`;
      return baseExpr;
    }
    case "trim":
      return `TRIM(CAST(${col} AS VARCHAR))`;
    case "upper":
      return `UPPER(CAST(${col} AS VARCHAR))`;
    case "lower":
      return `LOWER(CAST(${col} AS VARCHAR))`;
    case "clear_null":
      return "NULL";
    case "prefix_suffix": {
      const prefix = params.prefix?.replace(/'/g, "''") ?? "";
      const suffix = params.suffix?.replace(/'/g, "''") ?? "";
      return `'${prefix}' || CAST(${col} AS VARCHAR) || '${suffix}'`;
    }
    default:
      throw new Error(`Unknown column operation type: ${opType}`);
  }
}

/**
 * Build an UPDATE SQL for a column operation, optionally scoped by filters.
 */
export function buildColOpUpdateSQL(
  tableName: string,
  column: string,
  opType: ColOpType,
  params: Record<string, string>,
  filters: FilterGroup,
  targetColumn?: string
): string {
  const table = escapeIdent(tableName);
  const targetCol = targetColumn ? escapeIdent(targetColumn) : escapeIdent(column);
  const setExpr = buildColOpExpr(column, opType, params);

  let sql = `UPDATE ${table} SET ${targetCol} = ${setExpr}`;

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
  params: Record<string, string>,
  targetColumn?: string
): string {
  const targetSuffix = targetColumn && targetColumn !== column ? ` → "${targetColumn}"` : "";
  switch (opType) {
    case "assign_value":
      return `Set "${column}" to "${params.value ?? ""}"${targetSuffix}`;
    case "find_replace":
      return `Replace "${params.pattern ?? ""}" with "${params.replacement ?? ""}" in "${column}"${targetSuffix}`;
    case "regex_extract":
      return params.allMatches === "true"
        ? `Regex extract all matches from "${column}"${params.separator ? ` (sep: "${params.separator}")` : ""}${targetSuffix}`
        : `Regex extract from "${column}"${targetSuffix}`;
    case "extract_numbers": {
      const modeLabel = params.mode === "all" ? "all numbers" : "first number";
      const typeLabel = params.numberType === "integer" ? " (integer)" : params.numberType === "float" ? " (float)" : "";
      return `Extract ${modeLabel}${typeLabel} from "${column}"${targetSuffix}`;
    }
    case "trim":
      return `Trim "${column}"${targetSuffix}`;
    case "upper":
      return `Uppercase "${column}"${targetSuffix}`;
    case "lower":
      return `Lowercase "${column}"${targetSuffix}`;
    case "clear_null":
      return `Clear "${column}" to NULL${targetSuffix}`;
    case "prefix_suffix": {
      const parts: string[] = [];
      if (params.prefix) parts.push(`prefix "${params.prefix}"`);
      if (params.suffix) parts.push(`suffix "${params.suffix}"`);
      return `Add ${parts.join(" and ")} to "${column}"${targetSuffix}`;
    }
    default:
      return `${opType} on "${column}"${targetSuffix}`;
  }
}
