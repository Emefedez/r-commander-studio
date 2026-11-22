'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RRuntime } = require('../main/r-runtime');

test('RRuntime persistent session runs R code, captures SVG plots, inspects workspace, hooks View(), and edits live tables', async () => {
  const runtime = new RRuntime();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-rt-test-'));
  const rdataPath = path.join(tmpDir, 'sample.RData');
  const viewEvents = [];
  runtime.on('viewTable', (ev) => viewEvents.push(ev));

  try {
    const env = await runtime.probeEnvironment();
    assert.ok(env.rVersion, 'expected R version');

    // 1. Run script creating data frame, model, plot, and invoking View()
    const run1 = await runtime.runCode(
      'df <- data.frame(x = 1:5, y = c(2, 4, 5, NA, 6), g = factor(c("a", "a", "b", "b", "b")))\n' +
        'fit <- lm(y ~ x, data = df)\n' +
        'plot(df$x, df$y, main = "Session Plot")\n' +
        'View(df)\n' +
        'mean(df$y, na.rm = TRUE)\n',
      { capturePlots: true, syntaxColors: false }
    );
    assert.equal(run1.ok, true, `runCode stderr: ${run1.stderr}`);
    assert.match(run1.stdout, /4\.25/);
    assert.ok(run1.plots.length >= 1, 'expected at least 1 captured SVG plot');
    assert.ok(run1.plots[0].includes('<svg'));
    assert.ok(viewEvents.some((e) => e.name === 'df'), 'View(df) should emit viewTable event');

    // 2. Workspace snapshot via session_info()
    const snap = await runtime.snapshot();
    assert.ok(snap.datasets.df, 'expected df dataset in workspace snapshot');
    assert.equal(snap.datasets.df.rows, 5);
    assert.equal(snap.datasets.df.columns, 3);
    assert.ok(snap.datasets.df.vars.some((v) => v.name === 'g' && v.kind === 'factor' && v.levels === 2));
    assert.ok(snap.models.some((m) => m.name === 'fit' && m.cls === 'lm'));

    // 3. Interactive Table Viewer RPC: pagination, sorting, filtering, column summary, edit cell, add row/col, CSV export
    const page1 = await runtime.getTablePage({ name: 'df', page: 1, pageSize: 2, sortCol: 'x', sortDir: 'desc' });
    assert.equal(page1.ok, true);
    assert.equal(page1.totalRows, 5);
    assert.equal(page1.rows.length, 2);
    assert.equal(page1.rows[0].values[0], '5');

    const filtered = await runtime.getTablePage({ name: 'df', filter: 'a' });
    assert.equal(filtered.ok, true);
    assert.equal(filtered.filteredRows, 3); // 2 rows with "a" + 1 row with "NA"

    const numSum = await runtime.getColumnSummary({ name: 'df', col: 'y' });
    assert.equal(numSum.ok, true);
    assert.equal(numSum.kind, 'numeric');
    assert.equal(numSum.naCount, 1);
    assert.equal(numSum.mean, 4.25);

    const facSum = await runtime.getColumnSummary({ name: 'df', col: 'g' });
    assert.equal(facSum.ok, true);
    assert.equal(facSum.kind, 'categorical');
    assert.equal(facSum.nUnique, 2);

    const edited = await runtime.editTableCell({ name: 'df', rowIndex: 4, colName: 'y', value: '10' });
    assert.equal(edited.ok, true);
    const addedRow = await runtime.addTableRow({ name: 'df' });
    assert.equal(addedRow.ok, true);
    assert.equal(addedRow.totalRows, 6);
    const addedCol = await runtime.addTableCol({ name: 'df', colName: 'score', defaultValue: '100' });
    assert.equal(addedCol.ok, true);
    assert.equal(addedCol.totalCols, 4);

    const csvOut = await runtime.exportTableCsv({ name: 'df' });
    assert.equal(csvOut.ok, true);
    assert.match(csvOut.csv, /score/);

    // 4. Save & load a real .RData file via loadDataFile()
    await runtime.runCode(`loaded_df <- data.frame(id = 1:4, val = c(10, 20, 30, 40)); save(loaded_df, file = ${JSON.stringify(rdataPath)}); rm(loaded_df)`, { capturePlots: false });
    const loaded = await runtime.loadDataFile(rdataPath);
    assert.equal(loaded.ok, true, loaded.error);
    assert.ok(loaded.objects.includes('loaded_df'));
    assert.ok(loaded.loadedDatasets.includes('loaded_df'));
    assert.ok(loaded.snapshot.datasets.loaded_df);

    // 5. Function Help & Usage + Examples lookup (for Hover & Signature Help)
    const helpLm = await runtime.getFunctionHelp('lm');
    assert.equal(helpLm.ok, true);
    assert.match(helpLm.usage, /^lm\(/);
    assert.ok(helpLm.params.includes('formula'));
    assert.ok(helpLm.description.length > 10);
    assert.ok(helpLm.examples.length > 10, 'expected non-empty examples for lm');

    const helpDnorm = await runtime.getFunctionHelp('dnorm');
    assert.equal(helpDnorm.ok, true);
    assert.ok(helpDnorm.params.includes('mean'));

    // 6. Verify r-commander-play run_code settings take effect live in R
    const limRes = await runtime.runCode('1:100', {
      capturePlots: false,
      limitOutput: true,
      maxOutputItems: 5,
      syntaxColors: false
    });
    assert.equal(limRes.ok, true);
    assert.match(limRes.stdout, /omitted 95 entries/i);

    const fixedRes = await runtime.runCode('2.789e-05', {
      capturePlots: false,
      fixedNotation: true,
      syntaxColors: false
    });
    assert.equal(fixedRes.ok, true);
    assert.match(fixedRes.stdout, /0\.00002789/);

    const skipRes = await runtime.runCode('?mean\n1 + 1', {
      capturePlots: false,
      skipHelp: true,
      syntaxColors: false
    });
    assert.equal(skipRes.ok, true);
    assert.match(skipRes.stdout, /\[1\] 2/);
  } finally {
    runtime.stopSession();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
