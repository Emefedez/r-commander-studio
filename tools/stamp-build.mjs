#!/usr/bin/env node
// Writes shared/build-info.json (version, git commit, build date) so the app
// can show exactly which build is installed (Help > Builds).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const info = {
  version: pkg.version,
  commit: process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : git('rev-parse', '--short', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  date: new Date().toISOString(),
  source: process.env.GITHUB_ACTIONS ? 'ci' : 'local'
};
fs.writeFileSync(path.join(root, 'shared', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: v${info.version} ${info.commit}${info.dirty ? '+dirty' : ''} (${info.source})`);
