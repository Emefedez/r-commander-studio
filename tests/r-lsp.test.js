'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeLspMessage,
  LspMessageParser,
  extractRmdChunks,
  checkRSyntax,
  RLanguageServer
} = require('../main/r-lsp');

test('LSP Content-Length JSON-RPC framing handles UTF-8, split chunks, and batched frames', () => {
  const msg1 = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { note: 'Español — áéíóú 🚀' } };
  const msg2 = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.R', diagnostics: [] } };

  const wire = Buffer.concat([encodeLspMessage(msg1), encodeLspMessage(msg2)]);
  const parser = new LspMessageParser();
  const received = [];
  parser.on('message', (m) => received.push(m));

  // Feed byte-by-byte / tiny irregular slices to test streaming reassembly
  const cuts = [0, 7, 19, 25, 60, wire.length];
  for (let i = 0; i < cuts.length - 1; i++) {
    parser.push(wire.slice(cuts[i], cuts[i + 1]));
  }

  assert.equal(received.length, 2);
  assert.deepEqual(received[0], msg1);
  assert.deepEqual(received[1], msg2);
});

test('extractRmdChunks preserves exact 1-based line offsets across multiple chunks', () => {
  const rmd = [
    '---',                      // 1
    'title: "Test"',            // 2
    '---',                      // 3
    '',                         // 4
    'Intro paragraph.',         // 5
    '',                         // 6
    '```{r chunk1}',            // 7
    'x <- 1 + 2',               // 8
    'y <- x * 3',               // 9
    '```',                      // 10
    '',                         // 11
    'More prose here.',         // 12
    '```{r chunk2, echo=TRUE}', // 13
    'z <- y + (',               // 14 (broken syntax!)
    '```'                       // 15
  ].join('\n');

  const { code, chunks, hasR } = extractRmdChunks(rmd);
  assert.equal(hasR, true);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].startLine, 8);
  assert.equal(chunks[0].endLine, 9);
  assert.equal(chunks[1].startLine, 14);
  assert.equal(chunks[1].endLine, 14);

  const lines = code.split('\n');
  assert.equal(lines[7], 'x <- 1 + 2'); // line 8 (0-based 7)
  assert.equal(lines[8], 'y <- x * 3'); // line 9 (0-based 8)
  assert.equal(lines[13], 'z <- y + ('); // line 14 (0-based 13)
  assert.equal(lines[4], ''); // prose blanked out
});

test('checkRSyntax: valid R returns 0 diagnostics and broken R returns exact line/col error', async () => {
  const valid = await checkRSyntax('x <- 1:10\nmean(x)\n');
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.diagnostics, []);

  const broken = await checkRSyntax('x <- 1\ny <- 2 + * 3\nz <- 4\n');
  assert.equal(broken.ok, true);
  assert.equal(broken.diagnostics.length, 1);
  assert.equal(broken.diagnostics[0].severity, 'error');
  assert.equal(broken.diagnostics[0].startLineNumber, 2);
  assert.ok(broken.diagnostics[0].startColumn >= 8, `expected col >= 8, got ${broken.diagnostics[0].startColumn}`);
  assert.match(broken.diagnostics[0].message, /unexpected/i);
});

test('checkRSyntax on .Rmd maps R chunk syntax error to exact .Rmd line number', async () => {
  const rmd = [
    '---',
    'title: "Error Line Mapping"',
    '---',
    '',
    '# Heading',
    'Some text.',
    '```{r broken}',
    'a <- 10',
    'b <- a + )',
    '```'
  ].join('\n');

  const res = await checkRSyntax(rmd, { isRmd: true });
  assert.equal(res.ok, true);
  assert.equal(res.diagnostics.length, 1);
  assert.equal(res.diagnostics[0].severity, 'error');
  assert.equal(res.diagnostics[0].startLineNumber, 9, `expected error on Rmd line 9, got ${res.diagnostics[0].startLineNumber}`);
});

test('RLanguageServer initializes languageserver::run() and emits diagnostics cleanly', async () => {
  const lsp = new RLanguageServer();
  try {
    const started = await lsp.start();
    assert.equal(started, true, 'languageserver should initialize on this machine');
    assert.equal(lsp.status, 'ready');

    const diags = await lsp.didOpen('inmemory://test/broken.R', 'x <- 1\ny <- (2 + 3\n');
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');

    const clean = await lsp.didChange('inmemory://test/broken.R', 'x <- 1\ny <- (2 + 3)\n');
    assert.deepEqual(clean, []);
    lsp.didClose('inmemory://test/broken.R');
  } finally {
    lsp.stop();
  }
});
