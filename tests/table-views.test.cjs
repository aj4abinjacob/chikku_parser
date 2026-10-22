const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDefaultViewState,
  reconcileViewState,
  renameViewColumns,
  TableViewStore,
  SchemaRequestGate,
} = require("../.test-dist/utils/tableViews.js");

function exploredView() {
  return {
    visibleColumns: ["amount", "name"],
    columnOrder: ["amount", "secret", "name"],
    filters: { logic: "AND", children: [{ column: "amount", operator: ">", value: "10" }] },
    sortColumns: [{ column: "amount", direction: "DESC" }],
    pivotConfig: { groupColumns: [{ column: "name", direction: "ASC" }], defaultAggFunction: "SUM", showGrandTotal: true, groupSortMode: "count", groupSortDirection: "DESC" },
  };
}

const columns = ["name", "amount", "secret"];

test("switching among loaded files restores independent filters, sorts, columns and pivot settings", () => {
  const store = new TableViewStore();
  store.get("first", columns);
  const first = exploredView();
  store.update("first", first);
  store.get("second", ["date", "total"]);
  store.update("second", (view) => ({ ...view, visibleColumns: ["total"] }));

  assert.equal(store.get("first", columns), first);
  assert.deepEqual(store.get("second", ["date", "total"]).visibleColumns, ["total"]);
  assert.equal(first.pivotConfig.groupSortMode, "count");
});

test("unchanged schemas preserve view and filter identity so refreshing cannot overwrite a draft", () => {
  const view = exploredView();
  const refreshed = reconcileViewState(view, columns);
  assert.equal(refreshed, view);
  assert.equal(refreshed.filters, view.filters);
  // A source's new physical column order does not replace the user's display order.
  assert.equal(reconcileViewState(view, ["secret", "amount", "name"]), view);
});

test("hide all remains hidden across switching and refreshes; only new columns appear", () => {
  const store = new TableViewStore();
  store.get("first", columns);
  store.update("first", (view) => ({ ...view, visibleColumns: [] }));
  store.get("second", ["other"]);
  assert.deepEqual(store.get("first", columns).visibleColumns, []);

  const added = store.get("first", [...columns, "added"]);
  assert.deepEqual(added.visibleColumns, ["added"]);
  assert.deepEqual(added.columnOrder, [...columns, "added"]);
});

test("schema additions preserve old visibility and display order", () => {
  const next = reconcileViewState(exploredView(), ["name", "added", "amount", "secret"]);
  assert.deepEqual(next.columnOrder, ["amount", "secret", "name", "added"]);
  assert.deepEqual(next.visibleColumns, ["amount", "name", "added"]);
});

test("removed columns prune nested filters and column comparisons, sorts and grouping", () => {
  const view = exploredView();
  view.filters.children.push({ logic: "OR", children: [
    { column: "name", operator: "EQUALS COLUMN", value: "secret" },
    { column: "secret", operator: "=", value: "private" },
  ] });
  view.sortColumns.push({ column: "secret", direction: "ASC" });
  const next = reconcileViewState(view, ["amount"]);
  assert.deepEqual(next.columnOrder, ["amount"]);
  assert.deepEqual(next.visibleColumns, ["amount"]);
  assert.deepEqual(next.filters, { logic: "AND", children: [{ column: "amount", operator: ">", value: "10" }] });
  assert.deepEqual(next.sortColumns, [{ column: "amount", direction: "DESC" }]);
  assert.equal(next.pivotConfig, null);
});

test("explicit renames and inverse undo preserve hidden state, nested comparisons, sorts and grouping", () => {
  const view = exploredView();
  view.filters.children.push({ logic: "OR", children: [{ column: "name", operator: "EQUALS COLUMN", value: "secret" }] });
  const renamed = reconcileViewState(renameViewColumns(view, { secret: "private", name: "customer", amount: "total" }), ["customer", "total", "private"]);
  assert.deepEqual(renamed.columnOrder, ["total", "private", "customer"]);
  assert.deepEqual(renamed.visibleColumns, ["total", "customer"]);
  assert.equal(renamed.filters.children[1].children[0].value, "private");
  assert.deepEqual(renamed.sortColumns, [{ column: "total", direction: "DESC" }]);
  assert.deepEqual(renamed.pivotConfig, { ...view.pivotConfig, groupColumns: [{ column: "customer", direction: "ASC" }] });

  const restored = reconcileViewState(renameViewColumns(renamed, { private: "secret", customer: "name", total: "amount" }), columns);
  assert.deepEqual(restored, view);
  assert.deepEqual(view.visibleColumns, ["amount", "name"]);
});

test("simultaneous column swaps do not accidentally chain renames or map inherited object keys", () => {
  const view = createDefaultViewState(["left", "right", "constructor", "toString"]);
  const swapped = renameViewColumns(view, { left: "right", right: "left" });
  assert.deepEqual(swapped.columnOrder, ["right", "left", "constructor", "toString"]);
});

test("reset applies only to the selected file and removal cannot restore a previous same-name file", () => {
  const store = new TableViewStore();
  store.update("first", exploredView());
  store.update("second", exploredView());
  store.update("first", createDefaultViewState(columns));
  assert.deepEqual(store.get("first", columns), createDefaultViewState(columns));
  assert.deepEqual(store.get("second", columns), exploredView());
  store.delete("second");
  assert.deepEqual(store.get("second", columns), createDefaultViewState(columns));
  store.update("first", exploredView());
  store.retain(["second"]);
  assert.deepEqual(store.get("first", columns), createDefaultViewState(columns));
  store.update("second", exploredView());
  store.clear();
  assert.deepEqual(store.get("second", columns), createDefaultViewState(columns));
});

test("late schema responses from a previous file or an earlier refresh cannot replace the current schema", async () => {
  const requests = new SchemaRequestGate();
  const pending = [];
  let displayed;
  const describe = (file) => {
    const isCurrent = requests.start();
    return new Promise((resolve) => pending.push(resolve)).then((schema) => {
      if (isCurrent()) displayed = { file, schema };
    });
  };
  const first = describe("first");
  requests.invalidate(); // Activation or document navigation invalidates the old request.
  const second = describe("second");
  pending[1](["second-column"]);
  await second;
  pending[0](["first-column"]);
  await first;
  assert.deepEqual(displayed, { file: "second", schema: ["second-column"] });

  const oldRefresh = describe("second");
  const newRefresh = describe("second");
  pending[3](["new-column"]);
  await newRefresh;
  pending[2](["stale-column"]);
  await oldRefresh;
  assert.deepEqual(displayed, { file: "second", schema: ["new-column"] });
});
