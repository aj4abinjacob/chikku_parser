const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTableSearchRequest, SearchRequestGate, tableSearchContextKey } = require("../.test-dist/utils/tableSearch.js");

const scope = { tableName: 'data"file', displayName: "Example.csv", dataVersion: 3, schemaVersion: 2, filters: { logic: "AND", children: [{ id: "f", column: 'customer"name', operator: "=", value: "O'Reilly", columnType: "VARCHAR" }] } };

test("table search preserves literal text and scopes to filtered visible columns", () => {
  const text = "  don't_100% [x] café  ";
  const request = buildTableSearchRequest(42, scope, ["name", "description"], "", text);
  assert.equal(request.term, text);
  assert.deepEqual(request.columns, ["name", "description"]);
  assert.equal(request.tableName, 'data"file');
  assert.equal(request.requestId, 42);
  assert.equal(request.filterSql, '"customer""name" = \'O\'\'Reilly\'');
  assert.deepEqual(buildTableSearchRequest(43, scope, ["name", "description"], "description", "%_").columns, ["description"]);
});

test("search limits reject wide scans while a selected visible column remains available", () => {
  const wide = Array.from({ length: 201 }, (_, i) => `column${i}`);
  assert.throws(() => buildTableSearchRequest(1, scope, wide, "", "hit"), /specific column/);
  assert.deepEqual(buildTableSearchRequest(2, scope, wide, "column200", "hit").columns, ["column200"]);
  assert.throws(() => buildTableSearchRequest(3, scope, ["visible"], "hidden", "hit"), /Show a column/);
  assert.throws(() => buildTableSearchRequest(4, scope, ["visible"], "", ""), /2,048/);
  assert.throws(() => buildTableSearchRequest(5, scope, ["visible"], "", "x".repeat(2049)), /2,048/);
  assert.equal(buildTableSearchRequest(6, scope, ["visible"], "", "😀".repeat(2048)).term.length, 4096);
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
