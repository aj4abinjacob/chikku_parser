/**
 * Date format detection utility.
 *
 * Classifies date strings and uses a max-value heuristic on numeric dates
 * to determine day vs month position. Falls back to chrono-node for
 * text-month and other non-standard formats.
 */
import * as chrono from "chrono-node";

export type Confidence = "high" | "ambiguous" | "unknown";

export interface DetectionResult {
  /** DuckDB strptime format string, e.g. "%d/%m/%Y" */
  format: string;
  confidence: Confidence;
  /** Alternative formats for ambiguous cases */
  alternatives: string[];
}

type PatternCategory = "iso" | "numeric" | "text-month" | "other";

interface ClassifiedValue {
  category: PatternCategory;
  separator?: string;
  raw: string;
}

// ── Pattern classification ──────────────────────────────────────────

const ISO_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
const NUMERIC_PATTERN = /^(\d{1,2})([/\-.])(\d{1,2})\2(\d{2,4})$/;
const NUMERIC_YEAR_FIRST = /^(\d{4})([/\-.])(\d{1,2})\2(\d{1,2})$/;
const TEXT_MONTH_PATTERN = /[a-zA-Z]{3,}/;

/**
 * Classify a single date string into a pattern category.
 */
export function classifyPattern(value: string): ClassifiedValue {
  const trimmed = value.trim();

  if (ISO_PATTERN.test(trimmed)) {
    return { category: "iso", raw: trimmed };
  }

  const numMatch = trimmed.match(NUMERIC_PATTERN);
  if (numMatch) {
    return { category: "numeric", separator: numMatch[2], raw: trimmed };
  }

  const yearFirstMatch = trimmed.match(NUMERIC_YEAR_FIRST);
  if (yearFirstMatch) {
    return { category: "iso", separator: yearFirstMatch[2], raw: trimmed };
  }

  if (TEXT_MONTH_PATTERN.test(trimmed)) {
    return { category: "text-month", raw: trimmed };
  }

  return { category: "other", raw: trimmed };
}

// ── Numeric date analysis (max-value heuristic) ─────────────────────

interface NumericAnalysis {
  format: string;
  confidence: Confidence;
  alternatives: string[];
}

/**
 * Analyze an array of numeric date strings (e.g. "1/12/20", "15.03.2021")
 * using the max-value heuristic per position.
 *
 * Position layout: pos1<sep>pos2<sep>pos3
 * - If max(pos1) > 12 → pos1 = day, pos2 = month
 * - If max(pos2) > 12 → pos2 = day, pos1 = month
 * - If both ≤ 12 → ambiguous, return both alternatives
 */
export function analyzeNumericDates(
  samples: string[],
  separator: string
): NumericAnalysis {
  let maxPos1 = 0;
  let maxPos2 = 0;
  let yearLen = 0;

  for (const s of samples) {
    const match = s.trim().match(NUMERIC_PATTERN);
    if (!match) continue;
    const p1 = parseInt(match[1], 10);
    const p2 = parseInt(match[3], 10);
    if (p1 > maxPos1) maxPos1 = p1;
    if (p2 > maxPos2) maxPos2 = p2;
    if (!yearLen) yearLen = match[4].length;
  }

  const sepFmt = separator === "." ? "." : separator === "-" ? "-" : "/";
  const yearFmt = yearLen === 4 ? "%Y" : "%y";

  if (maxPos1 > 12 && maxPos2 <= 12) {
    // pos1 is day, pos2 is month
    const fmt = `%d${sepFmt}%m${sepFmt}${yearFmt}`;
    return { format: fmt, confidence: "high", alternatives: [] };
  }

  if (maxPos2 > 12 && maxPos1 <= 12) {
    // pos1 is month, pos2 is day
    const fmt = `%m${sepFmt}%d${sepFmt}${yearFmt}`;
    return { format: fmt, confidence: "high", alternatives: [] };
  }

  if (maxPos1 <= 12 && maxPos2 <= 12) {
    // Ambiguous — both could be day or month
    const dmFmt = `%d${sepFmt}%m${sepFmt}${yearFmt}`;
    const mdFmt = `%m${sepFmt}%d${sepFmt}${yearFmt}`;
    return {
      format: dmFmt,
      confidence: "ambiguous",
      alternatives: [dmFmt, mdFmt],
    };
  }

  // Both > 12 or other weird case → unknown
  return { format: "", confidence: "unknown", alternatives: [] };
}

// ── Text-month detection via chrono-node ────────────────────────────

function detectTextMonthFormat(samples: string[]): DetectionResult {
  // Try parsing a few samples with chrono to see if they're consistent
  let hasDay = false;
  let monthFirst = 0;
  let dayFirst = 0;

  for (const s of samples.slice(0, 20)) {
    const parsed = chrono.parse(s);
    if (parsed.length === 0) continue;

    const comp = parsed[0].start;
    if (comp.isCertain("day")) hasDay = true;

    // Check text structure to determine if month comes first
    const trimmed = s.trim();
    // Patterns like "Jan 12, 2024" or "January 12 2024" → month first
    if (/^[a-zA-Z]/.test(trimmed)) {
      monthFirst++;
    }
    // Patterns like "12 Jan 2024" or "12-Jan-24" → day first
    if (/^\d/.test(trimmed)) {
      dayFirst++;
    }
  }

  if (monthFirst > dayFirst) {
    // "Jan 12, 2024" style → try common formats
    return {
      format: "%b %d, %Y",
      confidence: "high",
      alternatives: ["%b %d, %Y", "%B %d, %Y", "%b %d %Y"],
    };
  }

  if (dayFirst > monthFirst) {
    // "12 Jan 2024" style
    return {
      format: "%d %b %Y",
      confidence: "high",
      alternatives: ["%d %b %Y", "%d-%b-%Y", "%d-%b-%y"],
    };
  }

  return { format: "", confidence: "unknown", alternatives: [] };
}

// ── Main detection function ─────────────────────────────────────────

/**
 * Detect the date format from an array of sample values.
 * Returns a DuckDB-compatible strptime format string.
 */
export function detectDateFormat(samples: string[]): DetectionResult {
  // Filter out empty/null values
  const valid = samples.filter(
    (s) => s != null && s.trim() !== "" && s.trim().toLowerCase() !== "null"
  );

  if (valid.length === 0) {
    return { format: "", confidence: "unknown", alternatives: [] };
  }

  // Classify all values
  const classified = valid.map(classifyPattern);

  // Find the dominant category
  const categoryCounts: Record<PatternCategory, number> = {
    iso: 0,
    numeric: 0,
    "text-month": 0,
    other: 0,
  };
  for (const c of classified) {
    categoryCounts[c.category]++;
  }

  const dominant = (Object.keys(categoryCounts) as PatternCategory[]).reduce(
    (a, b) => (categoryCounts[a] >= categoryCounts[b] ? a : b)
  );

  switch (dominant) {
    case "iso": {
      // ISO is unambiguous: YYYY-MM-DD or YYYY/MM/DD
      const firstIso = classified.find((c) => c.category === "iso");
      const sep = firstIso?.raw.includes("/") ? "/" : "-";
      return {
        format: `%Y${sep}%m${sep}%d`,
        confidence: "high",
        alternatives: [],
      };
    }

    case "numeric": {
      // Get the separator from the first numeric match
      const firstNumeric = classified.find((c) => c.category === "numeric");
      const sep = firstNumeric?.separator || "/";
      const numericSamples = valid.filter((s) => {
        const c = classifyPattern(s);
        return c.category === "numeric";
      });
      return analyzeNumericDates(numericSamples, sep);
    }

    case "text-month": {
      return detectTextMonthFormat(valid);
    }

    default: {
      // Try chrono as last resort
      const firstParsed = chrono.parse(valid[0]);
      if (firstParsed.length > 0) {
        return {
          format: "%Y-%m-%d",
          confidence: "ambiguous",
          alternatives: ["%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y"],
        };
      }
      return { format: "", confidence: "unknown", alternatives: [] };
    }
  }
}

/**
 * Common output date formats for the UI dropdown.
 * Each entry: [label, DuckDB strftime format string]
 */
export const OUTPUT_FORMATS: [string, string][] = [
  ["YYYY-MM-DD", "%Y-%m-%d"],
  ["DD/MM/YYYY", "%d/%m/%Y"],
  ["MM/DD/YYYY", "%m/%d/%Y"],
  ["DD-MM-YYYY", "%d-%m-%Y"],
  ["MM-DD-YYYY", "%m-%d-%Y"],
  ["YYYY/MM/DD", "%Y/%m/%d"],
  ["DD.MM.YYYY", "%d.%m.%Y"],
  ["YYYY-MM-DD HH:MM:SS", "%Y-%m-%d %H:%M:%S"],
];
