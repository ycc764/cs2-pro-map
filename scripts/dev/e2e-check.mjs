/**
 * 真·浏览器端到端检查（需要提权，因为 Chrome 在普通沙箱里起不来）
 * ------------------------------------------------------------------
 *   node scripts/dev/e2e-check.mjs [url] [--headed]
 *
 * 不传 url 时它会**自己起一个本项目的静态服务器**（端口 SITE_PORT），而不是
 * 去连 5173 —— 5173 是 serve.mjs 的默认端口，本机上很可能已经有另一个进程
 * 占着它（比如桌面那份副本，或者一个跑了很久的旧进程），于是这个检查会安静地
 * 测到**别的目录、别的数据**，一路报绿而实际什么都没验到。这个坑真踩过：
 * 数据集已经是 99 队 / 485 人，检查却还在报 41 个气泡。
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep } from '../lib/browser.mjs';
import { connect } from '../lib/cdp.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const headed = process.argv.includes('--headed');
const PORT = 9444;          // Chrome 的调试端口
const SITE_PORT = 9455;     // 没给 url 时自己起的静态服务器端口（刻意避开 5173）

let url = process.argv[2];
let siteServer = null;
if (!url) {
  url = `http://127.0.0.1:${SITE_PORT}/`;
  siteServer = spawn(process.execPath, ['scripts/serve.mjs', String(SITE_PORT), '--no-open'], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });
  // serve.mjs 端口被占时会自动 +1，所以这里要确认拿到的确实是 SITE_PORT，
  // 否则又变成"测到了别人"。探测失败就直接退出，不要带着假绿往下跑。
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${url}data/dataset.json`, { cache: 'no-store' });
      if (r.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) {
    console.log(`✗ 起不来静态服务器（${url}）——端口可能被别的进程占了，换一个再试`);
    siteServer.kill();
    process.exit(2);
  }
  // 确认真的是**这个目录**在回应，而不是碰巧也监听该端口的别的副本
  const probeMeta = await (await fetch(`${url}data/dataset.json`, { cache: 'no-store' })).json();
  console.log(`自起服务器 : ${url}`);
  console.log(`  meta     : ${probeMeta.meta.teamCount} 队 / ${probeMeta.meta.playerCount} 人 / ${probeMeta.meta.countryCount} 地区`);
}

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
    metaBadge: (q('#meta-badge') || q('.meta-badge') || q('.meta') || {}).textContent?.trim().slice(0, 200) ?? null,
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

  // 页面上的数据必须和工作区磁盘上的一致。哪怕显式传了 url，这一步也能挡住
  // "连着别的副本/旧进程"这类假绿——它的表现是数据对不上而不是报错。
  const localMeta = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public', 'data', 'dataset.json'), 'utf8'),
  ).meta;
  if (!probe.metaBadge || !probe.metaBadge.includes(String(localMeta.teamCount))) {
    errors.push(
      `页面数据与工作区不一致：页面显示「${probe.metaBadge || '(空)'}」，`
      + `磁盘上是 ${localMeta.teamCount} 队 / ${localMeta.playerCount} 人`
      + `——多半连到了别的服务器上的旧副本`,
    );
  }

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

  // ★ 真·鼠标点国家：这条是专门补的回归防线。
  // 之前所有检查都用 element.click()（合成事件），合成事件不经过 pointerdown/pointerup
  // 那条链路，所以「2D 里点国家没反应」这个 bug 从头到尾没被任何测试挡住。
  // 根因：globe2d.js 在 pointerdown 里调了 svg.setPointerCapture()，按 Pointer Events
  // 规范，click 的 target 会变成 pointerdown/pointerup 目标的「最近公共祖先」
  // —— 也就是 svg 自己，于是 e.target.dataset.code 永远是空的。
  console.log('\n=== 真·鼠标点国家（2D）===');
  const hit = await cdp.eval(`(() => {
    const ps = [...document.querySelectorAll('#view2d svg path.country.has-data')];
    // 挑面积最大的那个，小国会小到找不到落点
    ps.sort((a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      return (y.width * y.height) - (x.width * x.height); });
    for (const p of ps) {
      const b = p.getBoundingClientRect();
      for (let gy = 1; gy < 24; gy++) for (let gx = 1; gx < 24; gx++) {
        const x = b.left + (b.width * gx) / 24, y = b.top + (b.height * gy) / 24;
        if (x < 8 || y < 8 || x > innerWidth - 8 || y > innerHeight - 8) continue;
        if (document.elementFromPoint(x, y) === p) return { code: p.dataset.code, x: Math.round(x), y: Math.round(y) };
      }
    }
    return null;
  })()`);
  console.log('目标像素 :', JSON.stringify(hit));
  if (!hit) {
    errors.push('2D 里找不到可点的大国家 —— 底图可能根本没画出来');
  } else {
    // 先清空详情面板：只有清空了，「点完还是空的」才能证明真的没反应
    await cdp.eval(`document.querySelector('#detail').innerHTML = ''`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1000);
    const clickedText = await cdp.eval(
      `(document.querySelector('#detail')?.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 90)`,
    );
    console.log('点后详情 :', clickedText || '(空)');
    if (clickedText.includes('现役选手')) {
      console.log(`✓ 真鼠标点国家能出选手   ${hit.code}`);
    } else {
      console.log(`✗ 真鼠标点国家没反应   ${hit.code}`);
      errors.push(`2D 里用真鼠标点「${hit.code}」后详情面板没渲染出该国选手（详情="${clickedText}"）`
        + '—— 多半是 globe2d.js 的 click 事件又被 setPointerCapture 重定向到 svg 了');
    }
    await shoot('e2e-2d-click');
  }

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

  // 选手卡片：头像是否真的解码出来了、冠军列表渲染了几条
  // （头像走 <img>，文件 404 或格式不对时布局照样在，只有 naturalWidth 会变 0）
  console.log('\n=== 点一名选手 ===');
  const clicked = await cdp.eval(`(() => {
    const row = document.querySelector('#detail .player.clickable');
    if (!row) return null;
    row.click();
    return row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60);
  })()`);
  console.log('点中的行 :', clicked || '(详情里没有可点的选手行)');
  if (clicked) {
    await sleep(700);
    const probePlayer = await cdp.eval(`(() => {
      const d = document.querySelector('#detail');
      const img = d?.querySelector('.pavatar:not(.ph)');
      const trophies = [...(d?.querySelectorAll('.trophy-item') || [])];
      return {
        title: d?.querySelector('h2, .title')?.textContent?.replace(/\\s+/g,' ').trim(),
        avatar: img ? { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight,
                        complete: img.complete } : null,
        avatarPlaceholder: !!d?.querySelector('.pavatar.ph'),
        trophies: trophies.length,
        firstTrophy: trophies[0]?.innerText?.replace(/\\s+/g,' ').trim().slice(0, 60),
        trophyLinksOk: trophies.every((a) => (a.getAttribute('href') || '').startsWith('https://www.hltv.org/events/')),
        backButton: !!d?.querySelector('button, .back'),
        crash: getComputedStyle(document.querySelector('#crash')).display,
      };
    })()`);
    console.log(JSON.stringify(probePlayer, null, 1));
    if (probePlayer.avatar && probePlayer.avatar.complete && probePlayer.avatar.w === 0) {
      errors.push(`选手头像加载失败: ${probePlayer.avatar.src}`);
    }
    if (probePlayer.trophies > 0 && !probePlayer.trophyLinksOk) {
      errors.push('冠军列表里有链接不是指向 hltv.org/events/');
    }
    await shoot('e2e-player');
  }

  // ---- 搜索记录 ----------------------------------------------------
  // 这段必须在真浏览器里跑：localStorage 与 focus/blur 在 linkedom 里都没有。
  console.log('\n=== 搜索记录 ===');
  const RECENT_KEY = 'cs2pm.recent';
  const readRecent = () => cdp.eval(`(() => {
    try { return JSON.parse(localStorage.getItem('${RECENT_KEY}') || 'null'); } catch { return 'PARSE_ERROR'; }
  })()`);
  const probeSuggest = () => cdp.eval(`(() => {
    const s = document.querySelector('#suggest');
    const rows = [...s.querySelectorAll('.s-row')];
    return {
      hidden: s.hidden,
      head: s.querySelector('.s-head')?.innerText?.replace(/\\s+/g, ' ').trim() || null,
      rows: rows.length,
      first: rows[0]?.querySelector('.s-pick')?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 50) || null,
      dels: s.querySelectorAll('.s-del').length,
      hasClear: !!s.querySelector('.s-clear'),
      clearLabel: s.querySelector('.s-clear')?.innerText?.trim() || null,
    };
  })()`);
  // 用真鼠标点输入框。`cdp.goto()` 之后页面没有焦点，`el.focus()` 不会让
  // document.activeElement 变成它，focus 事件也就不触发 —— 而「空输入框时弹出
  // 搜索记录」正是挂在 focus 上的，所以这里必须走真实输入事件。
  const clickSearch = async () => {
    const box = await cdp.eval(`(() => {
      const r = document.querySelector('#search').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const at = { x: box.x, y: box.y };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', clickCount: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(400);
  };
  // 敲字 → 等 debounce（120ms）→ 点第一条结果
  const pickFirst = async (word) => {
    await clickSearch();
    await cdp.eval(`(() => {
      const i = document.querySelector('#search');
      i.value = ${JSON.stringify(word)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(650);
    return cdp.eval(`(() => {
      const b = document.querySelector('#suggest > button');
      if (!b) return null;
      const t = b.innerText.replace(/\\s+/g, ' ').trim().slice(0, 50);
      b.click();
      return t;
    })()`);
  };
  // 清空输入框：模拟 type="search" 那个原生 ×（它也是派发一个 input 事件）
  const clearBox = async () => {
    await clickSearch();
    await cdp.eval(`(() => {
      const i = document.querySelector('#search');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(450);
  };

  await cdp.eval(`localStorage.removeItem('${RECENT_KEY}')`);
  const picked1 = await pickFirst('zywoo');
  console.log('点中的搜索结果 :', picked1 || '(没有结果)');
  const rec1 = await readRecent();
  console.log('记录（第 1 条） :', JSON.stringify(rec1));
  if (!Array.isArray(rec1) || rec1.length !== 1 || rec1[0].label !== 'ZywOo') {
    errors.push(`点开一条搜索结果后 localStorage 里应该有 1 条记录 "ZywOo"，实际是 ${JSON.stringify(rec1)}`);
  }

  await clearBox();
  const panel1 = await probeSuggest();
  console.log('清空后的浮层 :', JSON.stringify(panel1));
  if (panel1.hidden || panel1.rows !== 1 || !panel1.hasClear || panel1.dels !== 1) {
    errors.push(`输入框清空后浮层应显示 1 条搜索记录（带「清空」和 1 个 ×），实际是 ${JSON.stringify(panel1)}`);
  }
  if (panel1.head && !panel1.head.includes('搜索记录')) {
    errors.push(`记录面板的表头应该是「搜索记录」，实际是「${panel1.head}」`);
  }
  await shoot('e2e-recent');

  // 再记两条：连续的应该排在最前，且同一条不会重复
  await pickFirst('s1mple');
  await pickFirst('zywoo');           // 再搜一次 ZywOo —— 应该顶到最前而不是变成两条
  const rec2 = await readRecent();
  console.log('记录（3 次之后）:', JSON.stringify((rec2 || []).map((r) => r.label)));
  if (!Array.isArray(rec2) || rec2.length !== 2 || rec2[0].label !== 'ZywOo') {
    errors.push(`重复搜索不该产生重复记录，且最近的一条要排最前；实际是 ${JSON.stringify((rec2 || []).map((r) => r.label))}`);
  }

  await clearBox();
  const panel2 = await probeSuggest();
  // 点第一条的 ×：只删这一条，浮层不关（方便连着删）
  await cdp.eval(`document.querySelector('#suggest .s-row .s-del')?.click()`);
  await sleep(400);
  const afterDel = await readRecent();
  const panel3 = await probeSuggest();
  console.log('删一条之后 :', JSON.stringify((afterDel || []).map((r) => r.label)), '浮层', JSON.stringify(panel3));
  if (!Array.isArray(afterDel) || afterDel.length !== 1 || afterDel[0].label !== 's1mple') {
    errors.push(`点 × 应该只删掉那一条（剩 s1mple），实际剩 ${JSON.stringify((afterDel || []).map((r) => r.label))}`);
  }
  if (panel3.hidden || panel3.rows !== 1) {
    errors.push(`删掉一条后浮层应该还开着并剩 1 行，实际是 ${JSON.stringify(panel3)}`);
  }
  if (panel2.rows !== 2) errors.push(`删之前应该有 2 行记录，实际 ${panel2.rows}`);

  // 刷新页面：记录应该还在（这才叫「保留」）
  await cdp.goto(url);
  await sleep(3200);
  await cdp.send('Page.bringToFront').catch(() => {});
  const rec3 = await readRecent();
  await clickSearch();
  const panel4 = await probeSuggest();
  console.log('刷新之后 :', JSON.stringify((rec3 || []).map((r) => r.label)), '浮层', JSON.stringify(panel4));
  if (!Array.isArray(rec3) || rec3.length !== 1 || rec3[0].label !== 's1mple') {
    errors.push(`刷新页面后搜索记录应该还在（s1mple），实际是 ${JSON.stringify(rec3)}`);
  }
  if (panel4.hidden || panel4.rows !== 1) {
    errors.push(`刷新后点进输入框应该还能看到记录，实际是 ${JSON.stringify(panel4)}`);
  }

  // 「清空」按钮：一次删光
  await cdp.eval(`document.querySelector('#suggest .s-clear')?.click()`);
  await sleep(350);
  const rec4 = await readRecent();
  const panel5 = await probeSuggest();
  console.log('清空之后 :', JSON.stringify(rec4), '浮层 hidden =', panel5.hidden);
  if (!Array.isArray(rec4) || rec4.length !== 0) {
    errors.push(`点「清空」后应该一条不剩，实际是 ${JSON.stringify(rec4)}`);
  }
  if (!panel5.hidden) errors.push('点「清空」后浮层应该收起来');

  cdp.close();
} catch (e) {
  console.log('✗ 检查过程出错 :', e.message);
  errors.push('检查脚本自身: ' + e.message);
} finally {
  await browser.close().catch(() => {});
  if (siteServer) siteServer.kill();
}

console.log('\n=== 页面 console 输出 ===');
console.log(cdpEvents.length ? cdpEvents.slice(0, 40).join('\n') : '(无)');
console.log('\n=== 未捕获异常 ===');
console.log(errors.length ? errors.slice(0, 20).join('\n') : '无 ✅');
process.exit(errors.length ? 1 : 0);
