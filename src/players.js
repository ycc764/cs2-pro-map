/**
 * 选手榜：HLTV 统计页的选手 Rating 3.0 排行。
 *
 * 数据来自 `npm run scrape:ratings`（→ data/ratings.json）经 `npm run dataset:hltv`
 * 折出来的 public/data/ratings.json。和地图页完全独立：这一页不 import three.js，
 * 也不读 dataset.json，只认自己的那一个 JSON。
 */
import { el, debounce, rampAt } from './util.js';

const DATA_URL = '/data/ratings.json';
const PAGE = 120;          // 一次渲染多少行（1700 行全塞进 DOM 会卡）
const R_MIN = 0.95;        // 生涯 rating 配色区间。实测全体落在 0.77–1.27，
const R_MAX = 1.28;        // 取 0.95–1.28 让色标整条都用上（低于 0.95 的一律算最冷档）
const S_MIN = 0.85;        // 逐年 sparkline 的**固定**纵轴。
const S_MAX = 1.55;        // 固定才能横向比较：一行里的短线和隔壁行的长线是同一把尺子。

const state = {
  all: [],
  years: [],
  rows: [],
  sort: { k: 'rating', dir: -1 },
  filter: 'all',
  cc: '',
  minMaps: 0,
  q: '',
  shown: PAGE,
};

const $ = (s) => document.querySelector(s);

/* ---------------- 小工具 ---------------- */

function svg(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  return n;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 生涯 rating → 颜色。用的是地图页同一个色标，读者不用学两套配色。 */
function ratingColor(r) {
  return rampAt(clamp((r - R_MIN) / (R_MAX - R_MIN), 0, 1));
}

const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmt2 = (n) => (n == null ? '—' : Number(n).toFixed(2));

/**
 * 头像：有就加载，加载失败或没有就退化成首字母方片。
 * 485 人里有 473 张，剩下的和 HLTV 后来改过图的都走兜底，不是错误。
 */
function avatarNode(p) {
  const fallback = () => el('span', 'pav-fallback', (p.nick || '?').slice(0, 1).toUpperCase());
  if (!p.av) return fallback();
  const img = el('img', 'pav');
  img.src = '/' + p.av;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => { img.replaceWith(fallback()); }, { once: true });
  return img;
}

/**
 * 逐年 rating 折线。横轴固定成整个数据集的年份跨度（2012–2026），
 * 所以"线只占右边一小段"= 这人是新秀，一眼能看出来。
 * 中间那条淡线是 1.00（选手平均水平），用来判断高低。
 */
function sparkNode(p) {
  const W = 118, H = 24, padX = 2, padY = 3;
  const ys = state.years;
  const node = svg('svg', { class: 'spark', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  if (!p.y || p.y.length < 2 || ys.length < 2) {
    node.append(svg('line', { class: 'axis', x1: padX, y1: H - padY, x2: W - padX, y2: H - padY }));
    return node;
  }
  const y0 = ys[0], y1 = ys[ys.length - 1];
  const sx = (yr) => padX + ((yr - y0) / (y1 - y0)) * (W - padX * 2);
  const sy = (r) => H - padY - ((clamp(r, S_MIN, S_MAX) - S_MIN) / (S_MAX - S_MIN)) * (H - padY * 2);

  // 1.00 参考线
  node.append(svg('line', { class: 'axis', x1: padX, y1: sy(1), x2: W - padX, y2: sy(1) }));

  const pts = p.y.map(([yr, r]) => [sx(yr), sy(r)]);
  node.append(svg('polyline', {
    points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
    stroke: ratingColor(p.rating),
  }));

  // 峰值那一年点一下，顺便给个 <title> 让鼠标悬停能看到数
  let peak = 0;
  for (let i = 1; i < p.y.length; i++) if (p.y[i][1] > p.y[peak][1]) peak = i;
  node.append(svg('circle', { cx: pts[peak][0].toFixed(1), cy: pts[peak][1].toFixed(1), r: 2.1, fill: ratingColor(p.rating) }));
  const tip = svg('title');
  tip.textContent = p.y.map(([yr, r, m]) => `${yr}: ${r.toFixed(2)}（${m} 图）`).join('\n');
  node.append(tip);
  return node;
}

/* ---------------- 筛选 / 排序 ---------------- */

function recompute() {
  const q = state.q.trim().toLowerCase();
  state.rows = state.all.filter((p) => {
    if (state.filter === 'cur' && !p.cur) return false;
    if (state.cc && p.cc !== state.cc) return false;
    if (state.minMaps && (p.maps || 0) < state.minMaps) return false;
    if (!q) return true;
    return (
      p.nick.toLowerCase().includes(q)
      || (p.team || '').toLowerCase().includes(q)
      || (p.cn || '').includes(q)
      || (p.cc || '').includes(q)
    );
  });

  const { k, dir } = state.sort;
  const key = k === 'rank' ? 'rating' : k;
  const dir2 = k === 'rank' ? -1 : dir;
  state.rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av || '').localeCompare(String(bv || ''), 'zh-Hans-CN') * dir2;
    }
    if ((av || 0) === (bv || 0)) return String(a.nick).localeCompare(String(b.nick)) * dir2;
    return ((av || 0) - (bv || 0)) * dir2;
  });

  state.shown = PAGE;
  render();
}

/* ---------------- 渲染 ---------------- */

function render() {
  const tb = $('#tbody');
  tb.replaceChildren();
  const slice = state.rows.slice(0, state.shown);
  const frag = document.createDocumentFragment();

  slice.forEach((p, i) => {
    const tr = el('tr');

    tr.append(el('td', 'rank', String(i + 1)));

    const who = el('div', 'who');
    who.append(avatarNode(p));
    const nick = el('span', 'nick');
    if (p.id) {
      const a = el('a', null, p.nick);
      a.href = `https://www.hltv.org/player/${p.id}/${encodeURIComponent(p.nick.toLowerCase())}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      nick.append(a);
    } else {
      nick.append(p.nick);
    }
    who.append(nick);
    if (p.cur) who.append(el('span', 'cur-tag', '前 100 队'));
    tr.append(el('td', null, who));

    tr.append(el('td', null, `${p.flag || ''} ${p.cn || p.cc || '—'}`.trim()));
    tr.append(el('td', p.team ? null : 'muted', p.team || '—'));

    const rc = el('span', 'rating', fmt2(p.rating));
    rc.style.color = ratingColor(p.rating);
    tr.append(el('td', 'num', rc));

    tr.append(el('td', 'num muted', fmt2(p.kd)));
    tr.append(el('td', 'num muted', fmtInt(p.maps)));
    const d = p.kdDiff;
    tr.append(el('td', 'num muted', d == null ? '—' : (d > 0 ? `+${fmtInt(d)}` : fmtInt(d))));

    const sparkCell = el('td');
    sparkCell.append(sparkNode(p));
    tr.append(sparkCell);

    frag.append(tr);
  });

  tb.append(frag);

  $('#count').textContent = fmtInt(state.rows.length);
  $('#empty').hidden = state.rows.length > 0;
  const more = $('#more');
  more.hidden = state.shown >= state.rows.length;
  if (!more.hidden) {
    $('#more-btn').textContent = `显示更多（还有 ${fmtInt(state.rows.length - state.shown)} 人）`;
  }
}

/* ---------------- 顶栏 / 控件 ---------------- */

function markSort() {
  for (const th of document.querySelectorAll('#thead th')) {
    const on = th.dataset.k === state.sort.k;
    th.classList.toggle('sorted', on);
    const caret = th.querySelector('.caret');
    if (caret) caret.textContent = state.sort.dir < 0 ? '▼' : '▲';
  }
}

function buildCountrySelect() {
  const counts = new Map();
  for (const p of state.all) if (p.cc) counts.set(p.cc, (counts.get(p.cc) || 0) + 1);
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const sel = $('#cc');
  const byCode = new Map(state.all.filter((p) => p.cc).map((p) => [p.cc, p]));
  for (const [cc, n] of list) {
    const p = byCode.get(cc);
    const o = el('option', null, `${p.flag || ''} ${p.cn || cc}（${n}）`.trim());
    o.value = cc;
    sel.append(o);
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ---------------- 启动 ---------------- */

function fail(err) {
  const show = window.__cs2ShowCrash;
  const msg = `${err && err.message ? err.message : err}\n\n`
    + '如果提示 404，多半是还没生成这份数据。在项目目录里依次跑：\n'
    + '  npm run scrape:ratings\n'
    + '  npm run dataset:hltv';
  if (show) show('选手榜数据没读到', msg);
  else document.body.textContent = msg;
  console.error(err);
}

async function boot() {
  window.__CS2_BOOTED__ = true;

  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${DATA_URL} → HTTP ${res.status}`);
  const data = await res.json();

  state.all = data.players || [];
  state.years = data.years || [];
  if (!state.all.length) throw new Error('ratings.json 里没有任何选手记录');

  const curN = state.all.filter((p) => p.cur).length;
  $('#n-all').textContent = fmtInt(state.all.length);
  $('#n-cur').textContent = fmtInt(curN);
  $('#meta-badge').textContent = [
    `${state.all.length} 名选手`,
    state.years.length ? `${state.years[0]}–${state.years[state.years.length - 1]}` : '',
    `${curN} 人在前 100 队`,
    data.generatedAt ? `数据 ${fmtDate(data.generatedAt)}` : '',
  ].filter(Boolean).join(' · ');

  // 地图页左侧那句"暂无冠军记录"的教训：说明文字也要跟着数据走
  const hint = document.querySelector('.ptable thead th:last-child');
  if (hint) hint.title = `纵轴固定 ${S_MIN}–${S_MAX}，中间那道淡线是 1.00`;

  buildCountrySelect();
  markSort();
  recompute();

  for (const th of document.querySelectorAll('#thead th')) {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (!k) return;
      if (state.sort.k === k) state.sort.dir *= -1;
      else state.sort = { k, dir: k === 'nick' || k === 'cn' || k === 'team' ? 1 : -1 };
      markSort();
      recompute();
      $('#tablewrap').scrollTop = 0;
    });
  }

  for (const c of document.querySelectorAll('#chips .chip')) {
    c.addEventListener('click', () => {
      state.filter = c.dataset.f;
      for (const x of document.querySelectorAll('#chips .chip')) x.classList.toggle('on', x === c);
      recompute();
    });
  }

  $('#q').addEventListener('input', debounce((e) => { state.q = e.target.value; recompute(); }, 160));
  $('#cc').addEventListener('change', (e) => { state.cc = e.target.value; recompute(); });
  $('#minmaps').addEventListener('input', debounce((e) => {
    state.minMaps = Math.max(0, Number(e.target.value) || 0);
    recompute();
  }, 260));

  $('#reset').addEventListener('click', () => {
    state.filter = 'all'; state.cc = ''; state.minMaps = 0; state.q = '';
    state.sort = { k: 'rating', dir: -1 };
    $('#q').value = ''; $('#cc').value = ''; $('#minmaps').value = '0';
    for (const x of document.querySelectorAll('#chips .chip')) x.classList.toggle('on', x.dataset.f === 'all');
    markSort();
    recompute();
  });

  $('#more-btn').addEventListener('click', () => {
    state.shown += PAGE * 2;
    render();
  });

  // 滚到底自动续一段，省得一直点
  const wrap = $('#tablewrap');
  wrap.addEventListener('scroll', () => {
    if (state.shown >= state.rows.length) return;
    if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 400) return;
    state.shown += PAGE;
    render();
  });
}

boot().catch(fail);
