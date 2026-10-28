const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendRecentEdit, assertCellHistoryBudget, canRestoreCell, cellEditSqlUpperBound,
  cellValueLabel, cellValueMetrics, createDraft, moveDraft, pushDraft,
  sessionHistoryUsage, storedValueBytes, textareaDraftValue, utf8Bytes, visibleWhitespace,
  CELL_HISTORY_MAX_BYTES, CELL_HISTORY_MAX_ENTRIES,
} = require("../.test-dist/utils/cellEditor.js");

const request = { tableName: 'sales"table', columnName: 'exact"amount', rowId: "9007199254740993", expectedValue: "0.12345678901234567890", value: "0.2", revision: "123" };
const history = (sqlStatements, source = "cell_edit") => ({ tableName: "sales", sourceInfo: {}, initialSchema: [], nextEntryId: 2, entries: [{ id: 1, source, description: "edit", timestamp: 0, sqlStatements }] });
const record = (id, before, after) => ({ id, tableName: "sales", columnName: "exact", rowId: "9007199254740993", timestamp: id, before, after, context: 3, restorable: true });

test("cell metrics distinguish null, empty, literal NULL, Unicode code points and CRLF", () => {
  assert.deepEqual(cellValueMetrics(null), { characters: 0, bytes: 0, lines: 0 });
  assert.deepEqual(cellValueMetrics(""), { characters: 0, bytes: 0, lines: 0 });
  assert.equal(cellValueLabel(null), "NULL");
  assert.equal(cellValueLabel(""), "Empty string");
  assert.deepEqual(cellValueMetrics("NULL"), { characters: 4, bytes: 4, lines: 1 });
  assert.deepEqual(cellValueMetrics("😀é\r\n\t a"), { characters: 7, bytes: 11, lines: 2 });
  assert.deepEqual(cellValueMetrics("a\rb\nc\r\n"), { characters: 7, bytes: 7, lines: 4 });
});

test("whitespace preview labels spaces, tabs and each newline without changing source", () => {
  const source = " x\t\r\ny\rz\n";
  assert.equal(visibleWhitespace(source), "·x⇥␍↵\ny␍\nz↵\n");
  assert.equal(source, " x\t\r\ny\rz\n");
});

test("textarea normalization preserves untouched mixed newlines and uniform CRLF or CR edits", () => {
  assert.equal(textareaDraftValue("a\r\nb\rc\n", "a\nb\nc\n"), "a\r\nb\rc\n");
  assert.equal(textareaDraftValue("a\r\nb", "a\nbc\n"), "a\r\nbc\r\n");
  assert.equal(textareaDraftValue("a\rb", "a\nbc\n"), "a\rbc\r");
  assert.equal(textareaDraftValue("a\nb", "a\nbc\n"), "a\nbc\n");
  assert.equal(textareaDraftValue(null, ""), "");
  const original = "a\r\nb";
  const withoutNewline = textareaDraftValue(original, "ab", original);
  assert.equal(textareaDraftValue(withoutNewline, "ab\nc", original), "ab\r\nc");
});

test("draft undo and redo distinguish null/empty and discard only the abandoned future branch", () => {
  let draft = createDraft(null);
  draft = pushDraft(draft, { value: "", start: 0, end: 0 });
  draft = pushDraft(draft, { value: "abc", start: 2, end: 3 });
  assert.equal(draft.states[draft.index].value, "abc");
  draft = moveDraft(draft, -1); assert.equal(draft.states[draft.index].value, "");
  draft = moveDraft(draft, -1); assert.equal(draft.states[draft.index].value, null);
  draft = moveDraft(draft, 2); assert.deepEqual(draft.states[draft.index], { value: "abc", start: 2, end: 3 });
  draft = moveDraft(draft, -1);
  draft = pushDraft(draft, { value: "new", start: 3, end: 3 });
  assert.deepEqual(draft.states.map(s => s.value), [null, "", "new"]);
  assert.equal(moveDraft(draft, 1).index, 2);
});

test("draft history enforces count and UTF16-aware memory budgets while retaining newest state", () => {
  let draft = createDraft("");
  for (let i = 0; i < 20; i++) draft = pushDraft(draft, { value: String(i), start: 0, end: 0 }, 4, 16);
  assert.ok(draft.states.length <= 4);
  assert.ok(draft.states.reduce((sum, s) => sum + storedValueBytes(s.value), 0) <= 16);
  assert.equal(draft.states[draft.index].value, "19");
  assert.equal(storedValueBytes("abcd"), 8);
  assert.equal(storedValueBytes("😀"), 4);
  assert.equal(storedValueBytes(null), 0);
});

test("recent ledger evicts oldest whole records within count and string memory bounds", () => {
  let records = [];
  for (let i = 0; i < 10; i++) records = appendRecentEdit(records, record(i, "aa", "bb"), 3, 16);
  assert.deepEqual(records.map(r => r.id), [8, 9]);
  assert.equal(records[1].after, "bb");
  assert.equal(appendRecentEdit([], record(1, "a".repeat(10), "b".repeat(10)), 3, 16).length, 0);
});

test("restore targets require the captured physical identity and current mutation context", () => {
  const edit = record(1, "a", "b");
  const target = { tableName: "sales", columnName: "exact", rowId: "9007199254740993", context: 3 };
  assert.equal(canRestoreCell(edit, target, 3), true);
  assert.equal(canRestoreCell(edit, { ...target, rowId: "9007199254740992" }, 3), false);
  assert.equal(canRestoreCell(edit, { ...target, tableName: "other" }, 3), false);
  assert.equal(canRestoreCell(edit, target, 4), false);
  assert.equal(canRestoreCell({ ...edit, restorable: false }, target, 3), false);
});

test("history reservation includes cell-edit SQL across every table and reserves encoded string storage before native writes", () => {
  const sql = "SELECT '😀'";
  assert.deepEqual(sessionHistoryUsage([history([sql]), history(["UPDATE x SET a = 1"]), history(["ignored"], "row_op")]), { entries: 2, bytes: storedValueBytes(sql) + storedValueBytes("UPDATE x SET a = 1") });
  const reserve = cellEditSqlUpperBound(request, "DECIMAL(38,20)");
  assert.doesNotThrow(() => assertCellHistoryBudget([history(["x".repeat(Math.floor((CELL_HISTORY_MAX_BYTES - reserve) / 2))])], request, "DECIMAL(38,20)"));
  assert.throws(() => assertCellHistoryBudget([history(["x".repeat(Math.floor((CELL_HISTORY_MAX_BYTES - reserve) / 2) + 1)])], request, "DECIMAL(38,20)"), /Export.*reopen.*draft/);
  const entries = Array.from({ length: CELL_HISTORY_MAX_ENTRIES }, (_, id) => ({ id, source: "cell_edit", sqlStatements: [] }));
  assert.throws(() => assertCellHistoryBudget([{ entries }], request, "VARCHAR"), /history is full/);
  const nulRequest = { ...request, expectedValue: "\0'😀", value: "\0'".repeat(100) };
  assert.ok(cellEditSqlUpperBound(nulRequest, "VARCHAR") > 2 * (utf8Bytes(nulRequest.expectedValue) + utf8Bytes(nulRequest.value)));
});

