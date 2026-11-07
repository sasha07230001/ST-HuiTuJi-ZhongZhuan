#!/usr/bin/env node
/**
 * 把 dist/index.js 提交进仓库。
 *
 * 为什么需要:酒馆加载的是 manifest.json 里 `js` 指向的**构建产物**。
 * 本项目 .gitignore 忽略了 dist/,于是「git pull 之后什么都没变」——
 * 用户拿到的永远是自己上次 build 出来的那个旧包(这次就是 v0.3.0 的包
 * 配上 v0.6.0 的源码,表现为「全部新功能都不存在」)。
 *
 * 做法:给 dist/index.js 打上 `dist` 分支的 --force,直接在 .gitignore 里开洞,
 * 这样普通 `git add -A` 也会带上它,而且不需要每次 -f。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitignorePath = path.join(root, '.gitignore');
const distFile = path.join(root, 'dist', 'index.js');

const NEEDED = ['!dist/', '!dist/index.js'];

const rule = '!dist/index.js';
const text = fs.readFileSync(gitignorePath, 'utf8');
const lines = text.split('\n').map(l => l.trim());
if (!lines.includes(rule)) {
  // .gitignore 的规则是后写覆盖先写:必须放在 `dist/` 之后
  const next = text.replace(/^dist\/\s*$/m, 'dist/\n!dist/\n!dist/index.js');
  const out = next === text ? `${text.replace(/\s*$/, '\n')}${NEEDED.join('\n')}\n` : next;
  fs.writeFileSync(gitignorePath, out, 'utf8');
  console.log('[track-dist] .gitignore 已放行 dist/index.js');
} else {
  console.log('[track-dist] .gitignore 已包含放行规则');
}

if (!fs.existsSync(distFile)) {
  console.error('[track-dist] 没有 dist/index.js,先 npm run build');
  process.exit(1);
}

try {
  execFileSync('git', ['add', '-f', 'dist/index.js'], { cwd: root, stdio: 'inherit' });
  console.log('[track-dist] 已 git add -f dist/index.js');
} catch (error) {
  console.error('[track-dist] git add 失败(仓库还没初始化?)', error?.message ?? error);
}

const size = fs.statSync(distFile).size;
console.log(`[track-dist] dist/index.js ${(size / 1024).toFixed(1)} KB`);
