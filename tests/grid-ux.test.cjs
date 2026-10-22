const test = require("node:test");
const assert = require("node:assert/strict");
const { COMPACT_COLUMN_WIDTH, fittedColumnWidth, gridEmptyState, initialColumnWidth, moveGridCell, rawCellValue } = require("../.test-dist/utils/gridUX.js");

test("initial columns accommodate related long headers while staying bounded", () => {
  assert.equal(initialColumnWidth("id", 13), COMPACT_COLUMN_WIDTH);
  assert.ok(initialColumnWidth("author_profile_pic_hd_url", 13) > COMPACT_COLUMN_WIDTH);
  assert.ok(initialColumnWidth("author_profile_pic_hd_url", 13) > initialColumnWidth("author_profile_pic_url", 13));
  assert.equal(initialColumnWidth("x".repeat(500), 24), 340);
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
