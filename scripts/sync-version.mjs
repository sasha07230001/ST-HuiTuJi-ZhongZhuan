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

/**
 * 顺手校验「manifest 说的 js」到底在不在。
 *
 * 这是踩过的最贵的一个坑:manifest 写着 `dist/index.js?ver=0.6.0`,
 * 而 dist/ 根本没构建 / 没跟着仓库走 —— 酒馆 `<script type="module">` 直接 404,
 * 既不报错到界面上,也不进扩展列表的警告,用户看到的就是「装了但完全没反应」。
 * 这里一旦发现缺产物就红字警告,别让它静静过。
 */
const jsFile = path.join(root, 'dist', js.split('?')[0]);
if (!fs.existsSync(jsFile)) {
  console.error('');
  console.error('  ⚠ manifest.json 指向的构建产物不存在:' + path.relative(root, jsFile));
  console.error('    酒馆会在加载扩展时 404,表现为「装了但没有任何反应」。');
  console.error('    修法:npm run build,然后 npm run track-dist(把产物提交进仓库)。');
  console.error('');
}
