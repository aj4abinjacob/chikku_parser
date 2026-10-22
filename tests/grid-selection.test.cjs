const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCellRange, cellKey, getSelectionText } = require("../.test-dist/utils/gridSelection.js");

const groupColumn = "__pivot_group__";

test("a group value can be copied when there are no value columns", () => {
  const url = "https://threads.com/@example/post/123";
  const selected = buildCellRange([groupColumn], { row: 0, col: groupColumn }, { row: 0, col: groupColumn });

  assert.equal(getSelectionText(selected, [groupColumn], () => url), url);
});

test("group ranges include the Group By column and visible aggregates in display order", () => {
  // Original columns can put the grouping column between value columns;
  // selection must instead follow the displayed Group By, amount, count order.
  const columns = [groupColumn, "amount", "count"];
  const selected = buildCellRange(columns, { row: 1, col: "count" }, { row: 0, col: groupColumn });
  const rows = [
    { [groupColumn]: "Group A", amount: "12.50", count: "2" },
    { [groupColumn]: "Group B", amount: "24.00", count: "3" },
  ];

  assert.equal(selected.size, 6);
  assert.equal(
    getSelectionText(selected, columns, (row, col) => rows[row][col]),
    "Group A\t12.50\t2\nGroup B\t24.00\t3"
  );
});

test("selection spanning an expanded group retains blank Group By cells", () => {
  const columns = [groupColumn, "amount"];
  const selected = buildCellRange(columns, { row: 0, col: groupColumn }, { row: 2, col: "amount" });
  const rows = [
    { [groupColumn]: "Group A", amount: "12.50" },
    { [groupColumn]: "", amount: "5.00" },
    { [groupColumn]: "", amount: "7.50" },
  ];

  assert.equal(
    getSelectionText(selected, columns, (row, col) => rows[row][col]),
    "Group A\t12.50\n\t5.00\n\t7.50"
  );
});

test("disjoint cells copy in row order with blank positions and colon-containing column names", () => {
  const selected = new Set([cellKey(10, "amount:sum"), cellKey(2, groupColumn)]);
  const copiedCells = [];

  assert.equal(getSelectionText(selected, [groupColumn, "amount:sum"], (row, col) => {
    copiedCells.push([row, col]);
    return col === groupColumn ? "NULL" : "5";
  }), "NULL\t\n\t5");
  assert.deepEqual(copiedCells, [[2, groupColumn], [10, "amount:sum"]]);
});

test("hidden columns and stale range anchors do not produce invalid selections", () => {
  assert.deepEqual(
    buildCellRange([groupColumn, "amount"], { row: 0, col: "hidden" }, { row: 1, col: "amount" }),
    new Set()
  );
  assert.equal(
    getSelectionText(new Set([cellKey(0, "hidden")]), [groupColumn, "amount"], () => {
      assert.fail("hidden cells must not be read");
    }),
    ""
  );
});

test("flat cell ranges still copy formatted text in reordered column order", () => {
  const columns = ["name", "amount"];
  const selected = buildCellRange(columns, { row: 0, col: "amount" }, { row: 1, col: "name" });
  const rows = [{ name: "First", amount: "$12.50" }, { name: "Second", amount: "$24.00" }];

  assert.equal(getSelectionText(selected, columns, (row, col) => rows[row][col]), "First\t$12.50\nSecond\t$24.00");
});
