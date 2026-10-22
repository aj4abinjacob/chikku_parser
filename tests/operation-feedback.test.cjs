const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { AsyncActionGate, applyTableMutation, suggestColumnName, columnNameExists, rowScopeLabel } = require("../.test-dist/utils/operationUX.js");
const { buildDeduplicatedRowsQuery, buildRowOpPreviewQuery, buildRowOpSQL } = require("../.test-dist/utils/rowOpsSQL.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("pending operations stay locked until completion and ignore duplicate applies", async () => {
  const gate = new AsyncActionGate();
  const request = deferred();
  const events = [];
  const pending = gate.run(async () => {
    events.push("apply");
    await request.promise;
    events.push("close and reset");
  });
  assert.equal(gate.pending, true);
  await gate.run(async () => events.push("duplicate"));
  assert.deepEqual(events, ["apply"]);
  request.resolve();
  await pending;
  assert.deepEqual(events, ["apply", "close and reset"]);
  assert.equal(gate.pending, false);
});

test("failed operations do not close or reset and may be retried", async () => {
  const gate = new AsyncActionGate();
  const request = deferred();
  const settings = { source: "name", target: "name_replaced" };
  let closed = false;
  const action = gate.run(async () => {
    await request.promise;
    closed = true;
    settings.target = "";
  });
  const failure = new Error("Disk is full");
  request.reject(failure);
  await assert.rejects(action, (error) => error === failure);
  assert.equal(gate.pending, false);
  assert.equal(closed, false);
  assert.equal(settings.target, "name_replaced");
  await gate.run(async () => { closed = true; });
  assert.equal(closed, true);
});

function transactionApi(db, failAt = null) {
  const events = [];
  return {
    events,
    exec: async (sql) => { events.push(sql); db.exec(sql); },
    describe: async (table) => {
      events.push("describe");
      if (failAt === "describe") throw new Error("Schema unavailable");
      return db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => ({ column_name: column.name, column_type: column.type }));
    },
    query: async (sql) => {
      events.push("count");
      if (failAt === "count") throw new Error("Count unavailable");
      return db.prepare(sql).all();
    },
  };
}

test("mutations commit only after schema/count reads succeed", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const api = transactionApi(db);
    const result = await applyTableMutation(api, "sample", "CREATE TABLE sample AS SELECT 1 AS value");
    assert.deepEqual(result, { schema: [{ column_name: "value", column_type: "" }], rowCount: 1 });
    assert.deepEqual(api.events, ["BEGIN TRANSACTION", "CREATE TABLE sample AS SELECT 1 AS value", "describe", "count", "COMMIT"]);
  } finally { db.close(); }
});

for (const stage of ["describe", "count"]) {
  test(`a ${stage} failure rolls back a new column and permits the same operation to retry`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE data (original TEXT); INSERT INTO data VALUES ('keep')");
      const api = transactionApi(db, stage);
      await assert.rejects(applyTableMutation(api, "data", "ALTER TABLE data ADD COLUMN transformed TEXT"));
      assert.equal(api.events.at(-1), "ROLLBACK");
      assert.deepEqual(db.prepare("PRAGMA table_info(data)").all().map((column) => column.name), ["original"]);
      const retried = await applyTableMutation(transactionApi(db), "data", "ALTER TABLE data ADD COLUMN transformed TEXT");
      assert.equal(retried.rowCount, 1);
      assert.equal(retried.schema.length, 2);
    } finally { db.close(); }
  });
}

test("rollback failure does not hide the original operation error", async () => {
  const original = new Error("Invalid expression");
  const api = {
    exec: async (sql) => { if (sql === "ROLLBACK") throw new Error("Disconnected"); if (sql !== "BEGIN TRANSACTION") throw original; },
    describe: async () => [], query: async () => [],
  };
  await assert.rejects(applyTableMutation(api, "data", "invalid"), (error) => error === original);
});

test("suggested new column names avoid case-insensitive schema collisions", () => {
  const names = ["Name_Converted", "name_converted_2", "name_converted_3"];
  assert.equal(suggestColumnName(names, "name_converted"), "name_converted_4");
  assert.equal(columnNameExists(names, " NAME_CONVERTED "), true);
  assert.equal(suggestColumnName(names, "other"), "other");
});

test("filter scope remains explicit when filters match all rows or no rows", () => {
  assert.equal(rowScopeLabel(true, 10, 10), "Filtered rows · 10 of 10 rows");
  assert.equal(rowScopeLabel(true, 0, 10), "Filtered rows · 0 of 10 rows");
  assert.equal(rowScopeLabel(true, 0, null), "Filtered rows · 0 rows");
  assert.equal(rowScopeLabel(false, 10, null), "Entire file · 10 rows");
});

const schema = [
  { column_name: "id", column_type: "INTEGER" },
  { column_name: "scope", column_type: "VARCHAR" },
  { column_name: "value", column_type: "VARCHAR" },
];
const filters = { logic: "AND", children: [{ column: "scope", operator: "=", value: "yes" }] };
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE data (id INTEGER, scope TEXT, value TEXT)");
  const insert = db.prepare("INSERT INTO data VALUES (?, ?, ?)");
  [
    [1, "yes", " first "], [2, "yes", "first"], [3, "yes", ""], [4, "yes", null],
    [5, "no", " first "], [6, null, ""], [7, "no", null], [8, "no", " first "],
  ].forEach((row) => insert.run(...row));
  return db;
}
const params = { columns: JSON.stringify(["value"]) };
const emptyFilter = { logic: "AND", children: [] };

test("filtered dedup preserves every hidden row including NULL filter outcomes and previews the same removed count", () => {
  const db = fixture();
  try {
    const rows = db.prepare(buildDeduplicatedRowsQuery("data", params, filters, schema)).all();
    const hidden = rows.filter((row) => row.scope !== "yes").sort((a, b) => a.id - b.id);
    const originalHidden = db.prepare("SELECT * FROM data WHERE scope IS NOT 'yes' ORDER BY id").all();
    assert.deepEqual(hidden, originalHidden);
    const matching = rows.filter((row) => row.scope === "yes");
    assert.equal(matching.length, 2);
    assert.deepEqual(matching.map((row) => row.value).sort(), ["first", null].sort());
    assert.equal(db.prepare(buildRowOpPreviewQuery("data", "remove_duplicates", params, filters, schema)).get().cnt, 8 - rows.length);
  } finally { db.close(); }
});

for (const [label, filter, expectedCount] of [
  ["all", emptyFilter, 2],
  ["none", { logic: "AND", children: [{ column: "scope", operator: "=", value: "missing" }] }, 8],
]) {
  test(`dedup when scope matches ${label} rows has a consistent preview`, () => {
    const db = fixture();
    try {
      const result = db.prepare(buildDeduplicatedRowsQuery("data", params, filter, schema)).all();
      assert.equal(result.length, expectedCount);
      assert.equal(db.prepare(buildRowOpPreviewQuery("data", "remove_duplicates", params, filter, schema)).get().cnt, 8 - expectedCount);
    } finally { db.close(); }
  });
}

test("Keep Filtered Rows removes NULL-valued nonmatches and preview counts removals", () => {
  const db = fixture();
  try {
    const preview = db.prepare(buildRowOpPreviewQuery("data", "keep_filtered", {}, filters, schema)).get().cnt;
    db.exec(buildRowOpSQL("data", "keep_filtered", {}, filters, schema));
    assert.equal(preview, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM data").get().count, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM data WHERE scope IS NOT 'yes'").get().count, 0);
  } finally { db.close(); }
});

test("Remove Empty preview and mutation are limited to the same filtered rows", () => {
  const db = fixture();
  try {
    const preview = db.prepare(buildRowOpPreviewQuery("data", "remove_empty", params, filters, schema)).get().cnt;
    db.exec(buildRowOpSQL("data", "remove_empty", params, filters, schema));
    assert.equal(preview, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM data").get().count, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM data WHERE scope IS NOT 'yes'").get().count, 4);
  } finally { db.close(); }
});
