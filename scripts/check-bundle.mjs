// 校验构建产物里确实带上了关键片段(Prod 会压缩,只查稳定的字面量)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'dist/index.js'), 'utf8');

const checks = [
  ['悬浮球 pointer-events:auto', /htj-zz-orb[\s\S]{0,700}?pointer-events:\s*auto/.test(src)],
  ['悬浮球超高 z-index', src.includes('2147483000')],
  ['面板遮罩 z-index', src.includes('2147483001')],
  ['page 带 data-page', src.includes('data-page') || /dataset\.page/.test(src)],
  ['原位回插的图片块', src.includes('htj-zz-inline-image')],
  ['图库容器', src.includes('htj-zz-gallery')],
  ['IndexedDB 库名', src.includes('htj-zz-db')],
  ['移动端断点', src.includes('max-width: 720px')],
  ['dvh 满屏', src.includes('100dvh')],
  ['自动插图诊断前缀', src.includes('[HTJ-ZZ][auto]')],
  ['分段预览容器', src.includes('htj-zz-segment-row')],
];

let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'MISS'}  ${label}`);
}
console.log(`\nbundle: ${(src.length / 1024).toFixed(1)} KB`);
process.exit(bad === 0 ? 0 : 1);
