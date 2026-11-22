'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RRuntime } = require('../main/r-runtime');

test('RRuntime persistent session runs R code, captures SVG plots, and inspects workspace via session_info()', async () => {
  const runtime = new RRuntime();
  try {
    const env = await runtime.probeEnvironment();
    assert.ok(env.rVersion, 'expected R version');

    const run1 = await runtime.runCode(
      'df <- data.frame(x = 1:5, y = c(2, 4, 5, 4, 6), g = factor(c("a", "a", "b", "b", "b")))\n' +
        'fit <- lm(y ~ x, data = df)\n' +
        'plot(df$x, df$y, main = "Session Plot")\n' +
        'mean(df$y)\n',
      { capturePlots: true }
    );
    assert.equal(run1.ok, true, `runCode stderr: ${run1.stderr}`);
    assert.match(run1.stdout, /4\.2/);
    assert.ok(run1.plots.length >= 1, 'expected at least 1 captured SVG plot');
    assert.ok(run1.plots[0].includes('<svg'));

    const snap = await runtime.snapshot();
    assert.ok(snap.datasets.df, 'expected df dataset in workspace snapshot');
    assert.equal(snap.datasets.df.rows, 5);
    assert.equal(snap.datasets.df.columns, 3);
    assert.ok(snap.datasets.df.vars.some((v) => v.name === 'g' && v.kind === 'factor' && v.levels === 2));
    assert.ok(snap.models.some((m) => m.name === 'fit' && m.cls === 'lm'));
  } finally {
    runtime.stopSession();
  }
});
