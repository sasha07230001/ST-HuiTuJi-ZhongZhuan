// 用 src/types.ts 里的 BUILTIN_WORKFLOW 直接出图,确认「点载入内置工作流」真的能跑通。
// 进 dist 之前先用 vite-node 的等价做法:把 types.ts 转成临时 mjs 再 import。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188';

// 直接读源码里的那一个 JSON 字面量太脆;用 esbuild(vite 自带)转一下 TypeScript 更稳。
const tmp = path.join(ROOT, '.builtin.mjs');
execFileSync(
  process.execPath,
  [path.join(ROOT, 'node_modules/esbuild/bin/esbuild'), path.join(ROOT, 'src/types.ts'), '--format=esm', `--outfile=${tmp}`],
  { stdio: 'inherit' },
);

const { BUILTIN_WORKFLOW } = await import(pathToFileURL(tmp).href);

// 与 src/comfy/workflow.ts 同构的渲染
const PLACEHOLDER_PATTERN = /%([a-z][a-z0-9_]*)%/g;
function replace(value, repl) {
  if (typeof value === 'string') {
    const exact = value.match(/^%([a-z][a-z0-9_]*)%$/);
    if (exact && Object.hasOwn(repl, exact[1])) return repl[exact[1]];
    return value.replace(PLACEHOLDER_PATTERN, (m, name) => (Object.hasOwn(repl, name) ? String(repl[name]) : m));
  }
  if (Array.isArray(value)) return value.map(v => replace(v, repl));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v, repl)]));
  }
  return value;
}

const prompt =
  'masterpiece, best quality, 1girl, solo, long black hair, red eyes, black coat, standing on rooftop, storm clouds, lightning, dramatic lighting, low angle';
const negative = 'worst quality, low quality, blurry, bad anatomy, watermark';
const seed = Date.now() % 1000000;
const workflow = replace(JSON.parse(BUILTIN_WORKFLOW), { prompt, negative_prompt: negative, seed });
console.log('seed =', seed);

const submit = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow }),
});
const queued = await submit.json();
if (!submit.ok || !queued.prompt_id) {
  console.error('SUBMIT FAILED', submit.status, JSON.stringify(queued, null, 2).slice(0, 1200));
  process.exit(1);
}

const startedAt = Date.now();
let file = null;
while (!file) {
  if (Date.now() - startedAt > 600000) throw new Error('timeout');
  const history = await (await fetch(`${BASE}/history/${queued.prompt_id}`)).json();
  const item = history[queued.prompt_id];
  if (item?.status?.status_str === 'error') {
    console.error(
      'EXECUTION FAILED\n' +
        (item.status.messages || [])
          .filter(m => Array.isArray(m) && m[0] === 'execution_error')
          .map(m => `${m[1]?.node_type}[${m[1]?.node_id}]: ${m[1]?.exception_message}`)
          .join('\n'),
    );
    process.exit(1);
  }
  for (const output of Object.values(item?.outputs || {})) {
    const hit = (output.images || []).find(x => x.filename);
    if (hit) file = hit;
  }
  if (!file) await new Promise(r => setTimeout(r, 500));
}
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`SUCCESS with BUILTIN_WORKFLOW: ${file.filename} in ${seconds}s`);

const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: 'output' });
const buf = Buffer.from(await (await fetch(`${BASE}/view?${query}`)).arrayBuffer());
fs.writeFileSync(path.join(ROOT, '.builtin-check.png'), buf);
fs.rmSync(tmp, { force: true });
console.log(`saved .builtin-check.png (${(buf.length / 1024).toFixed(0)} KB)`);
