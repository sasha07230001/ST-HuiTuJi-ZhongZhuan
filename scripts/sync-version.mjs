#!/usr/bin/env node
// 把 package.json 的版本号同步进 manifest.json,避免两处版本号漂移。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'manifest.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const version = String(pkg.version ?? '');
if (!version) {
  console.error('[sync-version] package.json 缺少 version');
  process.exit(1);
}

const js = `dist/index.js?ver=${version}`;
let changed = false;
if (manifest.version !== version) {
  manifest.version = version;
  changed = true;
}
if (manifest.js !== js) {
  manifest.js = js;
  changed = true;
}

if (changed) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[sync-version] manifest.json -> v${version}`);
} else {
  console.log(`[sync-version] 已是 v${version}`);
}
