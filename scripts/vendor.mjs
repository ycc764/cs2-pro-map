/**
 * 把前端用到的 ESM 依赖复制到 public/vendor/，配合 index.html 里的 import map，
 * 浏览器就能直接跑源码 —— 不需要打包器（本沙箱里 vite/esbuild 会 spawn EPERM）。
 *
 * 用法：node scripts/vendor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'public/vendor';

/* 依赖 → 需要复制的目录（src 是 ESM 源码，浏览器可直接加载） */
const PACKAGES = [
  { name: 'd3-geo', from: 'node_modules/d3-geo/src', to: 'd3-geo' },
  { name: 'd3-array', from: 'node_modules/d3-array/src', to: 'd3-array' },
  { name: 'internmap', from: 'node_modules/internmap/src', to: 'internmap' },
  { name: 'topojson-client', from: 'node_modules/topojson-client/src', to: 'topojson-client' },
  { name: 'three', from: 'node_modules/three/build/three.module.js', to: 'three.module.js' },
];

/* 已知的裸模块引用 → import map 里的映射名（用于自检） */
const EXPECTED_BARE = new Set(['d3-array', 'internmap']);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const bareFound = new Set();

for (const p of PACKAGES) {
  const dest = path.join(OUT, p.to);
  if (!fs.existsSync(p.from)) {
    console.error(`✗ 缺少 ${p.from}，请先 npm install --ignore-scripts`);
    process.exitCode = 1;
    continue;
  }
  fs.cpSync(p.from, dest, { recursive: true });
  console.log(`✓ ${p.name} → ${dest}`);
}

/* 自检：扫出所有裸模块 import，确认 import map 覆盖得到 */
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) scan(full);
  }
}
function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('http')) continue;
    if (/[\s+${}]/.test(spec)) continue; // 压缩代码里的字符串拼接，误报
    bareFound.add(spec);
  }
}
walk(OUT);

const missing = [...bareFound].filter((s) => !EXPECTED_BARE.has(s));
console.log(`\n裸模块引用: ${[...bareFound].join(', ') || '（无）'}`);
if (missing.length) {
  console.warn(`⚠ 未在 import map 中登记的裸模块: ${missing.join(', ')} —— 请补进 index.html`);
} else {
  console.log('import map 覆盖完整 ✅');
}
