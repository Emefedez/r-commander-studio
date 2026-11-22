#!/usr/bin/env node
/**
 * Copies the pure-JS R Commander catalog, form model, i18n, and runner.R
 * from r-commander-play into vendor/rcmdr/ so r-commander-studio is 100% self-contained.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const argSrcIndex = process.argv.indexOf('--src');
const sourceRoot = path.resolve(
  (argSrcIndex >= 0 && process.argv[argSrcIndex + 1]) ||
    process.env.RCMDR_PLAY_DIR ||
    '/home/m1-max/Work/r-commander-play'
);
const targetRoot = path.join(repoRoot, 'vendor', 'rcmdr');

if (!fs.existsSync(sourceRoot)) {
  console.error(`Source directory not found: ${sourceRoot}`);
  process.exit(1);
}

const filesToCopy = [
  'lib/formmodel.js',
  'lib/dialog.js',
  'lib/rhelpers.js',
  'lib/i18n.js',
  'lib/report.js',
  'data/tree.json',
  'data/commands.json',
  'data/functions.json',
  'data/rcmdr-names.txt',
  'i18n/es.json',
  'runner.R'
];

// Include every catalog/*.js file dynamically so all 371+ commands stay in sync.
const catalogSrcDir = path.join(sourceRoot, 'catalog');
const catalogFiles = fs
  .readdirSync(catalogSrcDir)
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => path.join('catalog', name));

const allFiles = [...catalogFiles, ...filesToCopy];

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });

let copied = 0;
for (const relPath of allFiles) {
  const from = path.join(sourceRoot, relPath);
  const to = path.join(targetRoot, relPath);
  if (!fs.existsSync(from)) {
    console.error(`Missing expected source file: ${from}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}

const commandsJson = JSON.parse(fs.readFileSync(path.join(targetRoot, 'data', 'commands.json'), 'utf8'));
const meta = {
  syncedAt: new Date().toISOString(),
  sourceRoot,
  fileCount: copied,
  commandCount: Object.keys(commandsJson).length
};
fs.writeFileSync(path.join(targetRoot, 'SYNC_META.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

console.log(`Synced ${copied} files (${meta.commandCount} commands) into ${targetRoot}`);
