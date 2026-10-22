const test = require("node:test");
const assert = require("node:assert/strict");
const { getWorkbenchPanelHeight, getWorkbenchHeightLimits } = require("../.test-dist/utils/workbenchPanel.js");

test("filters open compactly and grow as conditions are added", () => {
  assert.equal(getWorkbenchPanelHeight("filters", 0, 800), 210);
  assert.equal(getWorkbenchPanelHeight("filters", 1, 800), 210);
  assert.equal(getWorkbenchPanelHeight("filters", 4, 800), 324);
  assert.equal(getWorkbenchPanelHeight("filters", 40, 800), 500);
});

test("each tab uses its own height so review cannot leave filters oversized", () => {
  const preferences = { qc: 420, colops: 350 };
  assert.equal(getWorkbenchPanelHeight("qc", 1, 800, preferences.qc), 420);
  assert.equal(getWorkbenchPanelHeight("colops", 1, 800, preferences.colops), 350);
  assert.equal(getWorkbenchPanelHeight("filters", 1, 800, preferences.filters), 210);
  assert.equal(getWorkbenchPanelHeight("rowops", 1, 800, preferences.rowops), 300);
});

test("manual sizes survive tab switches and take precedence over automatic growth", () => {
  const manual = 245;
  assert.equal(getWorkbenchPanelHeight("filters", 1, 800, manual), manual);
  assert.equal(getWorkbenchPanelHeight("filters", 12, 800, manual), manual);
});

test("small windows clamp every tab while keeping table rows visible", () => {
  // A 600px app with title/status bars and a wrapped toolbar has ~460px available.
  const available = 460;
  for (const tab of ["filters", "colops", "rowops", "qc"]) {
    const height = getWorkbenchPanelHeight(tab, 40, available, 490);
    assert.equal(height, 280);
    assert.equal(available - height, 180);
  }
  assert.deepEqual(getWorkbenchHeightLimits(280), { min: 120, max: 120 });
});

test("temporary viewport clamps do not overwrite the user's preferred size", () => {
  const preference = 420;
  assert.equal(getWorkbenchPanelHeight("qc", 0, 460, preference), 280);
  assert.equal(getWorkbenchPanelHeight("qc", 0, 900, preference), 420);
  assert.equal(getWorkbenchPanelHeight("filters", 0, 800, -20), 180);
});
