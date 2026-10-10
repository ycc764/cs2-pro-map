/**
 * 历届榜单：两个互相独立的视图，左边一排 chip 切换。
 *
 *  1. 「选手 TOP20」（默认）—— HLTV 每年评的年度 TOP20 选手，一年 20 张卡片，
 *     右边是跨年的上榜次数排行。数据来自 `npm run scrape:top20`（→ data/top20.json）
 *     经 `npm run dataset:hltv` 压出来的 public/data/top20.json：
 *       { people: [{ nick, real, cc, cn, flag, id?, av? }…],
 *         years:  [{ y, e: [[人下标, 名次, 战队, 战队链接, 新闻链接], …] }…] }
 *     同一个人跨届复用，所以人单独列表、每年只存下标。
 *
 *  2. 「战队世界排名」—— 一张「名次 × 时间」的曲线图 + 右侧某一期的前 30 名。
 *     数据来自 `npm run scrape:rankings`（→ data/rankings.json）：
 *       { teams: [队名…], snapshots: [{ d: '2026-10-05', n: 250, t: [[队下标, 名次, 积分, 名次变化], …] }] }
 *     队名单独列表、快照里只存下标，是因为同一支队会在几百期里反复出现。
 */
import { el } from './util.js';

const DATA_URL = '/data/rankings.json';
const TOP20_URL = '/data/top20.json';
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
  view: 'top20',
  teams: [],
  all: [],             // 全部期次，切范围时从这里切片
  snaps: [],           // 当前窗口内的期次（图、光标、右侧面板都只看它）
  range: 'all',
  series: new Map(),   // 队下标 → 每期的名次（不在榜上的是 null）
  sel: new Set(),
  idx: 0,
  maxRank: 30,
  t20: null,           // public/data/top20.json 的原文
  year: 0,             // 当前看的年份
  focus: -1,           // 在右侧排行里点中的人下标（左侧卡片会高亮）
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

/* ---------------- 选手 TOP20 ---------------- */

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * 头像：有就加载，失败或没有就退化成首字母方片。
 * TOP20 的 99 位全部有本地头像（老将那批是另外补下来的），所以兜底基本走不到。
 */
function avatarNode(p, cls) {
  const fallback = () => el('span', `pav-fallback${cls ? ` ${cls}` : ''}`, (p.nick || '?').slice(0, 1).toUpperCase());
  if (!p.av) return fallback();
  const img = el('img', `pav${cls ? ` ${cls}` : ''}`);
  img.src = `/${p.av}`;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => { img.replaceWith(fallback()); }, { once: true });
  return img;
}

/** 每人上榜几次、最好名次、上过哪些年 —— 右侧排行和「点一下跳到最近一次」都用它 */
function buildBoard() {
  const t = state.t20;
  const rec = t.people.map((p) => ({ p, times: 0, best: 99, years: [] }));
  for (const y of t.years) {
    for (const [pi, rank] of y.e) {
      const r = rec[pi];
      if (!r) continue;
      r.times++;
      if (rank < r.best) r.best = rank;
      r.years.push([y.y, rank]);
    }
  }
  for (const r of rec) r.years.sort((a, b) => a[0] - b[0]);
  // 上榜次数 → 最好名次 → 昵称，名次越小越靠前
  rec.sort((a, b) => (b.times - a.times) || (a.best - b.best) || String(a.p.nick).localeCompare(String(b.p.nick)));
  return rec;
}

function renderYearChips() {
  const box = $('#year-chips');
  box.replaceChildren();
  const frag = document.createDocumentFragment();
  // 从新到旧：默认想看的是最近一届
  for (const y of [...state.t20.years].sort((a, b) => b.y - a.y)) {
    const b = el('button', `chip${y.y === state.year ? ' on' : ''}`, String(y.y));
    b.type = 'button';
    b.addEventListener('click', () => { state.year = y.y; state.focus = -1; renderTop20(); });
    frag.append(b);
  }
  box.append(frag);
}

function renderTop20() {
  const t = state.t20;
  const y = t.years.find((v) => v.y === state.year) || t.years[0];
  state.year = y.y;
  renderYearChips();

  const grid = $('#top20-grid');
  grid.replaceChildren();
  const frag = document.createDocumentFragment();
  let first = '';
  for (const [pi, rank, team, teamHref, news] of y.e) {
    const p = t.people[pi] || {};
    if (!first) first = p.nick || '';
    // 前三名单独配色，其余走普通卡片
    const card = el('article', `pcard${rank <= 3 ? ` r${rank}` : ''}${pi === state.focus ? ' on' : ''}`);
    card.dataset.person = String(pi);
    card.append(el('span', 'pc-rank', `#${rank}`));
    card.append(avatarNode(p));

    const mid = el('div', 'pc-mid');
    const nick = el('div', 'pc-nick');
    // 有数字 id 就链到 HLTV 的选手数据页，没有就退回那一届的战报（2013 那批老将多半是前者）
    const href = p.id
      ? `https://www.hltv.org/stats/players/${p.id}/${slug(p.nick)}`
      : (news ? `https://www.hltv.org${news}` : '');
    if (href) {
      const a = el('a', '', p.nick || '?');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      nick.append(a);
    } else nick.append(p.nick || '?');
    mid.append(nick);
    mid.append(el('div', 'pc-real', p.real || ''));

    const meta = el('div', 'pc-meta');
    meta.append(el('span', 'pc-country', `${p.flag || ''} ${p.cn || p.cc || ''}`.trim()));
    if (team) {
      meta.append(el('span', 'pc-sep', '·'));
      const tn = el('span', 'pc-team', team);
      if (teamHref) tn.title = team;
      meta.append(tn);
    }
    mid.append(meta);
    card.append(mid);

    if (news) {
      const n = el('a', 'pc-news', '战报 ↗');
      n.href = `https://www.hltv.org${news}`;
      n.target = '_blank';
      n.rel = 'noopener noreferrer';
      n.title = 'HLTV 那一届的评选文章';
      card.append(n);
    }
    frag.append(card);
  }
  grid.append(frag);

  const hint = $('#year-hint');
  if (hint) hint.textContent = `${y.y} 年 · ${y.e.length} 人 · 第 1 名 ${first}`;

  const focused = state.focus >= 0 ? t.people[state.focus] : null;
  if (focused) {
    const rec = state.board.find((r) => r.p === focused);
    const list = (rec?.years || []).map(([yy, rk]) => `${yy} #${rk}`).join(' · ');
    $('#t20-side-title').textContent = `${focused.flag || ''} ${focused.nick}`.trim();
    $('#t20-side-sub').textContent = `上榜 ${rec?.times || 0} 次 · ${list}`;
  } else {
    $('#t20-side-title').textContent = '上榜次数排行';
    $('#t20-side-sub').textContent = `${t.people.length} 位选手上过榜 · 点名字跳到最近一次`;
  }
  renderBoard();
  if (state.focus >= 0) {
    grid.querySelector(`.pcard[data-person="${state.focus}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

function renderBoard() {
  const list = $('#t20-board');
  list.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const r of state.board) {
    const row = el('div', `rank-row${r.p === state.t20.people[state.focus] ? ' on' : ''}`);
    row.append(el('span', 'pos', `${r.times} 次`));
    row.append(avatarNode(r.p, 'sm'));
    row.append(el('span', 'nm', `${r.p.flag || ''} ${r.p.nick}`.trim()));
    row.append(el('span', 'pts', `最好 #${r.best}`));
    row.title = `${r.years.map(([yy, rk]) => `${yy} #${rk}`).join('\n')}`;
    row.addEventListener('click', () => {
      const pi = state.t20.people.indexOf(r.p);
      if (pi === state.focus) { state.focus = -1; renderTop20(); return; }
      state.focus = pi;
      // 跳到这人最近一次上榜的年份（点的是旧榜单里的人时，光高亮看不见）
      const last = r.years[r.years.length - 1];
      if (last && last[0] !== state.year) state.year = last[0];
      renderTop20();
    });
    frag.append(row);
  }
  list.append(frag);
}

/* ---------------- 视图切换 ---------------- */

function setView(v) {
  state.view = v;
  for (const c of document.querySelectorAll('#view-chips .chip')) {
    c.classList.toggle('on', c.dataset.view === v);
  }
  $('#top20-stage').hidden = v !== 'top20';
  $('#year-bar').hidden = v !== 'top20';
  $('#teams-stage').hidden = v !== 'teams';
  $('#range-bar').hidden = v !== 'teams';
  if (v === 'teams') applyRange(state.range);
  else renderTop20();
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

  // 两份数据并行取。TOP20 允许缺席（那就只剩战队排名一个视图），战队排名是必须的。
  const [rRes, tRes] = await Promise.all([
    fetch(DATA_URL, { cache: 'no-store' }),
    fetch(TOP20_URL, { cache: 'no-store' }).catch(() => null),
  ]);
  if (!rRes.ok) throw new Error(`GET ${DATA_URL} → HTTP ${rRes.status}`);
  const data = await rRes.json();

  state.teams = data.teams || [];
  state.all = data.snapshots || [];
  if (!state.all.length) throw new Error('rankings.json 里没有任何期次记录');

  // 先在全部期次上建一次序列：一是数「多少支队上过榜」，二是挑默认要画的队
  // （在榜期数 / 当过多久第一）。挑完再由 applyRange 切片，选择会被保留。
  state.snaps = state.all.slice();
  const touched = buildSeries();
  pickDefaultTeams();

  const teamBadge = [
    `${state.all.length} 期`,
    `${state.all[0].d} → ${state.all[state.all.length - 1].d}`,
    `${touched.size} 支队上过榜`,
  ].join(' · ');

  if (tRes && tRes.ok) {
    const t = await tRes.json();
    if (t.people?.length && t.years?.length) {
      state.t20 = t;
      state.board = buildBoard();
      // 年份按新的在前，默认停最近一届
      state.year = [...t.years].sort((a, b) => b.y - a.y)[0].y;
    }
  }

  const positions = state.t20 ? state.t20.years.reduce((n, y) => n + y.e.length, 0) : 0;
  $('#meta-badge').textContent = state.t20
    ? `选手 TOP20 ${state.t20.years.length} 届 · 战队排名 ${teamBadge}`
    : `战队排名 ${teamBadge}`;
  $('#view-hint').textContent = state.t20
    ? `${state.t20.years.map((y) => y.y).sort((a, b) => a - b)[0]}–${state.year} 共 ${state.t20.years.length} 届 · `
      + `${state.t20.people.length} 位选手 · ${positions} 个名次`
    : '没有 public/data/top20.json，只能看战队排名（跑 npm run scrape:top20 再 npm run dataset:hltv）';
  if (!state.t20) {
    for (const c of document.querySelectorAll('#view-chips .chip')) {
      if (c.dataset.view === 'top20') c.disabled = true;
    }
  }

  for (const c of document.querySelectorAll('#view-chips .chip')) {
    c.addEventListener('click', () => { if (!c.disabled) setView(c.dataset.view); });
  }
  for (const c of document.querySelectorAll('#range-chips .chip')) {
    c.addEventListener('click', () => applyRange(c.dataset.range));
  }

  setView(state.t20 ? 'top20' : 'teams');

  const redraw = () => {
    if (state.view !== 'teams') return;
    const box = $('#chart').getBoundingClientRect();
    const legendH = $('#legend').getBoundingClientRect().height || 40;
    const W = Math.max(320, Math.round(box.width));
    const H = Math.max(180, Math.round(box.height - legendH));
    if (state.last && state.last.W === W && state.last.H === H) return;
    state.last = { W, H };
    drawChart();
  };
  window.addEventListener('resize', redraw);

  // 左右方向键翻期次，省得一直用鼠标划（战队视图专用）
  window.addEventListener('keydown', (e) => {
    if (state.view !== 'teams') return;
    if (e.key === 'ArrowLeft') { setIdx(Math.max(0, state.idx - 1)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setIdx(Math.min(state.snaps.length - 1, state.idx + 1)); e.preventDefault(); }
  });
}

boot().catch(fail);
