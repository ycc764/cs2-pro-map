/**
 * 真·浏览器端到端检查（需要提权，因为 Chrome 在普通沙箱里起不来）
 * ------------------------------------------------------------------
 *   node scripts/dev/e2e-check.mjs [url] [--headed]
 *
 * 它做四件事：
 *   1. 用真实 Chrome 打开页面（走 CDP over TCP，不用命名管道）
 *   2. 收集所有 console.* 与未捕获异常
 *   3. 在页面里量一遍真实布局：viewport 尺寸、canvas 尺寸、SVG 元素数、遮罩状态
 *   4. 截图落盘，供人工（或模型）看
 *
 * 这是唯一能验证「视觉/布局」的手段——boot-check 用的假 DOM 把
 * getBoundingClientRect 写死成 900×620，CSS 塌成 0 高度它根本发现不了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep } from '../lib/browser.mjs';
import { connect } from '../lib/cdp.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const headed = process.argv.includes('--headed');
const PORT = 9444;

const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; };
  const vis = (el) => { if (!el) return '缺少元素';
    const s = getComputedStyle(el);
    return { display: s.display, visibility: s.visibility, opacity: s.opacity, overflow: s.overflow,
             zIndex: s.zIndex, rect: rect(el) }; };
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
    attr: c.width + 'x' + c.height,
    css: c.clientWidth + 'x' + c.clientHeight,
    display: getComputedStyle(c).display,
    visible: c.offsetParent !== null || getComputedStyle(c).position === 'fixed',
  }));
  const svgs = [...document.querySelectorAll('svg')].map((s) => ({
    id: s.id || null, cls: s.getAttribute('class'),
    display: getComputedStyle(s).display,
    rect: rect(s),
    paths: s.querySelectorAll('path').length,
    circles: s.querySelectorAll('circle').length,
    texts: s.querySelectorAll('text').length,
  }));
  let webgl = 'n/a';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    webgl = gl ? '可用 (' + gl.getParameter(gl.VERSION) + ')' : '不可用：三种 context 都返回 null';
  } catch (e) { webgl = '抛异常: ' + e.message; }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    webgl,
    ids: [...document.querySelectorAll('[id]')].map((e) => e.id),
    html: { cls: document.documentElement.className, bodyCls: document.body.className },
    viewport: vis(q('#viewport')),
    view3dHidden: q('#view3d')?.hidden,
    view2dHidden: q('#view2d')?.hidden,
    activeMode: q('.mode.active')?.dataset?.mode ?? q('.mode[aria-selected="true"]')?.dataset?.mode ?? '(无 .active)',
    localStorage: (() => { try { return JSON.stringify(localStorage); } catch (e) { return '不可用: ' + e.message; } })(),
    viewportChildren: q('#viewport') ? [...q('#viewport').children].map((c) => c.tagName + (c.id ? '#' + c.id : '') + (c.getAttribute('class') ? '.' + c.getAttribute('class') : '')) : [],
    canvases,
    svgs,
    countryRows: document.querySelectorAll('#country-list li, .country-row, [data-code]').length,
    loadingEl: vis(q('#view-loading')),
    crashEl: vis(q('#crash')),
    crashText: (q('#crash')?.innerText || '').slice(0, 1000),
    metaBadge: (q('.meta-badge') || q('.meta') || {}).textContent?.trim().slice(0, 200) ?? null,
    bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600),
  };
})()`;

const cdpEvents = [];
const errors = [];

let browser;
const profileDir = path.join(ROOT, '.tmp-profile', 'e2e');
// 每次跑都用全新 profile：否则上一轮点过的「2D 地图」会存进 localStorage 被恢复，
// 导致截的"3D 视图"其实是 2D——这个坑真踩过。
fs.rmSync(profileDir, { recursive: true, force: true });
try {
  browser = await launchBrowser({ port: PORT, headless: !headed, profileDir });
  console.log('Chrome 已启动 :', browser.exe);
} catch (e) {
  console.log('✗ Chrome 起不来 :', e.message);
  console.log('  （沙箱限制；请在提权模式下重跑，或在你自己的终端里跑）');
  process.exit(2);
}

try {
  const cdp = await connect(browser.cdpUrl);
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    cdpEvents.push(`[${p.type}] ${text}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push(`${d.exception?.description || d.text}  @ ${d.url || '?'}:${d.lineNumber}:${d.columnNumber}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error' || p.entry.level === 'warning') {
      cdpEvents.push(`[log:${p.entry.level}] ${p.entry.text} ${p.entry.url || ''}`);
    }
  });
  await cdp.send('Log.enable').catch(() => {});
  // profile 目录是复用的，不关缓存会拿到上一轮的数据集
  await cdp.send('Network.enable').catch(() => {});
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  }).catch(() => {});

  await cdp.goto(url);
  await sleep(4000);   // 等数据 fetch + 首帧渲染 + 入场动画

  const probe = await cdp.eval(PROBE);

  console.log('\n=== 页面基本 ===');
  console.log('title      :', probe.title);
  console.log('readyState :', probe.readyState);
  console.log('WebGL      :', probe.webgl);
  console.log('DOM ids    :', probe.ids.join(', '));
  console.log('初始模式   :', probe.activeMode, '| view3d.hidden =', probe.view3dHidden, '| view2d.hidden =', probe.view2dHidden);
  console.log('localStorage:', probe.localStorage);

  console.log('\n=== #viewport ===');
  console.log(JSON.stringify(probe.viewport));
  console.log('子元素 :', probe.viewportChildren.join(' | ') || '(空!)');

  console.log('\n=== canvas ===');
  if (!probe.canvases.length) console.log('(一个 canvas 都没有!)');
  for (const c of probe.canvases) console.log(JSON.stringify(c));

  console.log('\n=== svg ===');
  if (!probe.svgs.length) console.log('(一个 svg 都没有!)');
  for (const s of probe.svgs) console.log(JSON.stringify(s));

  console.log('\n=== 遮罩 / 文本 ===');
  console.log('loading :', JSON.stringify(probe.loadingEl));
  console.log('crash   :', JSON.stringify(probe.crashEl));
  if (probe.crashText) console.log('crash 文本 :', probe.crashText);
  console.log('meta    :', probe.metaBadge);
  console.log('可见文本 :', probe.bodyText);

  const shotDir = path.join(ROOT, '.tmp-shots');
  fs.mkdirSync(shotDir, { recursive: true });
  const shoot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(shotDir, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log(`截图 ${name} : ${p} (${fs.statSync(p).size} bytes)`);
    return p;
  };
  await shoot('e2e-3d');

  // 切到 2D 视图再看一次（这才是能验出「2D 加载不出来」的地方）
  console.log('\n=== 切到 2D 视图 ===');
  await cdp.eval(`document.querySelector('.mode[data-mode="2d"]').click()`);
  await sleep(2500);
  const probe2d = await cdp.eval(`(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) }; };
    const svg = document.querySelector('#view2d svg');
    return {
      view2d: r(document.querySelector('#view2d')),
      view2dHidden: document.querySelector('#view2d')?.hidden,
      view3dHidden: document.querySelector('#view3d')?.hidden,
      svg: r(svg),
      svgViewBox: svg?.getAttribute('viewBox'),
      paths: document.querySelectorAll('#view2d svg path').length,
      circles: document.querySelectorAll('#view2d svg circle').length,
      labels: document.querySelectorAll('#view2d svg text').length,
      crash: getComputedStyle(document.querySelector('#crash')).display,
    };
  })()`);
  console.log(JSON.stringify(probe2d, null, 1));
  await shoot('e2e-2d');

  // 点左侧第一行，看详情面板是否真的渲染
  console.log('\n=== 点左侧第一行 ===');
  await cdp.eval(`document.querySelector('#left-list .row')?.click()`);
  await sleep(900);
  const probeDetail = await cdp.eval(`(() => {
    const d = document.querySelector('#detail');
    return { title: d?.querySelector('h2, .title')?.textContent?.trim(), rows: d?.querySelectorAll('.team-card, .player-row, li').length,
             text: (d?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
  })()`);
  console.log(JSON.stringify(probeDetail, null, 1));
  await shoot('e2e-detail');

  cdp.close();
} catch (e) {
  console.log('✗ 检查过程出错 :', e.message);
  errors.push('检查脚本自身: ' + e.message);
} finally {
  await browser.close().catch(() => {});
}

console.log('\n=== 页面 console 输出 ===');
console.log(cdpEvents.length ? cdpEvents.slice(0, 40).join('\n') : '(无)');
console.log('\n=== 未捕获异常 ===');
console.log(errors.length ? errors.slice(0, 20).join('\n') : '无 ✅');
process.exit(errors.length ? 1 : 0);
