'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteSuperscripts, rewriteSuperscriptsInRmd } = require('../shared/r-superscripts');

test('superscripts become ^ exponents', () => {
  assert.equal(rewriteSuperscripts('6*1.8093²'), '6*1.8093^2');
  assert.equal(rewriteSuperscripts('x³ + y²'), 'x^3 + y^2');
  assert.equal(rewriteSuperscripts('2¹⁰'), '2^10');
  assert.equal(rewriteSuperscripts('x⁻¹'), 'x^(-1)');
  assert.equal(rewriteSuperscripts('e⁽ⁿ⁺¹⁾'), 'e^(n+1)');
  assert.equal(rewriteSuperscripts('x⁰·⁵'), 'x^0.5');
  assert.equal(rewriteSuperscripts('(a+b)²/n'), '(a+b)^2/n');
  assert.equal(rewriteSuperscripts('sqrt(sum((x-mean(x))²))'), 'sqrt(sum((x-mean(x))^2))');
});

test('strings, backtick names and comments are untouched', () => {
  assert.equal(rewriteSuperscripts('cat("m²", x²) # área m²'), 'cat("m²", x^2) # área m²');
  assert.equal(rewriteSuperscripts("`R²` <- r²"), '`R²` <- r^2');
  assert.equal(rewriteSuperscripts('r"(a²)" ; 3²'), 'r"(a²)" ; 3^2');
  assert.equal(rewriteSuperscripts('x <- 1:3'), 'x <- 1:3');
});

test('R Markdown: only R chunks and inline r code change', () => {
  const rmd = '# Área en m²\n\n```{r}\ny <- 6*1.8093²\n```\n\nValor: `r 2³`\n';
  assert.equal(rewriteSuperscriptsInRmd(rmd), '# Área en m²\n\n```{r}\ny <- 6*1.8093^2\n```\n\nValor: `r 2^3`\n');
});
