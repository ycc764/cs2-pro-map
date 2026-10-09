/**
 * 应用入口
 * ------------------------------------------------------------------
 * 数据：public/data/dataset.json（由 scripts/build-dataset.mjs 生成）
 *        public/data/countries-110m.json（GeoJSON，由 scripts/build-basemap.mjs 生成）
 *
 * 底图注意：它是 **GeoJSON FeatureCollection**，不是 TopoJSON。features 的**最后两个**
 * 是中国（id 156）和九段线（properties.kind === 'nine-dash'）——放在最后 = 画在最上层。
 * 详见 scripts/build-basemap.mjs 的说明。
 */
import { createGlobe3D } from './globe3d.js';
import { createGlobe2D } from './globe2d.js';
import {
  flagEmoji, debounce, el, RAMP_COLORS, colorFor, radiusFor, countT,
} from './util.js';

const $ = (s) => document.querySelector(s);

const view3dHost = $('#view3d');
const view2dHost = $('#view2d');
const viewport = $('#viewport');
const leftList = $('#left-list');
const leftTitle = $('#left-title');
const leftCount = $('#left-count');
const detail = $('#detail');
const tooltip = $('#tooltip');
const searchInput = $('#search');
const suggest = $('#suggest');
const hint = $('#hint');
const loading = $('#view-loading');

/* ------------------------------------------------------------------ *
 * 出错时直接把原因显示出来，避免白屏
 * ------------------------------------------------------------------ */
function reportError(title, message, detailText = '') {
  const box = $('#crash');
  if (!box) return;
  box.hidden = false;
  $('#crash-title').textContent = title;
  $('#crash-msg').textContent = message;
  const pre = $('#crash-detail');
  pre.textContent = detailText;
  pre.hidden = !detailText;
  if (loading && loading.isConnected) {
    loading.textContent = `${title}：${message}`;
  }
}

window.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'SCRIPT') {
    reportError('脚本加载失败', `无法加载 ${e.target.src}`, '如果是直接双击 index.html 打开的，浏览器会因 CORS 拒绝加载模块。请改用 启动.bat。');
    return;
  }
  reportError('运行出错', e.message || String(e.error || '未知错误'), e.error?.stack || '');
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportError('运行出错', (r && r.message) || String(r), (r && r.stack) || '');
});

/* ------------------------------------------------------------------ *
 * localStorage 在某些隐私模式 / file:// 下会直接抛异常
 * ------------------------------------------------------------------ */
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* 忽略 */ } },
};

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
const state = {
  data: null,
  geo: null,
  mode: store.get('cs2pm.mode') === '2d' ? '2d' : '3d',
  selected: null,        // 选中的国家码
  selectedTeam: null,    // 选中的战队（详情页）
  selectedPlayer: null,  // 选中的选手（详情页，头像 + 冠军荣誉）
  views: {},
};

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
async function boot() {
  // index.html 里有个 15s 看门狗，靠这个标记判断「模块到底跑起来没有」。
  // 必须在最前面设置 —— 它要回答的是「main.js 是否被成功加载并执行」。
  window.__CS2_BOOTED__ = true;

  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    throw new Error(
      '当前是以 file:// 直接打开的页面，浏览器会拒绝加载 ES 模块。'
      + '请回到项目文件夹双击「启动.bat」（或执行 node scripts/serve.mjs），'
      + '然后访问 http://127.0.0.1:5173/',
    );
  }

  const get = async (url) => {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url} 返回 HTTP ${r.status}`);
    return r.json();
  };

  const [dataset, basemap] = await Promise.all([
    get('data/dataset.json'),
    get('data/countries-110m.json'),
  ]);

  dataset.meta.maxCountry = Math.max(
    1,
    ...Object.values(dataset.countries).map((c) => c.count),
  );
  state.data = dataset;
  state.geo = basemap;

  $('#meta-badge').textContent =
    `${dataset.meta.teamCount} 支战队 · ${dataset.meta.playerCount} 名现役选手 · `
    + `${dataset.meta.countryCount} 个地区 · ${new Date(dataset.meta.fetchedAt).toLocaleDateString('zh-CN')}`;

  buildSearchIndex();
  buildViews();
  renderLeftList();
  renderLegend();
  // 启动时那句占位文案（"数据来源：…"）是在数据到位之前渲染的，这里带上真实
  // meta 重画一次，否则来源永远显示成"未知来源"。有选中项时不要覆盖它。
  if (!state.selected && !state.selectedTeam && !state.selectedPlayer) renderEmptyDetail();
  switchMode(state.mode, { silent: true });
  if (loading.isConnected) loading.remove();
}

/* ------------------------------------------------------------------ *
 * 视图
 * ------------------------------------------------------------------ */
function buildViews() {
  const common = {
    onSelect: (code) => selectCountry(code),
    onHover: (info) => showTooltip(info),
  };

  try {
    state.views['3d'] = createGlobe3D(view3dHost, common);
    state.views['3d'].setData(state.data, state.geo);
  } catch (e) {
    console.error('[3D] 初始化失败，回退到 2D', e);
    state.mode = '2d';
    state.views3dError = e;
    const btn = document.querySelector('.mode[data-mode="3d"]');
    if (btn) {
      btn.disabled = true;
      btn.title = `本机浏览器不支持 WebGL：${e.message}`;
    }
  }

  state.views['2d'] = createGlobe2D(view2dHost, common);
  state.views['2d'].setData(state.data, state.geo);
}

function switchMode(mode, { silent } = {}) {
  if (mode === '3d' && !state.views['3d']) mode = '2d';
  state.mode = mode;
  store.set('cs2pm.mode', mode);

  view3dHost.hidden = mode !== '3d';
  view2dHost.hidden = mode !== '2d';
  for (const b of document.querySelectorAll('.mode')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
  hint.textContent =
    mode === '3d'
      ? '拖动旋转 · 滚轮缩放 · 点击国家或气泡查看选手 · Esc 复位'
      : '拖动平移 · 滚轮缩放 · 点击国家或气泡查看选手 · Esc 复位';

  const v = state.views[mode];
  v?.show();
  requestAnimationFrame(() => v?.resize());
  if (state.selected) v?.select(state.selected);
  if (!silent) hideTooltip();
}

/* ------------------------------------------------------------------ *
 * 左侧：国家排行
 * ------------------------------------------------------------------ */
function renderLeftList() {
  leftTitle.textContent = '国家 / 地区';
  const rows = Object.values(state.data.countries).sort((a, b) => b.count - a.count);
  leftCount.textContent = `${rows.length} 个`;

  leftList.replaceChildren(
    ...rows.map((c) => {
      const row = el('div', 'row');
      row.dataset.code = c.code;
      row.append(
        el('span', 'flag', flagEmoji(c.code)),
        (() => {
          const d = el('div', 'label');
          d.append(el('div', null, c.nameZh));
          d.append(el('div', 'sub', `${c.teams.length} 支队`));
          return d;
        })(),
        el('span', 'num', String(c.count)),
      );
      row.addEventListener('click', () => selectCountry(c.code));
      return row;
    }),
  );
  markLeftSelection();
}

function markLeftSelection() {
  for (const r of leftList.querySelectorAll('.row')) {
    r.classList.toggle('selected', r.dataset.code === state.selected);
  }
}

/**
 * 图例：渐变条 + 刻度 + 尺寸参照圆
 *
 * 三样东西都从 util.js 的同一套函数现算，不在这里抄第二份：
 *   - 渐变条直接由 RAMP_COLORS 拼 linear-gradient，色标只有一处定义
 *   - 刻度的位置用 countT() 换算，所以刻度间距本身就说明了"颜色是按
 *     平方根铺开的"——等距的刻度配不等距的读数，读者一眼能看出来
 *   - 参照圆用和 2D 视图**同一个** radiusFor(base=2.5, scale=15)，
 *     这样它才是能拿去和地图上气泡直接比大小的尺子；用别的参数画
 *     出来的图例比没有图例更糟
 */
function renderLegend() {
  const max = state.data?.meta?.maxCountry ?? 1;

  $('#legend-bar').style.background =
    `linear-gradient(90deg, ${RAMP_COLORS.join(', ')})`;
  $('#legend-hint').textContent = `最多 ${max}`;

  const tickCounts = [...new Set([1, 5, 20, 50, max])]
    .filter((n) => n <= max)
    .sort((a, b) => a - b);
  $('#legend-ticks').replaceChildren(
    ...tickCounts.map((n) => {
      const s = el('span', null, String(n));
      s.style.left = `${(countT(n, max) * 100).toFixed(1)}%`;
      return s;
    }),
  );

  // 只有三个参照圆，挑能覆盖量级的：最少 / 中段 / 最多
  const dots = [...new Set([1, Math.max(1, Math.round(max / 8)), max])];
  $('#legend-dots').replaceChildren(
    ...dots.map((n) => {
      const d = radiusFor(n, max, 2.5, 15) * 2;
      const i = el('i');
      i.style.width = `${d.toFixed(1)}px`;
      i.style.height = `${d.toFixed(1)}px`;
      i.style.background = colorFor(n, max);
      const s = el('span', null, i, el('b', null, String(n)));
      return s;
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 选中：国家
 * ------------------------------------------------------------------ */
function selectCountry(code) {
  state.selectedTeam = null;
  state.selectedPlayer = null;
  state.selected = code;
  markLeftSelection();
  for (const v of Object.values(state.views)) {
    if (code) v.select?.(code);
    else v.reset?.();
  }
  if (code) {
    const row = leftList.querySelector(`.row[data-code="${code}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    renderCountryDetail(code);
  } else {
    renderEmptyDetail();
  }
  hideTooltip();
}

function renderEmptyDetail() {
  const m = state.data?.meta || {};
  const sourceName =
    { hltv: 'HLTV.org', liquipedia: 'Liquipedia' }[m.source] || m.source || '未知来源';
  detail.replaceChildren(
    (() => {
      const d = el('div', 'empty-state');
      d.append(
        el('h2', null, '👆 点击地球上的国家'),
        el('p', null, '或在上方搜索战队名 / 选手 ID / 国家名。'),
        el('p', 'tiny', `数据来源：${sourceName}（${m.license || '未知授权'}）。`),
      );
      return d;
    })(),
  );
}

/**
 * 取地区的英文名。
 * 老版本 build-dataset 会把 world-countries 的 name 对象原样写进数据集
 * （{ common, official, native }），直接拼进 DOM 会变成 "[object Object]"。
 * 这里两种形态都吃，免得数据集一换形态前端就崩相。
 */
function enName(v) {
  if (!v) return '';
  return typeof v === 'string' ? v : (v.common || v.official || '');
}

function renderCountryDetail(code) {
  const c = state.data.countries[code];
  if (!c) return renderEmptyDetail();

  const head = el('div', 'detail-head');
  const title = el('div', 'title');
  title.append(el('span', 'flag', flagEmoji(code)));
  const names = el('div');
  names.append(el('h2', null, c.nameZh), el('div', 'en', enName(c.name)));
  title.append(names);
  head.append(title);

  const stats = el('div', 'stats');
  const teamsInCountry = state.data.teams.filter((t) => t.countryCodes.includes(code) || t.location === enName(c.name));
  for (const [k, v] of [
    ['现役选手', c.count],
    ['选手所属战队', c.teams.length],
    ['战队驻在地', teamsInCountry.length],
  ]) {
    const s = el('div', 'stat');
    s.append(el('div', 'v', String(v)), el('div', 'k', k));
    stats.append(s);
  }
  head.append(stats);

  const body = el('div', 'detail-body');

  // 1) 该国籍的现役选手（按战队分组）
  const byTeam = new Map();
  for (const p of state.data.players) {
    if (p.country !== code) continue;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const g1 = el('div', 'group');
  g1.append(el('h3', null, `该国籍现役选手 · ${c.count} 人 / ${byTeam.size} 支队`));
  const sorted = [...byTeam.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [, players] of sorted) {
    for (const p of players) g1.append(playerRow(p, { showTeam: true }));
  }
  body.append(g1);

  // 2) 驻在该地区的战队（含完整阵容）
  const g2 = el('div', 'group');
  g2.append(el('h3', null, `战队驻在地为该地区 · ${teamsInCountry.length} 支`));
  for (const t of teamsInCountry) g2.append(teamCard(t, { open: teamsInCountry.length <= 3 }));
  if (!teamsInCountry.length) {
    g2.append(el('p', 'tiny', '（数据源未给出队伍驻在城市/国家信息）'));
  }
  body.append(g2);

  detail.replaceChildren(head, body);
}

/* ------------------------------------------------------------------ *
 * 选中：战队
 * ------------------------------------------------------------------ */
function selectTeam(teamName) {
  const t = state.data.teams.find((x) => x.name === teamName);
  if (!t) return;
  state.selectedTeam = teamName;
  state.selectedPlayer = null;

  const back = el('button', 'back', '‹ 返回国家视图');
  back.addEventListener('click', () => {
    state.selectedTeam = null;
    if (state.selected) renderCountryDetail(state.selected);
    else renderEmptyDetail();
  });

  const head = el('div', 'detail-head');
  const title = el('div', 'title');
  title.append(el('span', 'flag', flagEmoji(t.countryCodes[0])));
  const names = el('div');
  names.append(el('h2', null, t.name));
  names.append(
    el('div', 'en', [t.location, t.section].filter(Boolean).join(' · ') || '地区未知'),
  );
  title.append(names);
  head.append(title);

  const stats = el('div', 'stats');
  const cc = new Set(t.players.map((p) => p.country));
  for (const [k, v] of [['现役阵容', t.players.length], ['国籍数', cc.size]]) {
    const s = el('div', 'stat');
    s.append(el('div', 'v', String(v)), el('div', 'k', k));
    stats.append(s);
  }
  head.append(stats);

  const body = el('div', 'detail-body');
  const g = el('div', 'group');
  g.append(el('h3', null, '现役阵容'));
  for (const p of [...t.players].sort((a, b) => Number(b.igl) - Number(a.igl))) {
    g.append(playerRow({ ...p, team: t.name, teamPage: t.page }, { showTeam: false }));
  }
  body.append(g);

  detail.replaceChildren(back, head, body);
}

/* ------------------------------------------------------------------ *
 * 选手小头像
 * ------------------------------------------------------------------ */
const HLTV_ORIGIN = 'https://www.hltv.org';

/**
 * dataset 里的 avatar 形如 `avatars/11893.webp`（站点根相对路径），
 * 头像文件由 `npm run scrape:players` 抓下来缩成 120×120 的 WebP（约 4 KB）。
 * 没有图就退化成「首字母圆片」，不要留一个破图占位。
 */
function avatarImg(p, size) {
  if (!p.avatar) {
    const ph = el('span', 'pavatar ph', (p.id || '?').slice(0, 1).toUpperCase());
    ph.style.width = `${size}px`;
    ph.style.height = `${size}px`;
    ph.style.fontSize = `${Math.max(10, Math.round(size * 0.42))}px`;
    return ph;
  }
  const img = document.createElement('img');
  img.className = 'pavatar';
  img.src = `/${p.avatar}`;
  img.alt = p.id;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.width = size;
  img.height = size;
  return img;
}

function playerRow(p, { showTeam }) {
  const row = el('div', 'player clickable');
  row.title = `查看 ${p.id} 的头像与冠军荣誉`;
  row.append(avatarImg(p, 28));
  row.append(el('span', 'flag', flagEmoji(p.country)));
  const who = el('div');
  const idLine = el('div', 'pid', p.id);
  if (p.igl) idLine.append(el('span', 'tag', 'IGL'));
  // 有冠军才挂奖杯角标 —— 一眼扫过去就知道谁的履历厚
  if (p.trophies?.length) idLine.append(el('span', 'tag gold', `🏆${p.trophies.length}`));
  who.append(idLine, el('div', 'pname', p.name || ''));
  row.append(who);
  if (showTeam) {
    const t = el('div', 'team', p.team);
    t.title = `${p.team} 全员`;
    // 别让「点战队名」冒泡成「点选手」
    t.addEventListener('click', (e) => { e.stopPropagation(); selectTeam(p.team); });
    row.append(t);
  }
  row.addEventListener('click', () => selectPlayer(p.id));
  return row;
}

/* ------------------------------------------------------------------ *
 * 选中：选手（大头像 + 冠军荣誉）
 * ------------------------------------------------------------------ */
function selectPlayer(id) {
  const p = state.data.players.find((x) => x.id === id);
  if (!p) return;
  state.selectedPlayer = id;
  renderPlayerDetail(p);
}

function renderPlayerDetail(p) {
  const back = el('button', 'back', '‹ 返回');
  back.addEventListener('click', () => {
    state.selectedPlayer = null;
    if (state.selectedTeam) selectTeam(state.selectedTeam);
    else if (state.selected) renderCountryDetail(state.selected);
    else renderEmptyDetail();
  });

  const head = el('div', 'detail-head');
  const title = el('div', 'title');
  title.append(avatarImg(p, 72));
  const names = el('div');
  names.append(el('h2', null, p.id));
  if (p.name) names.append(el('div', 'en', p.name));
  names.append(el('div', 'en', [
    flagEmoji(p.country), p.countryName, p.role || '', p.igl ? '队内指挥' : '',
  ].filter(Boolean).join(' · ')));
  const teamLink = el('button', 'link', p.team);
  teamLink.addEventListener('click', () => selectTeam(p.team));
  names.append(teamLink);
  title.append(names);
  head.append(title);

  const trophies = Array.isArray(p.trophies) ? p.trophies : [];
  const stats = el('div', 'stats');
  // 只留「冠军数」和「现役战队」。加入日期对看分布图没什么用，占地方。
  for (const [k, v] of [['冠军', trophies.length], ['现役战队', p.team]]) {
    const s = el('div', 'stat');
    s.append(el('div', 'v', String(v)), el('div', 'k', k));
    stats.append(s);
  }
  head.append(stats);

  const body = el('div', 'detail-body');
  const g = el('div', 'group');
  g.append(el('h3', null, `冠军荣誉 · ${trophies.length} 个`));
  if (!trophies.length) {
    g.append(el('p', 'tiny', 'HLTV 上没有这位选手的赛事冠军记录（可能刚出道，或者还没拿过有记录的比赛）。'));
  } else {
    const list = el('div', 'trophy-list');
    for (const t of trophies) {
      const a = el('a', 'trophy-item');
      if (t.href) {
        a.href = /^https?:/.test(t.href) ? t.href : HLTV_ORIGIN + t.href;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
      }
      a.append(el('span', 'tname', t.name));
      a.append(el('span', 'tarrow', '↗'));
      list.append(a);
    }
    g.append(list);
  }
  body.append(g);

  detail.replaceChildren(back, head, body);
}

function teamCard(t, { open = false } = {}) {
  const card = el('div', 'team-card');
  const header = el('header');
  header.append(el('span', 'flag', flagEmoji(t.countryCodes[0])));
  header.append(el('span', 'tname', t.name));
  header.append(el('span', 'tsec', t.section || t.location || ''));
  card.append(header);

  const roster = el('div');
  const fill = () => {
    if (roster.childElementCount) { roster.replaceChildren(); return; }
    for (const p of [...t.players].sort((a, b) => Number(b.igl) - Number(a.igl))) {
      roster.append(playerRow({ ...p }, { showTeam: false }));
    }
  };
  header.addEventListener('click', () => {
    fill();
    card.classList.toggle('open');
  });
  if (open) fill();
  card.append(roster);
  return card;
}

/* ------------------------------------------------------------------ *
 * 提示框
 * ------------------------------------------------------------------ */
function showTooltip(info) {
  if (!info) return hideTooltip();
  const c = state.data.countries[info.code];
  if (!c) return hideTooltip();
  tooltip.hidden = false;
  tooltip.replaceChildren(
    el('div', null, `${flagEmoji(c.code)} ${c.nameZh}`),
    (() => {
      const d = el('div');
      d.append(el('b', null, String(c.count)), document.createTextNode(' 名现役选手'));
      return d;
    })(),
    el('div', null, `${c.teams.length} 支队`),
  );
  const box = viewport.getBoundingClientRect();
  tooltip.style.left = `${info.x - box.left + 14}px`;
  tooltip.style.top = `${info.y - box.top + 14}px`;
}
function hideTooltip() { tooltip.hidden = true; }

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */
let index = null;
function buildSearchIndex() {
  const countries = Object.values(state.data.countries).map((c) => ({
    kind: 'country', key: c.code, label: c.nameZh, sub: `${c.count} 名选手`,
    search: `${c.nameZh} ${enName(c.name)} ${c.code}`.toLowerCase(),
  }));
  const teams = state.data.teams.map((t) => ({
    kind: 'team', key: t.name, label: t.name,
    sub: `${t.players.length} 人 · ${t.section || t.location || ''}`,
    search: `${t.name} ${t.page ?? ''}`.toLowerCase(),
  }));
  const players = state.data.players.map((p) => ({
    kind: 'player', key: p.id, label: p.id, sub: `${p.team}${p.name ? ' · ' + p.name : ''}`,
    search: `${p.id} ${p.name ?? ''} ${p.team}`.toLowerCase(),
  }));
  index = [...countries, ...teams, ...players];
}

function runSearch(q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return hideSuggest();
  const hits = index.filter((i) => i.search.includes(s));
  hits.sort((a, b) => {
    const ra = a.label.toLowerCase().startsWith(s) ? 0 : 1;
    const rb = b.label.toLowerCase().startsWith(s) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const order = { country: 0, team: 1, player: 2 };
    return order[a.kind] - order[b.kind];
  });
  renderSuggest(hits.slice(0, 24));
}

function renderSuggest(hits) {
  if (!hits.length) return hideSuggest();
  suggest.hidden = false;
  suggest.replaceChildren(
    ...hits.map((h) => {
      const b = el('button');
      b.append(
        el('span', null, h.kind === 'country' ? flagEmoji(h.key) : h.kind === 'team' ? '🛡️' : '🎯'),
        (() => {
          const d = el('span');
          d.append(el('div', null, h.label), el('div', 'sub', h.sub));
          return d;
        })(),
        el('span', 's-kind', { country: '国家', team: '战队', player: '选手' }[h.kind]),
      );
      b.addEventListener('click', () => applyHit(h));
      return b;
    }),
  );
}
function hideSuggest() { suggest.hidden = true; suggest.replaceChildren(); }

function applyHit(h) {
  searchInput.value = h.label;
  hideSuggest();
  if (h.kind === 'country') selectCountry(h.key);
  else if (h.kind === 'team') selectTeam(h.key);
  else {
    const p = state.data.players.find((x) => x.id === h.key);
    // 先定位到国家（地图会高亮、左侧列表也会滚过去），再打开选手详情
    if (p) { selectCountry(p.country); selectPlayer(p.id); }
  }
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */
for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', () => {
    if (b.disabled) return;
    switchMode(b.dataset.mode);
  });
}
searchInput.addEventListener('input', debounce(() => runSearch(searchInput.value), 120));
searchInput.addEventListener('focus', () => { if (searchInput.value) runSearch(searchInput.value); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideSuggest(); searchInput.blur(); return; }
  if (e.key === 'Enter') {
    const first = suggest.querySelector('button');
    if (first) first.click();
  }
});
document.addEventListener('click', (e) => {
  if (!suggest.contains(e.target) && e.target !== searchInput) hideSuggest();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!suggest.hidden) { hideSuggest(); return; }
  if (document.activeElement === searchInput) return; // 输入框自己处理
  selectCountry(null);
});
$('#crash-reload')?.addEventListener('click', () => location.reload());
$('#crash-copy')?.addEventListener('click', async () => {
  const text = `${$('#crash-title').textContent}\n${$('#crash-msg').textContent}\n${$('#crash-detail').textContent}`;
  try { await navigator.clipboard.writeText(text); } catch { /* 忽略 */ }
});

window.addEventListener('resize', debounce(() => {
  for (const v of Object.values(state.views)) v.resize?.();
}, 120));

renderEmptyDetail();
boot().catch((e) => {
  console.error(e);
  reportError('加载失败', e.message || String(e), e.stack || '');
});
