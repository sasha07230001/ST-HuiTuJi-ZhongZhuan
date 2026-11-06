// 端到端验证:用真实的 Anima Turbo txt2img 工作流跑一遍「渲染 -> 提交 -> 轮询 -> 取图」。
// 用法: node scripts/live-check.mjs
const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188';

// 取自本机 Anima Studio 的 txt2img 工作流(已去掉 LoRA 节点,免得依赖本地 lora 文件)
const WORKFLOW = JSON.stringify({
  '1': {
    class_type: 'UNETLoader',
    inputs: { unet_name: 'anima-turbo-v1.1.safetensors', weight_dtype: 'default' },
  },
  '4': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' },
  },
  '5': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 0] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 0] } },
  '8': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
  '9': {
    class_type: 'KSampler',
    inputs: {
      seed: '%seed%',
      steps: 8,
      cfg: 1.0,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1.0,
      model: ['1', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['8', 0],
    },
  },
  '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['5', 0] } },
  '11': { class_type: 'SaveImage', inputs: { filename_prefix: 'htj-zz-livecheck', images: ['10', 0] } },
});

// 与 src/comfy/workflow.ts 同构的占位符替换
const PLACEHOLDER_PATTERN = /%([a-z][a-z0-9_]*)%/g;
function collect(value, found) {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER_PATTERN)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach(v => collect(v, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => collect(v, found));
}
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

const parsed = JSON.parse(WORKFLOW);
const found = new Set();
collect(parsed, found);
console.log('workflow placeholders:', [...found].sort().join(', '));

// 模拟中转站编译出来的提示词
const prompt =
  'masterpiece, best quality, 1girl, solo, silver hair, blue eyes, white dress, standing in rain, night city, wet street, reflections, cinematic lighting, depth of field';
const negative = 'worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text';
const seed = Date.now() % 1000000;

const workflow = replace(parsed, { prompt, negative_prompt: negative, seed });

const submit = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: workflow }),
});
const queued = await submit.json();
if (!submit.ok || !queued.prompt_id) {
  console.error('SUBMIT FAILED', submit.status, JSON.stringify(queued, null, 2).slice(0, 1500));
  process.exit(1);
}
console.log('queued prompt_id =', queued.prompt_id, '| seed =', seed);

const startedAt = Date.now();
let file = null;
while (!file) {
  if (Date.now() - startedAt > 600000) throw new Error('timeout');
  const history = await (await fetch(`${BASE}/history/${queued.prompt_id}`)).json();
  const item = history[queued.prompt_id];
  if (item?.status?.status_str === 'error') {
    const msg = (item.status.messages || [])
      .filter(m => Array.isArray(m) && m[0] === 'execution_error')
      .map(m => `${m[1]?.node_type}[${m[1]?.node_id}]: ${m[1]?.exception_message}`)
      .join('\n');
    console.error('EXECUTION FAILED\n' + msg);
    process.exit(1);
  }
  for (const output of Object.values(item?.outputs || {})) {
    const hit = (output.images || []).find(x => x.filename);
    if (hit) file = hit;
  }
  if (!file) await new Promise(r => setTimeout(r, 500));
}
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`SUCCESS: ${file.filename} in ${seconds}s`);

const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
const img = await fetch(`${BASE}/view?${query}`);
const buf = Buffer.from(await img.arrayBuffer());
const fs = await import('node:fs');
const path = await import('node:path');
const outPath = path.join(process.cwd(), `.livecheck.${file.filename.split('.').pop()}`);
fs.writeFileSync(outPath, buf);
console.log(`saved ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
