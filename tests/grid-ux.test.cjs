const test = require("node:test");
const assert = require("node:assert/strict");
const { COMPACT_COLUMN_WIDTH, fittedColumnWidth, gridEmptyState, gridRowNumberWidth, initialColumnWidth, moveGridCell, rawCellValue, toggleColumnWidthPreset } = require("../.test-dist/utils/gridUX.js");

test("each width preset toggles back to the exact custom widths it replaced", () => {
  const original = { name: 235, notes: 512, hidden: 87 };
  for (const mode of ["fit", "compact"]) {
    const applied = toggleColumnWidthPreset(original, null, mode, { name: 150, notes: 300 });
    assert.deepEqual(applied.widths, { name: 150, notes: 300, hidden: 87 });
    assert.equal(applied.preset.mode, mode);
    const undone = toggleColumnWidthPreset(applied.widths, applied.preset, mode, {});
    assert.deepEqual(undone, { widths: original, preset: null });
    assert.notEqual(undone.widths, original);
  }
});

test("switching width presets keeps the original baseline until the active preset is undone", () => {
  const original = { name: 240, notes: 510, __pivot_group__: 320 };
  const fit = toggleColumnWidthPreset(original, null, "fit", { name: 310, notes: 420, __pivot_group__: 275 });
  const compact = toggleColumnWidthPreset(fit.widths, fit.preset, "compact", { name: 150, notes: 150, __pivot_group__: 250 });
  assert.equal(compact.preset.mode, "compact");
  const fitAgain = toggleColumnWidthPreset(compact.widths, compact.preset, "fit", { name: 280, notes: 410 });
  const restored = toggleColumnWidthPreset(fitAgain.widths, fitAgain.preset, "fit", {});
  assert.deepEqual(restored, { widths: original, preset: null });
  assert.deepEqual(original, { name: 240, notes: 510, __pivot_group__: 320 });
});

test("a saved width snapshot is independent of width updates and the next toggle captures new custom widths", () => {
  const original = { name: 250 };
  const applied = toggleColumnWidthPreset(original, null, "fit", { name: 420 });
  original.name = 280;
  const undone = toggleColumnWidthPreset(applied.widths, applied.preset, "fit", {});
  assert.deepEqual(undone, { widths: { name: 250 }, preset: null });
  const manuallyResized = { ...undone.widths, name: 188 };
  const next = toggleColumnWidthPreset(manuallyResized, null, "fit", { name: 300 });
  assert.deepEqual(toggleColumnWidthPreset(next.widths, next.preset, "fit", {}), { widths: manuallyResized, preset: null });
});

test("initial columns accommodate related long headers while staying bounded", () => {
  assert.equal(initialColumnWidth("id", 13), COMPACT_COLUMN_WIDTH);
  assert.ok(initialColumnWidth("author_profile_pic_hd_url", 13) > COMPACT_COLUMN_WIDTH);
  assert.ok(initialColumnWidth("author_profile_pic_hd_url", 13) > initialColumnWidth("author_profile_pic_url", 13));
  assert.equal(initialColumnWidth("x".repeat(500), 24), 340);
});

test("row-number gutters fit the final 100-million-row label at every supported font size", () => {
  assert.equal(gridRowNumberWidth(0, 13), 50);
  assert.equal(gridRowNumberWidth(500, 13), 50);
  for (const fontSize of [10, 13, 18, 24]) {
    // Monospaced digits use about 0.6em; leave room for both 12px pads and border.
    const labelWidth = 9 * Math.max(11, Math.min(22, fontSize - 2)) * 0.6;
    assert.ok(gridRowNumberWidth(100_000_000, fontSize) >= labelWidth + 25);
    assert.ok(gridRowNumberWidth(100_000_000, fontSize) > gridRowNumberWidth(500, fontSize));
  }
});

test("fitting includes headers and samples but caps long URLs and text", () => {
  assert.equal(fittedColumnWidth(220, [30, 100]), 292);
  assert.equal(fittedColumnWidth(30, [250, 40]), 274);
  assert.equal(fittedColumnWidth(30, [100000]), 420);
  assert.equal(fittedColumnWidth(100000, []), 420);
  assert.equal(fittedColumnWidth(10, []), COMPACT_COLUMN_WIDTH);
});

test("keyboard movement follows visible column order and stops at dataset boundaries", () => {
  const columns = ["__pivot_group__", "value:sum", "name"];
  assert.deepEqual(moveGridCell(null, "ArrowDown", columns, 3), { row: 0, col: "__pivot_group__" });
  assert.deepEqual(moveGridCell({ row: 0, col: "__pivot_group__" }, "ArrowLeft", columns, 3), { row: 0, col: "__pivot_group__" });
  assert.deepEqual(moveGridCell({ row: 1, col: "__pivot_group__" }, "ArrowRight", columns, 3), { row: 1, col: "value:sum" });
  assert.deepEqual(moveGridCell({ row: 2, col: "name" }, "ArrowDown", columns, 3), { row: 2, col: "name" });
  assert.deepEqual(moveGridCell({ row: 1, col: "hidden" }, "ArrowDown", columns, 3), { row: 0, col: "__pivot_group__" });
  assert.equal(moveGridCell(null, "ArrowRight", [], 3), null);
  assert.equal(moveGridCell(null, "ArrowRight", columns, 0), null);
});

test("inspection retains raw wide integers, decimal text and multiline values", () => {
  assert.equal(rawCellValue(18446744073709551615n).text, "18446744073709551615");
  assert.equal(rawCellValue("18446744073709551615").text, "18446744073709551615");
  assert.equal(rawCellValue("001234.5678901234567890").text, "001234.5678901234567890");
  assert.equal(rawCellValue("first\nsecond\tthird").text, "first\nsecond\tthird");
  assert.equal(rawCellValue({ nested: 18446744073709551615n }).text, '{\n  "nested": "18446744073709551615"\n}');
});

test("inspection distinguishes null, empty strings, missing values and literal NULL", () => {
  assert.deepEqual(rawCellValue(null), { text: "NULL", kind: "Null value" });
  assert.deepEqual(rawCellValue(""), { text: "", kind: "Empty string (0 characters)" });
  assert.deepEqual(rawCellValue(undefined), { text: "undefined", kind: "Missing value" });
  assert.equal(rawCellValue("NULL").kind, "Text (4 characters)");
  assert.equal(rawCellValue(false).text, "false");
  assert.equal(rawCellValue(0).text, "0");
});

test("query errors and loading remain visible even with zero rows", () => {
  const base = { hasError: false, columnCount: 2, rowCount: 0, loading: false, filtersActive: false };
  assert.equal(gridEmptyState({ ...base, hasError: true, loading: true }), "error");
  assert.equal(gridEmptyState({ ...base, loading: true, filtersActive: true }), "loading");
  assert.equal(gridEmptyState({ ...base, rowCount: 20, hasError: true }), "error");
});

test("empty-state recovery distinguishes hidden columns, filtered results and empty files", () => {
  const base = { hasError: false, columnCount: 2, rowCount: 0, loading: false, filtersActive: false };
  assert.equal(gridEmptyState(base), "empty");
  assert.equal(gridEmptyState({ ...base, filtersActive: true }), "filtered");
  assert.equal(gridEmptyState({ ...base, columnCount: 0, filtersActive: true }), "hidden-columns");
  assert.equal(gridEmptyState({ ...base, columnCount: 0, hasError: true }), "hidden-columns");
  assert.equal(gridEmptyState({ ...base, rowCount: 1 }), null);
});
