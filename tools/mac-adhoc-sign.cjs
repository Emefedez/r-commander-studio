'use strict';

// electron-builder afterPack hook. Without an Apple "Developer ID Application" certificate,
// electron-builder skips code signing entirely. On Apple Silicon that leaves the bundle with the
// stock Electron signature, which no longer matches once our resources/Info.plist are added, so
// macOS reports the app as "damaged and can't be opened". An ad-hoc signature ("-") makes the
// bundle valid again; Gatekeeper then only asks the user to confirm an unidentified developer.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};
