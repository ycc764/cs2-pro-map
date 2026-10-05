/**
 * 浏览器无关的「能不能启动」检查：用 linkedom 造一个 DOM，
 * 把 src/main.js 真正跑一遍，抓任何运行时报错。
 *
 * 需要一次性安装 linkedom（不写进 package.json）：
 *   npm install linkedom --no-save --ignore-scripts
 *
 * 运行：
 *   npm run check:boot
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// linkedom 是开发期依赖，刻意没写进 package.json，交付目录里通常也没有 node_modules。
// 缺了就友好跳过，不要甩一段 ERR_MODULE_NOT_FOUND 堆栈给用户。
let parseHTML;
try {
  ({ parseHTML } = await import('linkedom'));
} catch {
  console.log('⚠ 跳过：这个自检需要 linkedom（开发期依赖，未随交付目录分发）');
  console.log('  在本目录执行一次即可：npm install linkedom --no-save --ignore-scripts');
  console.log('  只装了运行时依赖的话，`npm test` 已经覆盖了数据与模块解析，可以不用跑本项。');
  process.exit(0);
}

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const { window, document } = parseHTML(html);

/* ---------- 补齐 linkedom 没有的东西 ---------- */
const rect = { left: 0, top: 0, width: 900, height: 620, right: 900, bottom: 620 };
window.Element.prototype.getBoundingClientRect = function () {
  return rect;
};
window.Element.prototype.scrollIntoView = function () {};

const ctx2d = new Proxy(
  { canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 },
  {
    get(t, k) {
      if (k in t) return t[k];
      return () => ({ addColorStop() {} });
    },
    set(t, k, v) { t[k] = v; return true; },
  },
);
window.Element.prototype.getContext = function (kind) {
  if (kind === '2d') return ctx2d;
  return null; // webgl 一律失败 → 走 main.js 的 2D 回退分支
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const errors = [];
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.addEventListener = window.addEventListener ?? (() => {});
window.devicePixelRatio = 2;

globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^\.?\//, '');
  const p = path.join(ROOT, 'public', rel);
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

window.onerror = (e) => errors.push(e);
process.on('uncaughtException', (e) => { errors.push(e); });

/* ---------- 跑起来 ---------- */
console.log('--- 导入 src/main.js ---');
await import(pathToFileURL(path.join(ROOT, 'src/main.js')).href);

await new Promise((r) => setTimeout(r, 1500));

const $ = (s) => document.querySelector(s);
console.log('\n--- 启动后的 DOM 状态 ---');
console.log('meta-badge   :', $('#meta-badge')?.textContent);
console.log('view-loading :', $('#view-loading') ? '仍然存在（说明 boot 没跑完）' : '已移除 ✅');
console.log('左侧国家行数 :', $('#left-list')?.querySelectorAll('.row').length);
console.log('2D 国家 path :', $('#view2d')?.querySelectorAll('path.country').length);
console.log('2D 气泡      :', $('#view2d')?.querySelectorAll('circle').length);
console.log('2D 标签      :', $('#view2d')?.querySelectorAll('text').length);
console.log('错误遮罩可见 :', $('#crash') && !$('#crash').hasAttribute('hidden') ? '是（有致命错误）' : '否 ✅');

/* ---------- 交互冒烟 ---------- */
console.log('\n--- 交互冒烟 ---');
try {
  const firstRow = $('#left-list')?.querySelector('.row');
  firstRow?.dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 1200));
  console.log('点击左侧第一行 → 详情标题:', $('#detail')?.querySelector('h2')?.textContent);
  console.log('详情里的选手行数:', $('#detail')?.querySelectorAll('.player').length);
  const search = $('#search');
  search.value = 'zywoo';
  search.dispatchEvent(new window.Event('input'));
  await new Promise((r) => setTimeout(r, 500));
  console.log('搜索 zywoo → 建议条数:', $('#suggest')?.querySelectorAll('button').length);
} catch (e) {
  errors.push(e);
}

console.log('\n--- 运行时报错 ---');
if (!errors.length) console.log('无 ✅');
else for (const e of errors) console.log('✗', e?.stack ?? e?.message ?? e);

process.exit(errors.length ? 1 : 0);
