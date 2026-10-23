const test = require("node:test");
const assert = require("node:assert/strict");
const { GRID_ROW_WINDOW_SIZE, boundedRowWindow, clampGridRow, rowWindowContaining, rowWindowNearEdge, rowWindowScrollOffset } = require("../.test-dist/utils/gridRowWindow.js");

const ROWS = 100_000_000;

test("100 million rows occupy a bounded physical window even with the largest wrapped cells", () => {
  const window = boundedRowWindow(ROWS);
  assert.deepEqual(window, { base: 0, count: GRID_ROW_WINDOW_SIZE });
  assert.ok(window.count * 114 < 16_000_000);
  assert.deepEqual(boundedRowWindow(500), { base: 0, count: 500 });
  assert.deepEqual(boundedRowWindow(0, 50_000_000), { base: 0, count: 0 });
});

test("middle and last match seeks retain logical row indices while revealing whole cells", () => {
  for (const row of [50_000_000, 99_999_999]) {
    const window = rowWindowContaining(ROWS, row, 0);
    assert.ok(row >= window.base && row < window.base + window.count);
    for (const height of [28, 114]) {
      const offset = rowWindowScrollOffset(window, row, height, 0, 600, 30);
      const top = 30 + (row - window.base) * height - offset;
      assert.ok(top >= 30, `row ${row} sits below the header`);
      assert.ok(top + height <= 600, `row ${row} is fully visible`);
      assert.ok(offset < 16_000_000);
    }
  }
});

test("wheel scrolling can cross both seams without changing the visible logical anchor", () => {
  for (const [base, anchor] of [[0, 99_500], [50_000_000, 50_000_500]]) {
    const next = rowWindowNearEdge(ROWS, base, anchor, 24);
    assert.notEqual(next.base, base);
    for (const height of [28, 114]) {
      const fraction = 0.375;
      const oldOffset = (anchor - base + fraction) * height;
      const newOffset = (anchor - next.base + fraction) * height;
      assert.equal(base + Math.floor(oldOffset / height), next.base + Math.floor(newOffset / height));
      assert.equal(oldOffset % height, newOffset % height);
      assert.ok(newOffset > 0 && newOffset < next.count * height);
      assert.deepEqual(rowWindowNearEdge(ROWS, next.base, anchor, 24), next, "a rebase does not immediately rebase again");
    }
  }
});

test("real dataset edges never rebase into an endless loop", () => {
  assert.deepEqual(rowWindowNearEdge(ROWS, 0, 0, 24), boundedRowWindow(ROWS));
  const last = boundedRowWindow(ROWS, ROWS);
  assert.deepEqual(rowWindowNearEdge(ROWS, last.base, ROWS - 24, 24), last);
  assert.deepEqual(rowWindowNearEdge(500, 0, 480, 24), boundedRowWindow(500));
});

test("count shrink clamps a stale window and its logical target to surviving rows", () => {
  const last = boundedRowWindow(ROWS, ROWS);
  const shrunk = boundedRowWindow(150_000, last.base);
  assert.deepEqual(shrunk, { base: 50_000, count: 100_000 });
  const survivingRow = clampGridRow(99_999_999, 150_000);
  assert.equal(survivingRow, 149_999);
  assert.deepEqual(rowWindowContaining(150_000, survivingRow, shrunk.base), shrunk);
  assert.deepEqual(boundedRowWindow(25, last.base), { base: 0, count: 25 });
  assert.equal(clampGridRow(99_999_999, 0), 0);
});

test("in-window navigation stays stable and preserves a cell already fully visible", () => {
  const window = boundedRowWindow(ROWS, 49_950_000);
  assert.deepEqual(rowWindowContaining(ROWS, 50_000_000, window.base), window);
  const scrollTop = 50_000 * 28;
  assert.equal(rowWindowScrollOffset(window, 50_000_003, 28, scrollTop, 600, 30), scrollTop);
  assert.equal(rowWindowScrollOffset(window, 49_999_999, 28, scrollTop, 600, 30), scrollTop - 28);
});
