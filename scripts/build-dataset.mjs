/**
 * 把抓取结果加工成前端用的 dataset.json
 * ------------------------------------------------------------------
 * 用法：
 *   node scripts/build-dataset.mjs              → 读 data/liquipedia.json（默认）
 *   node scripts/build-dataset.mjs hltv         → 读 data/hltv.json
 *   node scripts/build-dataset.mjs path/to/x.json
 *
 * 产出 public/data/dataset.json：
 *   meta      项目元信息（来源 / 抓取时间 / 许可证）
 *   countries { code: { code, numeric, name, nameZh, flag, center, count, teams[], players[] } }
 *             center 一律是 [经度, 纬度]（GeoJSON / d3-geo 约定），可直接喂给 projection()
 *   teams[]   每队：赛区、国家、logo、阵容
 *   players[] 扁平选手表：id/name/flag/team/role/igl/joindate + 国家元数据
 *
 * 国家元数据来源：world-countries（CCA2 ↔ CCN3 ↔ 经纬度 ↔ 中文名），
 * 首次运行时下载并缓存到 data/countries.raw.json（之后可离线）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { geoContains, geoBounds } from 'd3-geo';

const SRC = process.argv[2]
  ? (process.argv[2].includes('/') || process.argv[2].endsWith('.json') ? process.argv[2] : `data/${process.argv[2]}.json`)
  : 'data/liquipedia.json';
const CACHE = 'data/countries.raw.json';
const OUT_DIR = 'public/data';
const META_URL = 'https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json';

/* 抓取数据里的旗帜代码 → ISO 3166-1 alpha-2（Liquipedia 偶尔用非标准码） */
const ALIAS = { uk: 'gb', el: 'gr', en: 'gb', sui: 'ch' };

/* world-countries / world-atlas 里没有的地区，手工补元数据（做气泡用，画不出国土） */
const MANUAL = {
  xk: { code: 'xk', numeric: null, name: 'Kosovo', nameZh: '科索沃', flag: '🇽🇰', center: [20.9, 42.6], region: 'Europe' },
};

/**
 * world-countries 的 latlng 是 [纬度, 经度]，而 GeoJSON / d3-geo 一律用 [经度, 纬度]。
 * 这里统一转成 [lng, lat]，字段名也叫 center，避免再搞混。
 */
const toLngLat = (ll) => (Array.isArray(ll) && ll.length === 2 ? [ll[1], ll[0]] : null);

async function countryTable() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log('下载国家元数据 …');
  const r = await fetch(META_URL, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`国家元数据下载失败 HTTP ${r.status}`);
  const j = await r.json();
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(j));
  return j;
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const meta = await countryTable();

const byCca2 = new Map();
for (const c of meta) if (c.cca2) byCca2.set(c.cca2.toLowerCase(), c);

function countryOf(flagCode) {
  const code = ALIAS[flagCode] || flagCode;
  if (MANUAL[code]) return { ...MANUAL[code] };
  const c = byCca2.get(code);
  if (!c) return { code: flagCode || 'xx', numeric: null, name: flagCode || '未知', nameZh: flagCode || '未知', flag: '🏳️', center: null };
  // world-countries 的 c.name 是 { common, official, native } 对象，不是字符串！
  // 直接存下去会：详情页显示成 "[object Object]"、英文国名搜不到、
  // 以及 `t.location === c.name` 这种比较永远为 false。这里统一取 common。
  const common = (typeof c.name === 'string' ? c.name : c.name?.common) || c.cca2;
  return {
    code: c.cca2.toLowerCase(),
    numeric: c.ccn3,
    name: common,
    nameZh: c.translations?.zho?.common || common,
    flag: c.flag || '🏳️',
    center: toLngLat(c.latlng),
    region: c.region,
    subregion: c.subregion,
  };
}

const countries = {};
const players = [];

for (const t of raw.teams) {
  t.countryCodes = [...new Set(t.players.map((p) => (ALIAS[p.flag] || p.flag) || 'xx'))];
  for (const p of t.players) {
    const info = countryOf(p.flag);
    const rec = {
      id: p.id,
      // HLTV 的数字选手 id（从 /player/11893/zywoo 里取）。选手榜的 rating 数据
      // 是按这个 id 对齐的 —— `/stats/players/<id>` 和 `/player/<id>` 用的是同一套 id。
      hlId: Number(String(p.page || '').match(/\/player\/(\d+)/)?.[1]) || 0,
      name: p.name,
      flag: p.flag,
      country: info.code,
      countryName: info.nameZh,
      countryNameEn: info.name,
      numeric: info.numeric,
      center: info.center,
      team: t.name,
      teamPage: t.page,
      section: t.portalSection || '',
      role: p.role,
      igl: !!p.igl,
      joindate: p.joindate || '',
    };
    players.push(rec);
    (countries[info.code] ??= { ...info, count: 0, players: [], teams: [] });
    countries[info.code].count++;
    countries[info.code].players.push(rec.id + '@' + t.name);
    if (!countries[info.code].teams.includes(t.name)) countries[info.code].teams.push(t.name);
  }
}

players.sort((a, b) => a.id.localeCompare(b.id));
for (const c of Object.values(countries)) {
  c.teams.sort();
  c.players.sort();
}

/* ------------------------------------------------------------------
 * 把气泡位置吸附到国土内部。
 * world-countries 给的只是一个"代表点"，落在简化后的国界外并不奇怪
 * （以色列这种细长国家最典型）。这里用 world-atlas 的国土几何核对一遍，
 * 不在境内就在包围盒里网格采样，取离中心最近的境内点。
 * ------------------------------------------------------------------ */
const basemapFile = path.join(OUT_DIR, 'countries-110m.json');
if (!fs.existsSync(basemapFile)) {
  console.error('✗ 找不到 public/data/countries-110m.json，请先跑 `npm run basemap` 生成底图。');
  process.exit(1);
}
// 必须用 build-basemap.mjs 生成的那份底图（中国标准地图口径），否则吸附会把中国境内
// 的气泡按 Natural Earth 的口径算到印度/台湾身上。
const landFeatures = JSON.parse(fs.readFileSync(basemapFile, 'utf8')).features;
const featureByNumeric = new Map(landFeatures.map((f) => [String(f.id), f]));

function snapInside(f, fallback) {
  if (!fallback) return fallback;
  if (geoContains(f, fallback)) return fallback;
  const [[x0, y0], [x1, y1]] = geoBounds(f);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let best = null;
  let bestD = Infinity;
  const N = 32;
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      const p = [x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * j) / N];
      if (!geoContains(f, p)) continue;
      const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best || fallback;
}

const snapped = [];
for (const c of Object.values(countries)) {
  if (!c.numeric) continue;
  const f = featureByNumeric.get(String(c.numeric));
  if (!f) continue;
  const fixed = snapInside(f, c.center);
  if (fixed !== c.center) {
    snapped.push(`${c.nameZh} ${JSON.stringify(c.center)}→${JSON.stringify(fixed.map((n) => +n.toFixed(2)))}`);
    c.center = fixed;
    // 选手记录里冗余的 center 也一起改，避免两份不一致
    for (const p of players) if (p.country === c.code) p.center = fixed;
  }
}
if (snapped.length) console.log('气泡位置已吸附到国土内:', snapped.join('; '));

/* ------------------------------------------------------------------
 * 合并选手头像与冠军荣誉（由 `npm run scrape:players` 单独产出，可有可无）
 * 键是选手昵称，与 data/hltv.json 里 teams[].players[].id 完全一致。
 * ------------------------------------------------------------------ */
const EXTRA_FILE = 'data/players.json';
const extra = { players: {} };
if (fs.existsSync(EXTRA_FILE)) {
  try {
    Object.assign(extra, JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8')));
  } catch (e) {
    console.warn(`⚠ ${EXTRA_FILE} 解析失败，本次跳过头像与荣誉：${e.message}`);
  }
} else {
  console.log(`（没有 ${EXTRA_FILE}，本次数据不带头像与冠军；想补就跑 npm run scrape:players）`);
}
const extraOf = (id) => extra.players?.[id] ?? null;
let withAvatar = 0;
let trophyTotal = 0;
for (const p of players) {
  const e = extraOf(p.id);
  if (!e) continue;
  if (e.avatar) {
    p.avatar = e.avatar; // 形如 avatars/11893.webp，前端加前导 / 直接当 img.src
    withAvatar++;
  }
  if (Array.isArray(e.trophies) && e.trophies.length) {
    p.trophies = e.trophies.map((t) => ({ name: t.name, href: t.href || '' }));
    trophyTotal += p.trophies.length;
  }
}
if (Object.keys(extra.players ?? {}).length) {
  console.log(`选手资料：头像 ${withAvatar}/${players.length} 张，冠军荣誉共 ${trophyTotal} 条`);
}

const dataset = {
  meta: {
    source: raw.source,
    sourceUrl: raw.sourceUrl,
    license: raw.license,
    fetchedAt: raw.fetchedAt,
    generatedAt: new Date().toISOString(),
    teamCount: raw.teams.length,
    playerCount: players.length,
    countryCount: Object.keys(countries).length,
    emptyTeamCount: raw.emptyTeams.length,
    avatarCount: withAvatar,
    trophyCount: trophyTotal,
    maxCountry: Math.max(...Object.values(countries).map((c) => c.count)),
  },
  sections: Object.fromEntries(
    Object.entries(raw.sections).map(([k, v]) => [k, v.length]),
  ),
  countries,
  teams: raw.teams.map((t) => ({
    name: t.name,
    page: t.page,
    location: t.location,
    section: t.portalSection || '',
    infoboxRegion: t.infoboxRegion || '',
    logo: t.logo,
    countryCodes: t.countryCodes,
    players: t.players.map((p) => ({
      id: p.id,
      name: p.name,
      flag: p.flag,
      country: ALIAS[p.flag] || p.flag,
      countryName: countryOf(p.flag).nameZh,
      role: p.role,
      igl: !!p.igl,
      joindate: p.joindate || '',
      avatar: extraOf(p.id)?.avatar || '',
    })),
  })),
  players,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'dataset.json'), JSON.stringify(dataset));

console.log(
  `dataset.json: ${dataset.teams.length} 队 / ${players.length} 人 / ${Object.keys(countries).length} 个地区`,
);

// 底图（countries-110m.json）由 `npm run basemap` 生成，这里**故意不再**从
// node_modules/world-atlas 拷贝：那一份是 Natural Earth 的实际控制口径，把台湾画成独立
// 图元、把藏南整块划给印度、且没有九段线。只要拷一次，中国标准地图的修正就被覆盖了。
// 那个文件本身既是世界底图，也在最后两个 feature 里带着中国疆域和九段线。
const basemap = path.join(OUT_DIR, 'countries-110m.json');
if (!fs.existsSync(basemap)) {
  console.warn('⚠ 缺少 public/data/countries-110m.json，请先跑 `npm run basemap` 生成底图。');
}
console.log(
  '国家分布 top15:',
  Object.values(countries)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((c) => `${c.nameZh}(${c.count})`)
    .join(' '),
);

/* ==================================================================
 * 选手 Rating 榜（由 `npm run scrape:ratings` 产出 data/ratings.json）
 * ------------------------------------------------------------------
 * 只认生涯总计那一档作为排序依据；逐年数据折成每人一条 [年, rating, maps]
 * 的小数组，给前端画趋势用。逐年全量塞进去会让产物从 200KB 涨到 1.6MB，
 * 而页面只需要"这个人每年什么水平"这一条线。
 * ================================================================== */
const RATINGS_FILE = 'data/ratings.json';
if (fs.existsSync(RATINGS_FILE)) {
  const rk = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
  const career = rk.ranges?.career?.players ?? [];

  const byYear = new Map();
  for (const [key, range] of Object.entries(rk.ranges ?? {})) {
    if (!/^\d{4}$/.test(key)) continue;
    const y = Number(key);
    for (const p of range.players ?? []) {
      if (!byYear.has(p.id)) byYear.set(p.id, []);
      byYear.get(p.id).push([y, p.rating, p.maps]);
    }
  }
  for (const arr of byYear.values()) arr.sort((a, b) => a[0] - b[0]);

  // 我们地图上那 485 人（前 100 队）标出来，页面上可以只看"现役"
  const inMap = new Set(players.map((p) => p.hlId).filter(Boolean));
  // 顺带把头像带上：选手榜里有一张脸比一行文字好认得多（只有前 100 队的人有）
  const avatarByHlId = new Map(players.filter((p) => p.hlId && p.avatar).map((p) => [p.hlId, p.avatar]));

  const rows = career.map((p) => {
    const info = countryOf(String(p.countryCode || '').toLowerCase());
    const o = {
      id: p.id,
      nick: p.nick,
      cc: info.code,
      cn: info.nameZh,
      flag: info.flag,
      team: p.team,
      maps: p.maps,
      rounds: p.rounds,
      kd: p.kd,
      kdDiff: p.kdDiff,
      rating: p.rating,
    };
    if (inMap.has(p.id)) o.cur = 1;
    const av = avatarByHlId.get(p.id);
    if (av) o.av = av;
    const y = byYear.get(p.id);
    if (y && y.length) o.y = y;
    return o;
  });

  const years = Object.keys(rk.ranges ?? {}).filter((k) => /^\d{4}$/.test(k)).map(Number).sort((a, b) => a - b);
  const ratings = {
    source: 'hltv',
    sourceUrl: rk.sourceUrl,
    license: rk.license,
    fetchedAt: rk.fetchedAt,
    generatedAt: new Date().toISOString(),
    careerFrom: rk.ranges?.career?.startDate || '',
    careerTo: rk.ranges?.career?.endDate || '',
    years,
    inMapCount: rows.filter((r) => r.cur).length,
    players: rows,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'ratings.json'), JSON.stringify(ratings));
  console.log(
    `ratings.json: ${rows.length} 名选手有生涯 rating（其中 ${ratings.inMapCount} 人在前 100 队里），`
    + `${rows.filter((r) => r.y).length} 人有逐年数据，覆盖 ${years[0]}–${years[years.length - 1]}`
    + `（${(fs.statSync(path.join(OUT_DIR, 'ratings.json')).size / 1024).toFixed(0)} KB）`,
  );
} else {
  console.log(`（没有 ${RATINGS_FILE}，本次不生成选手榜数据；想补就跑 npm run scrape:ratings）`);
}

/* ==================================================================
 * 历届世界排名（由 `npm run scrape:rankings` 产出 data/rankings.json）
 * ------------------------------------------------------------------
 * 队名会重复出现在几百期里，所以列一张 teams 表，快照里只存下标。
 * 每项是 [队下标, 名次, 积分, 名次变化]，570 期 × 前 30 名 ≈ 240 KB。
 * ================================================================== */
const RANKINGS_FILE = 'data/rankings.json';
if (fs.existsSync(RANKINGS_FILE)) {
  const rk = JSON.parse(fs.readFileSync(RANKINGS_FILE, 'utf8'));
  const snaps = [...(rk.snapshots ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1)); // 旧 → 新
  const teamIndex = new Map();
  const teamNames = [];
  const idx = (name) => {
    let i = teamIndex.get(name);
    if (i === undefined) { i = teamNames.length; teamIndex.set(name, i); teamNames.push(name); }
    return i;
  };
  const out = snaps.map((s) => ({
    d: s.date,
    n: s.total || 0,
    t: (s.teams ?? []).map((t) => [idx(t.name), t.rank, t.points, t.change || 0]),
  }));
  const payload = {
    source: 'hltv',
    sourceUrl: rk.sourceUrl,
    license: rk.license,
    fetchedAt: rk.fetchedAt,
    generatedAt: new Date().toISOString(),
    top: rk.top || 0,
    teams: teamNames,
    snapshots: out,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'rankings.json'), JSON.stringify(payload));
  const span = out.length ? `${out[0].d} → ${out[out.length - 1].d}` : '(空)';
  console.log(
    `rankings.json: ${out.length} 期（${span}）、${teamNames.length} 支出现过的战队`
    + `（${(fs.statSync(path.join(OUT_DIR, 'rankings.json')).size / 1024).toFixed(0)} KB）`,
  );
} else {
  console.log(`（没有 ${RANKINGS_FILE}，本次不生成历届排名数据；想补就跑 npm run scrape:rankings）`);
}
