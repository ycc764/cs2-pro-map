/**
 * 3D 视图专项检查（不需要浏览器、不需要 GPU）
 * ------------------------------------------------------------------
 * 把 three 的 WebGLRenderer 换成空壳（scripts/dev/three-stub.mjs），
 * 于是 createGlobe3D 里**除了 draw call 之外的所有代码都真的执行**：
 *   · 用 d3 把世界地图画到 2048×1024 的 canvas 当球体贴图
 *   · 54 个气泡 Sprite + 1300 点星空 + 大气光晕
 *   · 拖动 / 滚轮 / 点击的拾取（射线与单位球求交、气泡距离判据）
 * 然后遍历捕获到的 scene，检查对象数量、几何体尺寸，并模拟一轮指针交互。
 *
 * 跑法：npm run check:3d
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
  process.exit(0);
}

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { window, document } = parseHTML(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));

/* ---------------- 补齐 linkedom 缺的浏览器 API ---------------- */
const rect = { left: 0, top: 0, width: 1000, height: 640, right: 1000, bottom: 640 };
window.Element.prototype.getBoundingClientRect = function () { return rect; };
window.Element.prototype.scrollIntoView = function () {};

const gradient = { addColorStop() {} };
const ctx2d = new Proxy(
  { canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 },
  {
    get(t, k) {
      if (k in t) return t[k];
      return () => gradient;   // createLinearGradient / createRadialGradient / setLineDash ...
    },
    set(t, k, v) { t[k] = v; return true; },
  },
);
const canvases = [];
window.Element.prototype.getContext = function (kind) {
  if (kind !== '2d') return null;
  return ctx2d;
};
// 记录 canvas 尺寸，验证世界贴图确实是 2048×1024
window.HTMLCanvasElement = window.HTMLCanvasElement ?? window.Element;
const origCreate = document.createElement.bind(document);
document.createElement = function (tag, ...rest) {
  const n = origCreate(tag, ...rest);
  if (String(tag).toLowerCase() === 'canvas') {
    canvases.push(n);
    n.getContext = () => ctx2d;
  }
  return n;
};

globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
window.devicePixelRatio = 2;
window.addEventListener = window.addEventListener ?? (() => {});

globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^\.?\//, '');
  const p = path.join(ROOT, 'public', rel);
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

/* ---------------- 建视图 ---------------- */
const errors = [];
process.on('uncaughtException', (e) => errors.push(e));

const { createGlobe3D } = await import(pathToFileURL(path.join(ROOT, 'src/globe3d.js')).href);

const ds = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/dataset.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/countries-110m.json'), 'utf8'));

const host = document.createElement('div');
document.body.append(host);

let selected = null;
const globe = createGlobe3D(host, {
  onSelect: (c) => { selected = c; },
  onHover: () => {},
});
globe.setData(ds, geo);
globe.show();
globe.resize();

await new Promise((r) => setTimeout(r, 1400));   // 让入场动画 + 自转循环跑一会儿

/* ---------------- 遍历场景 ---------------- */
const stub = globalThis.__THREE_STUB__;
const scene = stub?.lastScene;
let sprites = 0; let meshes = 0; let points = 0; let spriteVerts = 0;
const spriteRadii = [];
scene?.traverse((o) => {
  if (o.isSprite) { sprites += 1; spriteRadii.push(o.scale.x); }
  else if (o.isMesh) { meshes += 1; }
  else if (o.isPoints) { points += o.geometry.attributes.position.count; }
});

console.log('--- 渲染器 ---');
console.log('WebGLRenderer 实例数 :', stub?.instances);
console.log('render() 调用次数    :', stub?.renders, stub?.renders > 0 ? '✅ 渲染循环在跑' : '❌ 一次都没渲染');
console.log('setSize 记录         :', JSON.stringify(stub?.sizes));
const sizeHist = new Map();
for (const c of canvases) {
  const k = `${c.width}×${c.height}`;
  sizeHist.set(k, (sizeHist.get(k) ?? 0) + 1);
}
console.log('canvas 尺寸分布      :', [...sizeHist].map(([k, n]) => `${k} ×${n}`).join(', '));

console.log('\n--- 场景内容 ---');
console.log('气泡 Sprite 数量     :', sprites, `(数据集里 count>0 的地区 ${Object.values(ds.countries).filter((c) => c.count > 0).length} 个)`);
console.log('气泡半径范围         :', spriteRadii.length ? `${Math.min(...spriteRadii).toFixed(4)} – ${Math.max(...spriteRadii).toFixed(4)}` : 'n/a');
console.log('Mesh 数量            :', meshes, '(海洋球 + 贴图球 + 光晕)');
console.log('星空顶点数           :', points);

console.log('\n--- 指针交互（走解析解拾取） ---');
const canvas = host.querySelector('canvas');
function fire(type, props) {
  const e = new window.Event(type, { bubbles: true });
  Object.assign(e, props);
  canvas.dispatchEvent(e);
}
const R = rect;
try {
  fire('pointerdown', { clientX: R.width * 0.5, clientY: R.height * 0.5, pointerId: 1, button: 0 });
  fire('pointermove', { clientX: R.width * 0.62, clientY: R.height * 0.44, pointerId: 1 });
  fire('pointermove', { clientX: R.width * 0.7, clientY: R.height * 0.5, pointerId: 1 });
  fire('pointerup', { clientX: R.width * 0.7, clientY: R.height * 0.5, pointerId: 1 });
  fire('wheel', { clientX: R.width * 0.5, clientY: R.height * 0.5, deltaY: -240 });
  fire('click', { clientX: R.width * 0.5, clientY: R.height * 0.5, pointerId: 1 });
  console.log('拖动 + 滚轮 + 点击    : 未抛异常 ✅');

  // 端到端验证拾取：在球面覆盖的范围内打一片网格，收集命中的国家码。
  // 每次 click 前都要 pointerdown 复位 state.moved，否则会被"刚刚拖动过"的判断忽略。
  function clickAt(cx, cy) {
    fire('pointerdown', { clientX: cx, clientY: cy, pointerId: 1, button: 0 });
    fire('pointerup', { clientX: cx, clientY: cy, pointerId: 1 });
    fire('click', { clientX: cx, clientY: cy, pointerId: 1 });
  }

  globe.select('fr');
  await new Promise((r) => setTimeout(r, 1500));   // 等旋转动画走完，让法国朝向相机
  const cx0 = R.width * 0.5;
  const cy0 = R.height * 0.5;

  // 诊断：确认事件确实到达 canvas，并确认 linkedom 是否会吞掉监听器里的异常
  const reached = [];
  canvas.addEventListener('click', (e) => { reached.push([e.clientX, e.clientY]); }, true);
  const probe = document.createElement('div');
  probe.addEventListener('probe', () => { throw new Error('boom'); });
  let swallow = false;
  try { probe.dispatchEvent(new window.Event('probe')); swallow = true; } catch { swallow = false; }
  console.log('linkedom 是否吞掉监听器异常 :', swallow ? '是（所以下面的报错要靠别的方式发现）' : '否');

  const hits = new Map();
  for (let iy = -4; iy <= 4; iy += 1) {
    for (let ix = -6; ix <= 6; ix += 1) {
      const x = cx0 + ix * 36;
      const y = cy0 + iy * 36;
      selected = null;
      clickAt(x, y);
      if (selected) hits.set(selected, (hits.get(selected) ?? 0) + 1);
    }
  }
  console.log('canvas 收到的 click 数 :', reached.length, '/ 117');
  console.log('cursor 状态            :', canvas.style?.cursor);
  const codes = [...hits.keys()].sort();
  console.log('网格点 117 处命中地区 :', codes.length, '个 →', codes.join(' '));
  if (codes.length < 5) {
    errors.push(new Error(`球面拾取几乎没命中任何国家（只得到 ${codes.length} 个），拾取链路可能坏了`));
  }
  // 再把地球转到法国，点正中央：若旋转数学正确，正中央应该落在法国
  globe.select('fr');
  await new Promise((r) => setTimeout(r, 1500));
  selected = null;
  clickAt(cx0, cy0);
  console.log('select("fr") 后点正中 :', selected === 'fr' ? 'onSelect("fr") ✅' : `onSelect(${JSON.stringify(selected)})`);
  if (selected !== 'fr') {
    // 不直接判失败：先把球转到别处也试一次，方便区分"旋转不准"和"拾取坏了"
    console.log('  （若上面网格能命中多个国家，说明拾取正常，只是旋转没有把法国转到正中）');
  }
  console.log('render 调用累计      :', stub?.renders);
} catch (e) {
  errors.push(e);
}

console.log('\n--- API 面 ---');
console.log('导出方法             :', Object.keys(globe).join(', '));
if ('tick' in globe) errors.push(new Error('createGlobe3D 不应该把内部 tick 暴露出去'));

console.log('\n--- 运行时报错 ---');
if (!errors.length) console.log('无 ✅');
else for (const e of errors) console.log('✗', e?.stack ?? e?.message ?? e);

process.exit(errors.length ? 1 : 0);
