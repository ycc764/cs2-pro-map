/**
 * 历届世界排名：一张「名次 × 时间」的曲线图 + 右侧某一期的前 30 名。
 *
 * 数据来自 `npm run scrape:rankings`（→ data/rankings.json）经 `npm run dataset:hltv`
 * 压出来的 public/data/rankings.json：
 *   { teams: [队名…], snapshots: [{ d: '2026-10-05', n: 250, t: [[队下标, 名次, 积分, 名次变化], …] }] }
 * 队名单独列表、快照里只存下标，是因为同一支队会在几百期里反复出现。
 */
import { el } from './util.js';

const DATA_URL = '/data/rankings.json';
const DEFAULT_LINES = 10;

/**
 * 线的颜色。刻意不用地图页那条蓝→黄色标 —— 那条在这一页是"人数/水平"的
 * 语义，拿来区分战队会串味。这里用一组色相分开的定性配色。
 */
const COLORS = [
  '#ffd166', '#4fc08d', '#5aa9e6', '#ff8fa3', '#c792ea', '#7fd8d0',
  '#f4a261', '#a6d96a', '#e6e6e6', '#ff6b6b', '#9d7bd8', '#63d2ff',
  '#ffb4a2', '#8ba0c4',
];

/**
 * 时间范围。第二个数是"往回多少年"，0 表示全部。
 *
 * 为什么要这个：576 期铺在 1100px 上，每期不到 2px，名次一跳线就是一根竖条，
 * 十支队叠起来糊成一片。这是真实数据（NaVi / G2 各自在榜 574 期），不是画错了，
 * 所以给一个往回看的窗口 —— 而不是把点抽稀，抽稀等于假装排名没波动过。
 */
const RANGES = [
  ['all', '全部', 0],
  ['10', '近 10 年', 10],
  ['5', '近 5 年', 5],
  ['2', '近 2 年', 2],
];

const state = {
  teams: [],
  all: [],             // 全部期次，切范围时从这里切片
  snaps: [],           // 当前窗口内的期次（图、光标、右侧面板都只看它）
  range: 'all',
  series: new Map(),   // 队下标 → 每期的名次（不在榜上的是 null）
  sel: new Set(),
  idx: 0,
  maxRank: 30,
};

const $ = (s) => document.querySelector(s);

const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  return n;
}

/* ---------------- 数据处理 ---------------- */

function buildSeries() {
  state.series.clear();
  const n = state.snaps.length;
  const touched = new Set();
  state.snaps.forEach((s, i) => {
    for (const [ti, rank] of s.t) {
      let arr = state.series.get(ti);
      if (!arr) { arr = new Array(n).fill(null); state.series.set(ti, arr); }
      arr[i] = rank;
      touched.add(ti);
    }
  });
  state.maxRank = 0;
  for (const s of state.snaps) for (const [, rank] of s.t) if (rank > state.maxRank) state.maxRank = rank;
  if (!state.maxRank) state.maxRank = 30;
  return touched;
}

/** 在榜期数最多的队（同分时看谁当过更久的第 1），作为默认要画的线 */
function pickDefaultTeams() {
  const score = [];
  for (const [ti, arr] of state.series) {
    let weeks = 0, top1 = 0, top10 = 0;
    for (const r of arr) {
      if (r == null) continue;
      weeks++;
      if (r === 1) top1++;
      if (r <= 10) top10++;
    }
    score.push({ ti, weeks, top1, top10 });
  }
  score.sort((a, b) => (b.top1 - a.top1) || (b.top10 - a.top10) || (b.weeks - a.weeks));
  state.sel = new Set(score.slice(0, DEFAULT_LINES).map((s) => s.ti));
  return score;
}

const colorOf = (ti) => COLORS[[...state.sel].indexOf(ti) % COLORS.length] || COLORS[COLORS.length - 1];

/**
 * 切时间窗口：从全部期次里按日期切一段，重建序列后整页重画。
 * 已经选好的队保留（队下标是全量的下标，切窗口不会失效）——所以只在
 * 一次都没选过的时候才去挑默认队。
 */
function applyRange(key) {
  const def = RANGES.find((r) => r[0] === key) || RANGES[0];
  state.range = def[0];

  const all = state.all;
  if (!def[2] || all.length < 3) {
    state.snaps = all.slice();
  } else {
    const last = all[all.length - 1].d || '';
    const cut = `${Number(last.slice(0, 4)) - def[2]}${last.slice(4)}`;
    let i = all.findIndex((s) => (s.d || '') >= cut);
    if (i < 0) i = 0;
    if (all.length - i < 2) i = Math.max(0, all.length - 2);   // 至少留两期才画得出线
    state.snaps = all.slice(i);
  }

  buildSeries();
  if (!state.sel.size) pickDefaultTeams();
  state.idx = state.snaps.length - 1;   // 默认停在窗口内最新的一期

  for (const c of document.querySelectorAll('#range-chips .chip')) {
    c.classList.toggle('on', c.dataset.range === state.range);
  }
  const hint = $('#range-hint');
  if (hint) {
    const a = state.snaps[0]?.d || '?';
    const b = state.snaps[state.snaps.length - 1]?.d || '?';
    hint.textContent = `图上 ${state.snaps.length} 期：${a} → ${b}`;
  }

  drawChart();
  renderLegend();
  renderSide();
}

/* ---------------- 图表 ---------------- */

let cursorLine = null;
let cursorDots = null;

function drawChart() {
  const chart = $('#chart');
  const old = chart.querySelector('svg');
  if (old) old.remove();
  if (!state.snaps.length) return;

  const box = chart.getBoundingClientRect();
  const legendH = $('#legend').getBoundingClientRect().height || 40;
  const W = Math.max(320, Math.round(box.width));
  const H = Math.max(180, Math.round(box.height - legendH));

  const M = { top: 16, right: 16, bottom: 24, left: 40 };
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const n = state.snaps.length;

  const x = (i) => M.left + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  // 名次用对数轴：1 → 2 和 10 → 20 的视觉距离一样，否则前几名会全挤在顶上
  const lg = Math.log(state.maxRank);
  const y = (rank) => M.top + (Math.log(Math.max(1, rank)) / lg) * ph;
  xScale = x;
  yScale = y;

  const node = svg('svg', { class: 'line-chart', width: W, height: H, viewBox: `0 0 ${W} ${H}` });

  // 名次网格线
  for (const r of [1, 2, 3, 5, 10, 20, 30, 50]) {
    if (r > state.maxRank) continue;
    node.append(svg('line', { class: 'grid', x1: M.left, y1: y(r), x2: W - M.right, y2: y(r) }));
    const t = svg('text', { class: 'axis-txt', x: M.left - 7, y: y(r) + 3.5, 'text-anchor': 'end' });
    t.textContent = `#${r}`;
    node.append(t);
  }

  // 年份竖线 + 标签
  const yearTicks = [];
  let lastYear = '';
  state.snaps.forEach((s, i) => {
    const yr = (s.d || '').slice(0, 4);
    if (yr && yr !== lastYear) { yearTicks.push([i, yr]); lastYear = yr; }
  });
  // 年份太密就隔一个画一个
  const step = yearTicks.length > 9 ? Math.ceil(yearTicks.length / 9) : 1;
  yearTicks.forEach(([i, yr], k) => {
    if (k % step) return;
    node.append(svg('line', { class: 'grid', x1: x(i), y1: M.top, x2: x(i), y2: H - M.bottom }));
    const t = svg('text', { class: 'axis-txt', x: x(i), y: H - M.bottom + 14, 'text-anchor': 'middle' });
    t.textContent = yr;
    node.append(t);
  });

  // 每条队一条折线（断档要断开，不能连成一条假的直线）
  for (const ti of state.sel) {
    const arr = state.series.get(ti);
    if (!arr) continue;
    const segs = [];
    let cur = [];
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) { if (cur.length) { segs.push(cur); cur = []; } continue; }
      cur.push(`${x(i).toFixed(1)},${y(arr[i]).toFixed(1)}`);
    }
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      if (seg.length === 1) {
        const [cx, cy] = seg[0].split(',');
        node.append(svg('circle', { cx, cy, r: 1.6, fill: colorOf(ti) }));
      } else {
        node.append(svg('polyline', { class: 'team-line', points: seg.join(' '), stroke: colorOf(ti) }));
      }
    }
  }

  // 光标（悬停时移动，不重建整张图）
  cursorLine = svg('line', { class: 'cursor', x1: 0, y1: M.top, x2: 0, y2: H - M.bottom, opacity: 0 });
  node.append(cursorLine);
  cursorDots = svg('g', { opacity: 0 });
  node.append(cursorDots);

  node.addEventListener('mousemove', (e) => {
    const r = node.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = n <= 1 ? 0 : (px - M.left) / pw;
    setIdx(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
  });
  node.addEventListener('click', (e) => {
    const r = node.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = n <= 1 ? 0 : (px - M.left) / pw;
    setIdx(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
  });

  chart.insertBefore(node, $('#legend'));
  positionCursor(x, y);
}

function positionCursor(x, y) {
  if (!cursorLine) return;
  const cx = x(state.idx);
  cursorLine.setAttribute('x1', cx);
  cursorLine.setAttribute('x2', cx);
  cursorLine.setAttribute('opacity', 1);
  cursorDots.replaceChildren();
  cursorDots.setAttribute('opacity', 1);
  for (const ti of state.sel) {
    const rank = state.series.get(ti)?.[state.idx];
    if (rank == null) continue;
    cursorDots.append(svg('circle', { cx, cy: y(rank), r: 3, fill: colorOf(ti), stroke: '#0b1122', 'stroke-width': 1.2 }));
  }
}

let raf = 0;
let xScale = null;
let yScale = null;

function setIdx(i) {
  if (i === state.idx) return;
  state.idx = i;
  if (xScale && yScale) positionCursor(xScale, yScale);
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderSide(); });
}

/* ---------------- 右侧面板 ---------------- */

function fmtDay(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
}

function renderSide() {
  const s = state.snaps[state.idx];
  if (!s) return;
  $('#snap-date').textContent = fmtDay(s.d);
  const selNames = [...state.sel].map((ti) => state.teams[ti]).filter(Boolean);
  $('#snap-sub').textContent = `世界前 ${s.t.length} 名（当期共 ${s.n || '?'} 支队）`
    + (selNames.length ? ` · 高亮 ${selNames.length} 支` : '');

  const list = $('#snap-list');
  list.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const [ti, rank, points, chg] of s.t) {
    const row = el('div', 'rank-row');
    const on = state.sel.has(ti);
    row.append(el('span', 'pos', `#${rank}`));
    const sw = el('i', 'swatch');
    sw.style.background = on ? colorOf(ti) : 'transparent';
    row.append(sw);
    row.append(el('span', 'nm', state.teams[ti] || '?'));
    row.append(el('span', 'pts', points ? `${points}` : ''));
    const c = el('span', `chg${chg > 0 ? ' up' : chg < 0 ? ' down' : ''}`, chg > 0 ? `▲${chg}` : chg < 0 ? `▼${-chg}` : '–');
    row.append(c);
    row.title = on ? '点击取消高亮' : '点击在图上高亮这支队';
    row.addEventListener('click', () => toggleTeam(ti));
    frag.append(row);
  }
  list.append(frag);
}

/* ---------------- 图例 / 选队 ---------------- */

function toggleTeam(ti) {
  if (state.sel.has(ti)) state.sel.delete(ti);
  else {
    if (state.sel.size >= COLORS.length) state.sel.delete([...state.sel][0]);
    state.sel.add(ti);
  }
  drawChart();
  renderLegend();
  renderSide();
}

function renderLegend() {
  const box = $('#legend');
  box.replaceChildren();
  // 图例只放"画得出线"的队，按当前选择 + 在榜期数最多的补足
  const ranked = [...state.series.entries()]
    .map(([ti, arr]) => {
      let weeks = 0, top1 = 0, top10 = 0;
      for (const r of arr) { if (r == null) continue; weeks++; if (r === 1) top1++; if (r <= 10) top10++; }
      return { ti, weeks, top1, top10 };
    })
    .sort((a, b) => (b.top1 - a.top1) || (b.top10 - a.top10) || (b.weeks - a.weeks));

  const shown = new Set([...state.sel, ...ranked.slice(0, 20).map((r) => r.ti)]);
  for (const ti of [...shown].sort((a, b) => (state.sel.has(b) ? 1 : 0) - (state.sel.has(a) ? 1 : 0))) {
    const b = el('button', state.sel.has(ti) ? '' : 'off');
    const i = el('i');
    const on = state.sel.has(ti);
    i.style.background = on ? colorOf(ti) : '#6b7fa3';
    b.append(i, state.teams[ti] || '?');
    const st = ranked.find((r) => r.ti === ti);
    b.title = st ? `在榜 ${st.weeks} 期 · 世界第一 ${st.top1} 期 · 前 10 ${st.top10} 期` : '';
    b.addEventListener('click', () => toggleTeam(ti));
    box.append(b);
  }
}

/* ---------------- 启动 ---------------- */

function fail(err) {
  const show = window.__cs2ShowCrash;
  const msg = `${err && err.message ? err.message : err}\n\n`
    + '如果提示 404，说明还没抓过历届排名。在项目目录里依次跑：\n'
    + '  npm run scrape:rankings      （约 570 期，二十多分钟）\n'
    + '  npm run dataset:hltv';
  if (show) show('排名数据没读到', msg);
  else document.body.textContent = msg;
  console.error(err);
}

async function boot() {
  window.__CS2_BOOTED__ = true;

  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${DATA_URL} → HTTP ${res.status}`);
  const data = await res.json();

  state.teams = data.teams || [];
  state.all = data.snapshots || [];
  if (!state.all.length) throw new Error('rankings.json 里没有任何期次记录');

  // 先在全部期次上建一次序列：一是数「多少支队上过榜」，二是挑默认要画的队
  // （在榜期数 / 当过多久第一）。挑完再由 applyRange 切片，选择会被保留。
  state.snaps = state.all.slice();
  const touched = buildSeries();
  pickDefaultTeams();

  $('#meta-badge').textContent = [
    `${state.all.length} 期`,
    `${state.all[0].d} → ${state.all[state.all.length - 1].d}`,
    `每期前 ${data.top || state.maxRank} 名`,
    `${touched.size} 支队上过榜`,
  ].filter(Boolean).join(' · ');

  for (const c of document.querySelectorAll('#range-chips .chip')) {
    c.addEventListener('click', () => applyRange(c.dataset.range));
  }

  applyRange('all');

  const redraw = () => {
    const box = $('#chart').getBoundingClientRect();
    const legendH = $('#legend').getBoundingClientRect().height || 40;
    const W = Math.max(320, Math.round(box.width));
    const H = Math.max(180, Math.round(box.height - legendH));
    if (state.last && state.last.W === W && state.last.H === H) return;
    state.last = { W, H };
    drawChart();
  };
  window.addEventListener('resize', redraw);

  // 左右方向键翻期次，省得一直用鼠标划
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { setIdx(Math.max(0, state.idx - 1)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setIdx(Math.min(state.snaps.length - 1, state.idx + 1)); e.preventDefault(); }
  });
}

boot().catch(fail);
