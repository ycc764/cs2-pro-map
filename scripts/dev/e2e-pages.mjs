/**
 * 选手榜 / 历届排名两页的真浏览器检查（需要提权，Chrome 在普通沙箱里起不来）
 * ------------------------------------------------------------------
 *   node scripts/dev/e2e-pages.mjs [baseUrl] [--headed]
 *
 * 和 e2e-check.mjs 一样，不传 baseUrl 就自己起一个本项目的静态服务器，
 * 并且只认自己起的那个端口 —— 免得连到别的副本上测出假绿。
 *
 * 它检查的是这两页**独有的**东西：表格有没有真的渲染出行、行有没有塌成
 * 0 高度、sparkline 有没有画出来、排名曲线是不是真的是一条线而不是空 SVG。
 * 这些全是假 DOM 检查发现不了的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep } from '../lib/browser.mjs';
import { connect } from '../lib/cdp.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const headed = process.argv.includes('--headed');
const PORT = 9445;          // Chrome 调试端口（避开 e2e-check 的 9444）
const SITE_PORT = 9456;     // 静态服务器端口（避开 e2e-check 的 9455 和 serve.mjs 的 5173）

let base = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
if (base && !base.endsWith('/')) base += '/';
let siteServer = null;
if (!base) {
  base = `http://127.0.0.1:${SITE_PORT}/`;
  siteServer = spawn(process.execPath, ['scripts/serve.mjs', String(SITE_PORT), '--no-open'], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}data/dataset.json`, { cache: 'no-store' }); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) {
    console.log(`✗ 起不来静态服务器（${base}）——端口可能被别的进程占了，换一个再试`);
    siteServer.kill();
    process.exit(2);
  }
  console.log(`自起服务器 : ${base}`);
}

const shotDir = path.join(ROOT, '.tmp-shots');
fs.mkdirSync(shotDir, { recursive: true });

const events = [];
const errors = [];

let browser;
const profileDir = path.join(ROOT, '.tmp-profile', 'pages');
fs.rmSync(profileDir, { recursive: true, force: true });
try {
  browser = await launchBrowser({ port: PORT, headless: !headed, profileDir });
  console.log('Chrome 已启动 :', browser.exe);
} catch (e) {
  console.log('✗ Chrome 起不来 :', e.message);
  console.log('  （沙箱限制；请在提权模式下重跑，或在你自己的终端里跑）');
  process.exit(2);
}

const cdp = await connect(browser.cdpUrl);
cdp.on('Runtime.consoleAPICalled', (p) => {
  const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
  events.push(`[${p.type}] ${text}`);
});
cdp.on('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails;
  errors.push(`${d.exception?.description || d.text}  @ ${d.url || '?'}:${d.lineNumber}:${d.columnNumber}`);
});
cdp.on('Log.entryAdded', (p) => {
  if (p.entry.level === 'error') events.push(`[log:error] ${p.entry.text} ${p.entry.url || ''}`);
});
await cdp.send('Log.enable').catch(() => {});
await cdp.send('Network.enable').catch(() => {});
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
}).catch(() => {});

const shoot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(shotDir, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`截图 ${name} : ${p} (${fs.statSync(p).size} bytes)`);
};

const ok = (cond, label, detail) => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) errors.push(label + (detail ? ` — ${detail}` : ''));
};
/** 把「1,703 名」这类带千分位/单位的中文数字串取成数字，用来比大小。 */
const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
const rectOf = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null; const r = e.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; })()`;

try {
  /* ---------------- 选手榜 ---------------- */
  console.log('\n=== players.html ===');
  await cdp.goto(`${base}players.html`);
  await sleep(3500);

  const p = await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const rows = [...document.querySelectorAll('#tbody tr')];
    const cells = (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    const crash = q('#crash');
    return {
      title: document.title,
      metaBadge: q('#meta-badge')?.textContent?.trim() || null,
      crashHidden: crash ? crash.hidden : 'no-el',
      crashDisplay: crash ? getComputedStyle(crash).display : null,
      navOn: q('.nav a.on')?.textContent?.trim() || null,
      rows: rows.length,
      first: rows[0] ? cells(rows[0]) : null,
      second: rows[1] ? cells(rows[1]) : null,
      avatars: document.querySelectorAll('#tbody img.pav').length,
      fallbacks: document.querySelectorAll('#tbody .pav-fallback').length,
      sparks: document.querySelectorAll('#tbody svg.spark').length,
      sparkLines: document.querySelectorAll('#tbody svg.spark polyline').length,
      count: q('#count')?.textContent?.trim() || null,
      nAll: q('#n-all')?.textContent?.trim() || null,
      nCur: q('#n-cur')?.textContent?.trim() || null,
      countryOptions: q('#cc') ? q('#cc').options.length : 0,
      tableTop: ${rectOf('.ptable thead th')},
      rowRect: ${rectOf('#tbody tr')},
      sparkRect: ${rectOf('#tbody svg.spark')},
      wrapRect: ${rectOf('#tablewrap')},
    };
  })()`);

  console.log('title        :', p.title);
  console.log('meta         :', p.metaBadge);
  console.log('导航高亮     :', p.navOn);
  console.log('行数         :', p.rows, '| 计数:', p.count, '| 全部:', p.nAll, '| 现役:', p.nCur);
  console.log('国家下拉项   :', p.countryOptions);
  console.log('头像/兜底    :', p.avatars, '/', p.fallbacks, '| sparkline:', p.sparks, '（有折线', p.sparkLines, '）');
  console.log('表头 rect    :', JSON.stringify(p.tableTop));
  console.log('首行 rect    :', JSON.stringify(p.rowRect));
  console.log('spark rect   :', JSON.stringify(p.sparkRect));
  console.log('滚动区 rect  :', JSON.stringify(p.wrapRect));
  console.log('第 1 行      :', JSON.stringify(p.first));
  console.log('第 2 行      :', JSON.stringify(p.second));

  ok(p.crashHidden === true && p.crashDisplay === 'none', '错误遮罩没有盖住页面', `crash.hidden=${p.crashHidden} display=${p.crashDisplay}`);
  ok(p.navOn === '选手榜', '导航高亮在「选手榜」', `实际 ${p.navOn}`);
  ok(p.rows >= 100, '表格渲染出了行', `${p.rows} 行`);
  ok(p.rowRect && p.rowRect.h >= 20 && p.rowRect.h <= 80, '行高正常（没塌）', JSON.stringify(p.rowRect));
  ok(p.sparkRect && p.sparkRect.w >= 80 && p.sparkRect.h >= 12, 'sparkline 有实际尺寸', JSON.stringify(p.sparkRect));
  ok(p.sparkLines >= 50, 'sparkline 画出了折线', `${p.sparkLines} 条（共 ${p.sparks} 个）`);
  // 阈值 40 而不是 50：前 120 名里只有一部分人属于"前 100 队"（只有他们才有
  // 头像），49 张是正确结果，不是渲染失败。
  ok(p.avatars >= 40, '头像加载出来了', `${p.avatars} 张，兜底 ${p.fallbacks} 个`);
  ok(p.countryOptions > 40, '国家下拉有内容', `${p.countryOptions} 项`);
  ok(Number(String(p.first?.[4] || '').replace(/[^\d.]/g, '')) >= Number(String(p.second?.[4] || '').replace(/[^\d.]/g, '')), '默认按 Rating 从高到低', `${p.first?.[4]} ≥ ${p.second?.[4]}`);

  await shoot('pages-players');

  // 交互一：点「地图数」表头，应改成按地图数降序
  console.log('\n--- 点表头 √ 排序 ---');
  await cdp.eval(`document.querySelector('#thead th[data-k="maps"]').click()`);
  await sleep(600);
  const sorted = await cdp.eval(`(() => {
    const v = (tr) => Number(tr.querySelectorAll('td')[6].textContent.replace(/[^\\d]/g, ''));
    const rows = [...document.querySelectorAll('#tbody tr')].slice(0, 8).map(v);
    return { rows, mono: rows.every((x, i) => i === 0 || rows[i-1] >= x) };
  })()`);
  console.log('前 8 行地图数 :', sorted.rows.join(' '));
  ok(sorted.mono, '按地图数降序生效');

  // 交互二：搜索框过滤
  console.log('\n--- 搜索过滤 ---');
  const before = await cdp.eval(`document.querySelectorAll('#tbody tr').length`);
  // 用中文国名搜（表格里显示的就是 `p.cn`）。搜英文 `denmark` 一条都匹配不到，
  // 因为搜索只比对 nick / team / cn / cc 四个字段。
  await cdp.eval(`(() => { const q = document.querySelector('#q'); q.value = '丹麦';
    q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  const filtered = await cdp.eval(`(() => ({
    n: document.querySelectorAll('#tbody tr').length,
    count: document.querySelector('#count').textContent.trim(),
    first: document.querySelector('#tbody tr')?.querySelectorAll('td')[2]?.textContent.trim() || null,
  }))()`);
  console.log(`「丹麦」→ ${filtered.n} 行，计数 ${filtered.count}，首行国家 ${filtered.first}`);
  ok(filtered.n > 0 && filtered.n < before, '搜索把结果收窄了', `${before} → ${filtered.n}`);

  // 交互三：切到「前 100 队现役」
  console.log('\n--- 切筛选 ---');
  await cdp.eval(`document.querySelector('#q').value = ''; document.querySelector('#q').dispatchEvent(new Event('input', { bubbles: true }))`);
  await sleep(500);
  await cdp.eval(`document.querySelector('#chips .chip[data-f="cur"]').click()`);
  await sleep(600);
  const cur = await cdp.eval(`(() => ({
    n: document.querySelectorAll('#tbody tr').length,
    count: document.querySelector('#count').textContent.trim(),
    tags: document.querySelectorAll('#tbody .cur-tag').length,
    all: document.querySelector('#n-all').textContent.trim(),
  }))()`);
  console.log(`前 100 队现役 → ${cur.n} 行（计数 ${cur.count}，总 ${cur.all}），带标签 ${cur.tags} 个`);
  // 量纲要对齐：拿筛选后的**总数**和全量总数比，不能和当前渲染的 120 行比
  // （表格是分页/截断渲染的，行数天然小于总数）。
  ok(num(cur.count) < num(cur.all), '「前 100 队现役」确实更少', `${cur.count} < ${cur.all}`);
  ok(cur.n > 0 && cur.tags === cur.n, '每一行都带「前 100 队」标签', `${cur.tags}/${cur.n}`);

  await shoot('pages-players-filtered');

  /* ---------------- 历届排名 ---------------- */
  console.log('\n=== rankings.html ===');
  await cdp.goto(`${base}rankings.html`);
  await sleep(3500);

  const r = await cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const crash = q('#crash');
    const svg = q('svg.line-chart');
    const lines = [...document.querySelectorAll('svg.line-chart polyline.team-line')];
    const rows = [...document.querySelectorAll('#snap-list .rank-row')];
    return {
      title: document.title,
      metaBadge: q('#meta-badge')?.textContent?.trim() || null,
      crashHidden: crash ? crash.hidden : 'no-el',
      crashDisplay: crash ? getComputedStyle(crash).display : null,
      navOn: q('.nav a.on')?.textContent?.trim() || null,
      svgRect: svg ? (() => { const b = svg.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) }; })() : null,
      lineCount: lines.length,
      linePoints: lines.slice(0, 3).map((l) => l.getAttribute('points').split(' ').length),
      gridLines: document.querySelectorAll('svg.line-chart line.grid').length,
      yearLabels: document.querySelectorAll('svg.line-chart text.axis-txt').length,
      legend: document.querySelectorAll('#legend button').length,
      legendOn: document.querySelectorAll('#legend button:not(.off)').length,
      sideDate: q('#snap-date')?.textContent?.trim() || null,
      sideSub: q('#snap-sub')?.textContent?.trim() || null,
      sideRows: rows.length,
      sideFirst: rows[0] ? rows[0].textContent.trim() : null,
      sideLast: rows.length ? rows[rows.length-1].textContent.trim() : null,
      cursorOpacity: q('svg.line-chart line.cursor')?.getAttribute('opacity') || null,
    };
  })()`);

  console.log('title        :', r.title);
  console.log('meta         :', r.metaBadge);
  console.log('导航高亮     :', r.navOn);
  console.log('曲线 svg     :', JSON.stringify(r.svgRect), '| 折线', r.lineCount, '条 | 前 3 条点数', r.linePoints.join('/'));
  console.log('网格/轴标签  :', r.gridLines, '/', r.yearLabels);
  console.log('图例         :', r.legend, '项（选中', r.legendOn, '）');
  console.log('右侧日期     :', r.sideDate, '|', r.sideSub);
  console.log('右侧榜单     :', r.sideRows, '行 | 首', r.sideFirst, '| 末', r.sideLast);
  console.log('光标透明度   :', r.cursorOpacity);

  ok(r.crashHidden === true && r.crashDisplay === 'none', '错误遮罩没有盖住页面', `crash.hidden=${r.crashHidden} display=${r.crashDisplay}`);
  ok(r.navOn === '历届排名', '导航高亮在「历届排名」', `实际 ${r.navOn}`);
  ok(r.svgRect && r.svgRect.w >= 500 && r.svgRect.h >= 200, '曲线图画布有实际尺寸', JSON.stringify(r.svgRect));
  ok(r.lineCount >= 3, '画出了多条战队曲线', `${r.lineCount} 条`);
  ok(r.linePoints.every((n) => n >= 5), '曲线是真的有数据点', r.linePoints.join('/'));
  ok(r.gridLines >= 4, '有网格线', `${r.gridLines} 条`);
  ok(r.legend >= 5 && r.legendOn >= 3, '图例有内容且默认选中若干队', `${r.legend} 项 / 选中 ${r.legendOn}`);
  ok(r.sideRows >= 10, '右侧榜单有行', `${r.sideRows} 行`);
  // `#1` 后面紧跟队名首字母（`#1Spirit…`），两个都是词字符，`\b` 在这里不成立，
  // 得用「非数字」来断言，不能用词边界。
  ok(/^#1\D/.test(r.sideFirst || ''), '榜单第一行是 #1', r.sideFirst);

  await shoot('pages-rankings');

  // 交互：往左划几期，右侧日期应跟着变
  console.log('\n--- 图表上移动鼠标 ---');
  const box = await cdp.eval(`(() => { const b = document.querySelector('svg.line-chart').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const dateBefore = r.sideDate;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(box.x + box.w * 0.25), y: Math.round(box.y + box.h * 0.5), button: 'none',
  });
  await sleep(500);
  const hover = await cdp.eval(`(() => ({
    date: document.querySelector('#snap-date')?.textContent?.trim() || null,
    sideRows: document.querySelectorAll('#snap-list .rank-row').length,
    cursor: document.querySelector('svg.line-chart line.cursor')?.getAttribute('opacity') || null,
    dots: document.querySelectorAll('svg.line-chart g circle').length,
  }))()`);
  console.log(`划到 25% 处 : 日期 ${dateBefore} → ${hover.date}，榜单 ${hover.sideRows} 行，光标 opacity=${hover.cursor}，圆点 ${hover.dots}`);
  ok(hover.date && hover.date !== dateBefore, '鼠标移动改变了选中的期次', `${dateBefore} → ${hover.date}`);
  ok(hover.sideRows >= 10, '跟随的榜单仍有行', `${hover.sideRows}`);
  ok(hover.cursor === '1', '光标线显示出来了');

  await shoot('pages-rankings-hover');

  // 交互：点图例关掉一支队，曲线应变少
  console.log('\n--- 点图例取消一支队 ---');
  const beforeLines = await cdp.eval(`document.querySelectorAll('svg.line-chart polyline.team-line').length`);
  await cdp.eval(`document.querySelector('#legend button:not(.off)').click()`);
  await sleep(700);
  const afterLines = await cdp.eval(`(() => ({
    lines: document.querySelectorAll('svg.line-chart polyline.team-line').length,
    on: document.querySelectorAll('#legend button:not(.off)').length,
  }))()`);
  console.log(`折线 ${beforeLines} → ${afterLines.lines}，图例选中 ${afterLines.on}`);
  ok(afterLines.lines < beforeLines, '取消高亮后曲线变少了', `${beforeLines} → ${afterLines.lines}`);

  // 交互：切时间窗口。576 期铺在 1100px 上每期不到 2px，线会糊成一片竖条，
  // 所以必须能往回缩 —— 这一条就是防止哪天把窗口控件删了又退化成一张毛球。
  console.log('\n--- 切到「近 5 年」 ---');
  const WIDE = `(() => ({
    hint: document.querySelector('#range-hint')?.textContent?.trim() || null,
    pts: document.querySelector('svg.line-chart polyline.team-line')?.getAttribute('points').split(' ').length || 0,
    chips: [...document.querySelectorAll('#range-chips .chip')].filter((c) => c.classList.contains('on')).map((c) => c.textContent.trim()),
  }))()`;
  const wide = await cdp.eval(WIDE);
  await cdp.eval(`[...document.querySelectorAll('#range-chips .chip')].find((c) => c.dataset.range === '5').click()`);
  await sleep(800);
  const narrow = await cdp.eval(`(() => ({
    hint: document.querySelector('#range-hint')?.textContent?.trim() || null,
    pts: document.querySelector('svg.line-chart polyline.team-line')?.getAttribute('points').split(' ').length || 0,
    chips: [...document.querySelectorAll('#range-chips .chip')].filter((c) => c.classList.contains('on')).map((c) => c.textContent.trim()),
    sideRows: document.querySelectorAll('#snap-list .rank-row').length,
    crash: document.querySelector('#crash') ? document.querySelector('#crash').hidden : 'no-el',
  }))()`);
  console.log(`全部  : ${wide.hint} | 高亮 ${wide.chips.join(',')} | 首条线 ${wide.pts} 点`);
  console.log(`近 5 年: ${narrow.hint} | 高亮 ${narrow.chips.join(',')} | 首条线 ${narrow.pts} 点 | 榜单 ${narrow.sideRows} 行`);
  ok(narrow.chips.includes('近 5 年'), '切窗口后高亮跟上了', narrow.chips.join(',') || '(无)');
  ok(narrow.pts > 0 && narrow.pts < wide.pts, '窗口变窄后曲线点数跟着变少', `${wide.pts} → ${narrow.pts}`);
  ok(/近|20\d\d/.test(narrow.hint || ''), '窗口提示写明了范围', narrow.hint);
  ok(narrow.sideRows >= 10, '切窗口后右侧榜单还在', `${narrow.sideRows} 行`);
  ok(narrow.crash === true, '切窗口没把页面画崩', `crash.hidden=${narrow.crash}`);

  await shoot('pages-rankings-range');
} catch (e) {
  errors.push(`检查过程出错：${e.message}`);
  console.log('✗ 检查过程出错 :', e.message);
}

await sleep(200);
try { await cdp.close(); } catch { /* 已经断了 */ }
try { if (browser) await browser.close(); } catch { /* 已经退出了 */ }
if (siteServer) siteServer.kill();

console.log('\n=== 页面 console 输出 ===');
console.log(events.length ? events.slice(0, 30).join('\n') : '(无)');
console.log('\n=== 未捕获异常 / 断言失败 ===');
console.log(errors.length ? errors.slice(0, 20).join('\n') : '无 ✅');
process.exit(errors.length ? 1 : 0);
