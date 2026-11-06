// 校验构建产物里确实带上了本轮修复的关键片段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'dist/index.js'), 'utf8');

const checks = [
  ['悬浮球 pointer-events:auto', /htj-zz-orb[\s\S]{0,700}?pointer-events:\s*auto/.test(src)],
  ['悬浮球超高 z-index', src.includes('2147483000')],
  ['面板遮罩 z-index', src.includes('2147483001')],
  ['page 带 data-page', /dataset\.page\s*=\s*"render"|dataset\.page="render"|\.page="render"/.test(src)],
  ['卡片按 class 查找', src.includes('.htj-zz-card[data-seq=')],
  ['出图后调 updateMessageBlock', src.includes('updateMessageBlock')],
  ['切换页签初始化调用', src.includes('is-active')],
];

let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'MISS'}  ${label}`);
}
console.log(`\nbundle: ${(src.length / 1024).toFixed(1)} KB`);
process.exit(bad === 0 ? 0 : 1);
