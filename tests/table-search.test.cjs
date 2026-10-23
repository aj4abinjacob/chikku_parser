const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTableSearchRequest, SearchRequestGate, tableSearchContextKey, findTextRanges, findTextMatches, flattenFindMatches } = require("../.test-dist/utils/tableSearch.js");

const scope = { tableName: 'data"file', displayName: "Example.csv", dataVersion: 3, schemaVersion: 2, filters: { logic: "AND", children: [{ id: "f", column: 'customer"name', operator: "=", value: "O'Reilly", columnType: "VARCHAR" }] } };

test("table search preserves literal text and scopes to filtered visible columns", () => {
  const text = "  don't_100% [x] café  ";
  const request = buildTableSearchRequest(42, scope, ["name", "description"], [], text);
  assert.equal(request.term, text);
  assert.deepEqual(request.columns, ["name", "description"]);
  assert.equal(request.tableName, 'data"file');
  assert.equal(request.requestId, 42);
  assert.equal(request.filterSql, '"customer""name" = \'O\'\'Reilly\'');
  assert.deepEqual(buildTableSearchRequest(43, scope, ["name", "description"], [], "%_").columns, ["name", "description"]);
  assert.deepEqual(request.sortColumns, []);
  assert.equal(request.direction, "forward");
  assert.equal(request.cursorRow, 0);
});

test("search bounds and positional cursors stay explicit", () => {
  const wide = Array.from({ length: 201 }, (_, i) => `column${i}`);
  assert.throws(() => buildTableSearchRequest(1, scope, wide, [], "hit"), /200 visible/);
  assert.throws(() => buildTableSearchRequest(3, scope, [], [], "hit"), /Show a column/);
  assert.throws(() => buildTableSearchRequest(4, scope, ["visible"], [], ""), /2,048/);
  assert.throws(() => buildTableSearchRequest(5, scope, ["visible"], [], "x".repeat(2049)), /2,048/);
  assert.equal(buildTableSearchRequest(6, scope, ["visible"], [], "😀".repeat(2048)).term.length, 4096);
  assert.throws(() => buildTableSearchRequest(7, scope, ["visible"], [], "hit", "forward", -1), /position/);
  const request = buildTableSearchRequest(8, scope, ["visible"], [{ column: "hidden sort", direction: "DESC" }], "hit", "backward", 100000000);
  assert.equal(request.cursorRow, 100000000);
  assert.equal(request.direction, "backward");
  assert.deepEqual(request.sortColumns, [{ column: "hidden sort", direction: "DESC" }]);
});

test("find ranges are literal, Unicode-aware, bounded, and never change raw cell values", () => {
  const value = "<b>NÉEDLE</b> %_ [x] needle";
  const ranges = findTextRanges(value, "néedle");
  assert.deepEqual(ranges, [{ start: 3, end: 9 }]);
  assert.deepEqual(findTextRanges(value, "%_ [x]"), [{ start: 14, end: 20 }]);
  assert.deepEqual(findTextRanges("😀İabc", "abc"), [{ start: 3, end: 6 }]);
  assert.deepEqual(findTextRanges("İabc", "i"), [{ start: 0, end: 1 }]);
  assert.equal(findTextRanges("a".repeat(1000000), "a").length, 100);
  assert.equal(findTextMatches(null, "null"), false);
  assert.equal(findTextMatches("NÉEDLE", "néedle"), true);
  assert.equal(findTextMatches("İstanbul ΟΣ", "istanbul οσ"), true);
  assert.equal(value, "<b>NÉEDLE</b> %_ [x] needle");
});

test("cell highlighting escapes HTML and preserves complete text for copying", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { highlightFindText } = require("../.test-dist/components/DataGrid.js");
  const value = '<script>alert("x")</script> NEEDLE';
  const rendered = renderToStaticMarkup(React.createElement("span", null, highlightFindText(value, "needle")));
  assert.match(rendered, /&lt;script&gt;/);
  assert.match(rendered, /<mark class="dg-find-mark">NEEDLE<\/mark>/);
  assert.ok(!rendered.includes("<script>"));
  assert.equal(value, '<script>alert("x")</script> NEEDLE');
});

test("find positions flatten in row and visible-column order without losing multiple cells", () => {
  assert.deepEqual(flattenFindMatches([{ rowIndex: 25, columns: ["b", "a"] }, { rowIndex: 99999999, columns: ["a"] }]), [
    { row: 25, col: "b" }, { row: 25, col: "a" }, { row: 99999999, col: "a" },
  ]);
});

test("grid chunk ordering has the same deterministic tie contract as native find", () => {
  const { buildGridOrderClause, buildChunkQuery } = require("../.test-dist/utils/sqlBuilder.js");
  const sort = [{ column: "hidden sort", direction: "DESC" }];
  assert.equal(buildGridOrderClause([], ["name"]), "");
  assert.equal(buildGridOrderClause(sort, ["name"], ["name", "hidden sort"]), ' ORDER BY "hidden sort" DESC, rowid ASC');
  assert.equal(buildGridOrderClause(sort, ["name", "message"], ["name", "message", "ROWID", "hidden sort"]), ' ORDER BY "hidden sort" DESC, "name" ASC, "message" ASC');
  assert.match(buildChunkQuery("data", ["name"], { logic: "AND", children: [] }, sort, 100, 1, false, new Map([["name", "VARCHAR"], ["hidden sort", "INTEGER"]])), /ORDER BY "data"\."hidden sort" DESC, "data"\."rowid" ASC LIMIT 100 OFFSET 100$/);
});

test("transport casts never turn typed grid ordering or tie keys into string ordering", () => {
  const { buildChunkQuery } = require("../.test-dist/utils/sqlBuilder.js");
  const schema = new Map([["amount", "DECIMAL(38, 10)"], ["time", "TIME WITH TIME ZONE"], ["ROWID", "VARCHAR"]]);
  const sql = buildChunkQuery('data"file', ["amount", "time"], { logic: "AND", children: [] }, [{ column: "amount", direction: "ASC" }], 100, 0, false, schema);
  assert.equal(sql, 'SELECT CAST("amount" AS VARCHAR) AS "amount", CAST("time" AS VARCHAR) AS "time" FROM "data""file" ORDER BY "data""file"."amount" ASC, "data""file"."time" ASC LIMIT 100 OFFSET 0');
});

test("cached row order invalidates after reordering sorted ties with a real rowid", () => {
  const { chunkColumnsKey } = require("../.test-dist/hooks/chunkCacheState.js");
  const before = ["amount", "message"];
  const after = ["message", "amount"];
  const shadowedSchema = ["amount", "message", "ROWID"];
  assert.notEqual(chunkColumnsKey(before, true, shadowedSchema), chunkColumnsKey(after, true, shadowedSchema));
  assert.equal(chunkColumnsKey(before, false, shadowedSchema), chunkColumnsKey(after, false, shadowedSchema));
  assert.equal(chunkColumnsKey(before, true, before), chunkColumnsKey(after, true, before));
  assert.notEqual(chunkColumnsKey(before, false, before), chunkColumnsKey(["amount"], false, before));
});

test("search generations ignore late results after cancel, new submit, close and remount", () => {
  const gate = new SearchRequestGate();
  const first = gate.begin();
  assert.ok(first >= Date.now() - 1000);
  assert.equal(gate.isCurrent(first), true);
  assert.equal(gate.invalidate(), first);
  assert.equal(gate.isCurrent(first), false);
  const second = gate.begin();
  assert.ok(second > first);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  const third = gate.begin();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.invalidate(), third);
  assert.equal(gate.invalidate(), null);
  const reopened = new SearchRequestGate().begin();
  assert.ok(reopened > third);
});

test("file, filter, visible schema and data changes invalidate search scope", () => {
  const columns = ["name", "description"];
  const initial = tableSearchContextKey(scope, columns, 1, false);
  assert.notEqual(initial, tableSearchContextKey({ ...scope, tableName: "other" }, columns, 1, false));
  assert.notEqual(initial, tableSearchContextKey({ ...scope, filters: { logic: "AND", children: [] } }, columns, 1, false));
  assert.notEqual(initial, tableSearchContextKey(scope, ["name"], 1, false));
  assert.notEqual(initial, tableSearchContextKey({ ...scope, dataVersion: 4 }, columns, 1, false));
  assert.notEqual(initial, tableSearchContextKey({ ...scope, schemaVersion: 3 }, columns, 1, false));
  assert.notEqual(initial, tableSearchContextKey(scope, columns, 2, false));
  assert.notEqual(initial, tableSearchContextKey(scope, columns, 1, true));
});
