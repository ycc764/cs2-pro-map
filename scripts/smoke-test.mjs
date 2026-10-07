/**
 * 冒烟测试：不开浏览器，验证「数据 → 地图」这条链路是否自洽。
 * 跑法：npm run test
 *
 * 注意：这里 import 的 d3-geo 是裸模块名，正常会去 node_modules 找。
 * 为了做到「不装依赖也能自检」，npm test 会带上 scripts/dev/register.mjs 这个解析钩子，
 * 把它映射到 public/vendor/ 下的那份（也就是浏览器实际加载的那份）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geoContains, geoCentroid, geoDistance } from 'd3-geo';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const ds = JSON.parse(readFileSync(join(ROOT, 'public/data/dataset.json'), 'utf8'));
const geo = JSON.parse(readFileSync(join(ROOT, 'public/data/countries-110m.json'), 'utf8'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log(`✓ ${label}${extra ? `  ${extra}` : ''}`); }
  else { fail += 1; failures.push(label); console.log(`✗ ${label}${extra ? `  ${extra}` : ''}`); }
}

function group(title) { console.log(`\n=== ${title} ===`); }

/* ---------------- 1. 结构自洽 ---------------- */
group('数据结构');
ok(Array.isArray(ds.teams) && ds.teams.length > 0, `有战队：${ds.teams.length}`);
ok(Array.isArray(ds.players) && ds.players.length > 0, `有选手：${ds.players.length}`);

const fromTeams = ds.teams.reduce((n, t) => n + (t.players?.length ?? 0), 0);
ok(fromTeams === ds.players.length, '战队阵容人数合计 == 选手总数', `${fromTeams} / ${ds.players.length}`);

const byCountry = {};
for (const p of ds.players) byCountry[p.country] = (byCountry[p.country] ?? 0) + 1;
const ctxTotal = Object.values(byCountry).reduce((a, b) => a + b, 0);
ok(ctxTotal === ds.players.length, '按国家计数合计 == 选手总数', `${ctxTotal}`);

const mismatched = Object.entries(ds.countries)
  .filter(([code, c]) => (c.count ?? 0) !== (byCountry[code] ?? 0));
ok(mismatched.length === 0, 'countries[].count 与选手明细一致',
  mismatched.length ? mismatched.map(([k, v]) => `${k}:${v.count}!=${byCountry[k] ?? 0}`).join(' ') : `${Object.keys(ds.countries).length} 个地区`);

ok(ds.meta.maxCountry === Math.max(...Object.values(ds.countries).map((c) => c.count)),
  'meta.maxCountry 正确', String(ds.meta.maxCountry));

/* ---------------- 2. 国家码 ↔ 国土要素 ---------------- */
group('国家码 ↔ 底图要素（GeoJSON）接合');
const withNumeric = Object.values(ds.countries).filter((c) => c.numeric);
const featureIds = new Set(geo.features.map((f) => String(f.id)));
const unjoined = withNumeric.filter((c) => !featureIds.has(String(c.numeric)));
ok(unjoined.length === 0, '有 numeric 的国家都能在地图上找到国土',
  unjoined.length ? unjoined.map((c) => `${c.nameZh}(${c.numeric})`).join(' ') : `${withNumeric.length}/${withNumeric.length}`);

/* ---------------- 3. 经纬度 → 国家（3D 点击链路） ---------------- */
group('经纬度 → 国家（3D 点击链路）');
const featureOf = (numeric) => geo.features.find((f) => String(f.id) === String(numeric));

/**
 * build-dataset.mjs 会把每个国家的 center 吸附到国土内部（world-atlas 几何核对），
 * 所以这里可以严格要求「点在境内」。TOL 只作为兜底提示，不再放宽判定。
 */
const TOL = (0.5 * Math.PI) / 180;
const nearEnough = (f, pt) => geoContains(f, pt);
const toleranceOnly = (f, pt) => !geoContains(f, pt) && geoDistance(pt, f) < TOL;

// 战队名在不同数据源里写法不同（Liquipedia 叫 "Team Vitality" / "Team Liquid"，
// HLTV 叫 "Vitality" / "Liquid"），所以按别名组匹配，让测试与数据源解耦。
const cases = [
  ['Team Vitality', 'Vitality'],
  ['Natus Vincere', 'NAVI'],
  ['FURIA'],
  ['TYLOO'],
  ['The MongolZ', 'MongolZ'],
  ['Team Liquid', 'Liquid'],
];
for (const aliases of cases) {
  const t = ds.teams.find((x) => aliases.includes(x.name));
  if (!t) { ok(false, `找不到战队 ${aliases.join(' / ')}`); continue; }
  const first = ds.players.find((p) => p.team === t.name);
  const c = ds.countries[first.country];
  const f = featureOf(c?.numeric);
  if (!f) { ok(false, `${t.name}: 无国土要素`, first.country); continue; }
  // 气泡放在 center（[经度, 纬度]）；点上去应命中本国
  ok(nearEnough(f, c.center), `${t.name} → ${c.nameZh}，气泡坐标落在本国境内`,
    `center=${c.center.join(',')}`);
}

const misPlaced = Object.values(ds.countries)
  .filter((c) => c.numeric && !nearEnough(featureOf(c.numeric), c.center));
ok(misPlaced.length === 0, '所有有国土的国家，气泡坐标都严格落在本国境内',
  misPlaced.length ? misPlaced.map((c) => c.nameZh).join(', ') : `${withNumeric.length} 个全部通过`);

const tolOnly = withNumeric.filter((c) => toleranceOnly(featureOf(c.numeric), c.center));
console.log(`  （落在边界外 0.5° 内的国家：${tolOnly.map((c) => c.nameZh).join(', ') || '无'}）`);

ok(Array.isArray(ds.countries.cn?.center) && ds.countries.cn.center[0] > 60 && ds.countries.cn.center[0] < 140,
  'center 是 [经度, 纬度] 而非 [纬度, 经度]', `cn.center=${JSON.stringify(ds.countries.cn?.center)}`);

ok(!!ds.countries.xk, '手工补齐的地区（科索沃）存在', ds.countries.xk ? `${ds.countries.xk.flag} ${ds.countries.xk.count} 人` : '');

/* ---------------- 4. 搜索 ---------------- */
group('搜索');
function searchIndex() {
  const idx = [];
  for (const c of Object.values(ds.countries)) {
    idx.push({ type: 'country', key: c.code, s: `${c.nameZh} ${c.name} ${c.code}`.toLowerCase() });
  }
  for (const t of ds.teams) {
    idx.push({ type: 'team', key: t.name, s: `${t.name} ${t.location ?? ''} ${t.portalSection ?? ''}`.toLowerCase() });
  }
  for (const p of ds.players) {
    idx.push({ type: 'player', key: p.id, s: `${p.id} ${p.name ?? ''} ${p.team}`.toLowerCase() });
  }
  return idx;
}
const IDX = searchIndex();
const find = (q) => IDX.filter((i) => i.s.includes(q.toLowerCase()));

for (const [q, type] of [['vitality', 'team'], ['zywoo', 'player'], ['丹麦', 'country'], ['tyloo', 'team']]) {
  const hits = find(q);
  ok(hits.some((h) => h.type === type), `搜索「${q}」命中 ${type}`, `共 ${hits.length} 条`);
}

/* ---------------- 5. 分布 ---------------- */
group('分布 top10');
const top = Object.values(ds.countries).sort((a, b) => b.count - a.count).slice(0, 10);
console.log(top.map((c) => `${c.flag} ${c.nameZh} ${c.count}`).join('  '));

/* ---------------- 6. 前端模块解析（不开浏览器也能查的运行时杀手） ---------------- */
group('前端模块解析');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mapBlock = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
ok(!!mapBlock, 'index.html 里有 import map');
const imports = mapBlock ? JSON.parse(mapBlock[1]).imports : {};

const srcDir = join(ROOT, 'src');
const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith('.js'));
const missing = [];
const bare = new Set();
for (const f of srcFiles) {
  const code = readFileSync(join(srcDir, f), 'utf8');
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      if (!existsSync(join(srcDir, spec))) missing.push(`${f} → ${spec}`);
    } else bare.add(spec);
  }
}
ok(missing.length === 0, '所有相对 import 都指向存在的文件', missing.join(', ') || `${srcFiles.length} 个源文件`);
const unmapped = [...bare].filter((s) => !(s in imports));
ok(unmapped.length === 0, '所有裸模块名都在 import map 里', unmapped.join(', ') || [...bare].join(', '));
const vendorMissing = Object.entries(imports)
  .filter(([, target]) => !existsSync(join(ROOT, 'public', target)))
  .map(([k]) => k);
ok(vendorMissing.length === 0, 'import map 指向的 vendor 文件都已就位', vendorMissing.join(', ') || `${Object.keys(imports).length} 个入口`);

/* ---------------- 7. 地图口径（中国） ----------------
   这一节是回归保护：底图由 scripts/build-basemap.mjs 生成，
   一旦有人重跑 npm run vendor 之外的东西、或把底图换回原始 world-atlas，
   藏南和台湾就会重新判给印度/独立图元（用户就是这么发现问题的）。
   判定方式和前端一致：features 顺序查找 + geoContains，第一个命中即返回。 */
group('地图口径（中国）');
const nineDash = geo.features.filter((f) => f.properties?.kind === 'nine-dash');
const pickable = geo.features.filter((f) => f.properties?.kind !== 'nine-dash');
const ownerOf = (lng, lat) => {
  const f = pickable.find((ft) => geoContains(ft, [lng, lat]));
  return f ? (f.properties?.name || String(f.id)) : '(无)';
};

const mustBeChina = {
  '藏南·Tawang': [91.87, 27.72],
  '藏南·Along': [94.8, 28.2],
  '藏南·Mechuka': [94.1, 28.6],
  '藏南·Walong': [96.8, 28.1],
  台北: [121.5, 25],
  钓鱼岛: [123.5, 25.75],
  阿克赛钦: [78.5, 35.2],
  喀喇昆仑走廊: [76.8, 36.0],
  海南: [110.3, 19.2],
};
const badOwner = Object.entries(mustBeChina).filter(([, p]) => ownerOf(p[0], p[1]) !== 'China');
ok(badOwner.length === 0, '藏南 / 台湾 / 钓鱼岛 / 阿克赛钦 / 海南 都属于中国',
  badOwner.length ? badOwner.map(([n, p]) => `${n}→${ownerOf(p[0], p[1])}`).join(' ')
    : `${Object.keys(mustBeChina).length} 个采样点`);

const mustStay = { 新德里: ['India', 77.2, 28.6], 廷布: ['Bhutan', 89.6, 27.5], 伊斯兰堡: ['Pakistan', 73.1, 33.7],
  东京: ['Japan', 139.7, 35.7], 乌兰巴托: ['Mongolia', 106.9, 47.9], 河内: ['Vietnam', 105.8, 21.0] };
const drifted = Object.entries(mustStay).filter(([, [want, lng, lat]]) => ownerOf(lng, lat) !== want);
ok(drifted.length === 0, '布尔减没有波及邻国（首都归属不变）',
  drifted.length ? drifted.map(([n, [want, lng, lat]]) => `${n}: 期望 ${want} 实得 ${ownerOf(lng, lat)}`).join(' ')
    : Object.keys(mustStay).join(' '));

ok(nineDash.length === 1, '底图里有南海诸岛九段线要素', `kind="nine-dash" × ${nineDash.length}`);

/* ---------------- 8. 选手头像与冠军荣誉 ----------------
 * 这两样是 scrape-players.mjs 单独补的，允许缺失（数据集是"可降级"的：
 * 没有就退化成首字母圆片、不显示荣誉列表）。但只要 dataset 里写了头像路径，
 * 文件就必须真的在 —— 否则前端会出现一堆 404 的破图。
 */
group('选手头像与冠军荣誉');
const withAvatar = ds.players.filter((p) => p.avatar);
const missingAvatar = withAvatar.filter((p) => !existsSync(join(ROOT, 'public', p.avatar)));
ok(missingAvatar.length === 0,
  withAvatar.length ? 'dataset 里的头像文件都存在' : '（本次数据不含头像）',
  withAvatar.length ? `${withAvatar.length}/${ds.players.length} 张` : `可跑 npm run scrape:players 补上`);
ok(withAvatar.every((p) => /^avatars\/\d+\.webp$/.test(p.avatar)),
  '头像路径形如 avatars/<数字id>.webp', withAvatar.length ? '' : '（跳过）');

const withTrophy = ds.players.filter((p) => p.trophies?.length);
const badTrophy = withTrophy.flatMap((p) => p.trophies.filter((t) => !t.name || typeof t.name !== 'string'));
ok(badTrophy.length === 0,
  withTrophy.length ? '冠军条目都有赛事名' : '（本次数据不含冠军荣誉）',
  withTrophy.length ? `${withTrophy.length} 人有冠军，共 ${withTrophy.reduce((n, p) => n + p.trophies.length, 0)} 条` : '');
// 冠军链接必须指向 HLTV 的赛事页；MVP / 年度最佳 / FPL 那些块当初就是靠 href 前缀滤掉的
const badHref = withTrophy.flatMap((p) => p.trophies.filter((t) => t.href && !t.href.startsWith('/events/')));
ok(badHref.length === 0, '冠军链接都指向 /events/（没混进 MVP / 年度奖项）',
  badHref.length ? badHref.slice(0, 3).map((t) => t.name).join(' ') : '');
// 每支战队的阵容也带着头像字段，两处要一致
const teamAvatarMismatch = ds.teams.flatMap((t) => t.players
  .filter((p) => (p.avatar || '') !== (ds.players.find((x) => x.id === p.id)?.avatar || '')));
ok(teamAvatarMismatch.length === 0, '战队阵容里的头像字段与选手表一致',
  teamAvatarMismatch.length ? teamAvatarMismatch.slice(0, 3).map((p) => p.id).join(' ') : '');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
