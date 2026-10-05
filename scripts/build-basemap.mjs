#!/usr/bin/env node
/**
 * 构建底图：把世界底图改成中国标准地图口径
 * ==================================================================
 * 为什么要这一步
 * ------------------------------------------------------------------
 * `world-atlas` 用的是 Natural Earth 的 de-facto（实际控制）口径，对中国的
 * 画法与《地图管理条例》不符：
 *   · 台湾（ISO 158）是独立图元，和大陆分开；
 *   · 藏南（阿鲁纳恰尔）整块划在印度名下；
 *   · 喀喇昆仑走廊（沙克思干谷地）划在巴基斯坦名下；
 *   · 南海诸岛与九段线根本不存在（那一片是空白海面）。
 * 阿克赛钦在 Natural Earth 里算是划给中国的，没问题。
 *
 * 做法
 * ------------------------------------------------------------------
 *   1. 从 world-atlas 的 110m TopoJSON 里剔除 China(156) 与 Taiwan(158)；
 *   2. 用阿里云 DataV GeoAtlas 的中国疆域替换 —— 它是按国家基础地理信息中心
 *      的标准地图做的：藏南、阿克赛钦、台湾、钓鱼岛、南海诸岛全在中国境内，
 *      九段线单独作为 `adcode = 100000_JD` 的图元给出；
 *   3. 把中国疆域从与之重叠的邻国身上做布尔减。**这一步不能省**：如果只是把
 *      中国画在最上层，虽然填色盖住了邻居，但 3D 的拾取用的是
 *      `geoContains()` 顺序查找（src/globe3d.js），点在藏南会先命中印度；
 *   4. 把几何统一成 RFC 7946 的绕向（外环逆时针、内环顺时针）——`polygon-clipping`
 *      的输出绕向是随机的，而 d3-geo 是按球面多边形解释绕向的，绕反了会把
 *      「这个国家」变成「除了这个国家以外的整个世界」；
 *   5. 坐标四舍五入到 3 位小数（≈110m），和 110m 底图的精度相称，也顺便压体积。
 *
 * 输出
 * ------------------------------------------------------------------
 *   public/data/countries-110m.json
 *     一个 **GeoJSON FeatureCollection**（注意：不是 TopoJSON），features 顺序为
 *     [175 个已剔除 cn/tw 的世界国家…, 中国(156), 九段线(properties.kind='nine-dash')]。
 *     **中国和九段线放在最后 = 画在最上层。**
 *   这个文件是提交进仓库的，正常使用不需要联网重跑；只有要更新底图时才跑
 *   `npm run basemap`。下载缓存放在 .tmp-geo/（已 gitignore）。
 *
 * 踩过的坑（改这个脚本前先看）
 * ------------------------------------------------------------------
 * `topojson-client` 的 `feature()` 是从 topology 的 arcs **新造**出来的几何对象，
 * 改它并不会改动 topology 本身。所以「把改好的 feature 写回 TopoJSON 文件」是
 * 无效的 —— 必须写成 GeoJSON（本脚本的做法），或者拿拓扑重建一遍。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import { geoArea } from 'd3-geo';

const require = createRequire(import.meta.url);
const clipping = require('polygon-clipping');

const ROOT = process.cwd();
const ATLAS = path.join(ROOT, 'node_modules/world-atlas/countries-110m.json');
const OUT_DIR = path.join(ROOT, 'public/data');
const CACHE = path.join(ROOT, '.tmp-geo');

const SRC_CN_OUTLINE = 'https://geo.datav.aliyun.com/areas_v3/bound/100000.json';
const SRC_CN_FULL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';

const ID_CN = 156;
const ID_TW = 158;
const KIND_NINE_DASH = 'nine-dash';

/** 简化容差（度）。110m 底图本身就很粗，中国边界留到 ~3km 精度足够。 */
const SIMPLIFY_TOL = 0.03;
/** 重叠面积小于这个值（平方度）就当成概化误差，不去动邻国的几何。 */
const OVERLAP_MIN_AREA = 0.02;
/** 输出坐标保留几位小数。3 位 ≈ 110m，与 110m 底图的精度相称。 */
const DECIMALS = 3;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
async function fetchCached(name, url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`   ↓ 下载 ${url}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} 返回 HTTP ${r.status}`);
  const text = await r.text();
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

function bbox(geom) {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  const walk = (arr) => {
    if (typeof arr[0] === 'number') {
      if (arr[0] < a) a = arr[0];
      if (arr[0] > c) c = arr[0];
      if (arr[1] < b) b = arr[1];
      if (arr[1] > d) d = arr[1];
    } else arr.forEach(walk);
  };
  walk(geom.coordinates);
  return [a, b, c, d];
}

/** polygon-clipping 的输入输出都是 MultiPolygon 形状，与 GeoJSON 的 coordinates 同构 */
const toMultiPolygon = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates);

/** 平面近似面积，只用来判断「这块重叠值不值得处理」 */
function planarArea(mp) {
  let sum = 0;
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      }
    }
  }
  return Math.abs(sum / 2);
}

function countPoints(geom) {
  let n = 0;
  const walk = (arr) => {
    if (typeof arr[0] === 'number') n += 1;
    else arr.forEach(walk);
  };
  walk(geom.coordinates);
  return n;
}

/**
 * 逐环归一化绕向。
 *
 * d3-geo 把多边形当**球面**多边形解释，绕向决定了「哪边算内部」——绕反了，这个
 * 国家就变成「除了它以外的整个世界」（geoArea 会返回 4π 减真实面积）。
 *
 * 判断方式：拿 d3 自己算的单环面积，超过半个球面（2π）就是绕反了，翻过来即可。
 * **不能用平面叉积判断**：跨 ±180° 的环（俄罗斯）在平面上算出来的有向面积毫无意义。
 *
 * 口径是「外环的球面面积 = 那个国家本身，内环要反着绕」。实测原始 world-atlas 就是
 * 这个约定（抽查 Japan/Russia/India/China/Brazil/Australia/France 全部通过），注意
 * 它**和 RFC 7946 的「外环逆时针」相反**，照 RFC 改会把 Brazil、Russia 之类全部弄反。
 *
 * 必须**逐环**判断，不能整体翻转：俄罗斯有 22 个环，整体翻转后 geoArea 会变成 13.04
 * 而不是真实值 0.417。
 */
const ringArea = (ring) => geoArea({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } });

function orient(geom) {
  return {
    type: geom.type,
    coordinates: toMultiPolygon(geom).map((poly) => poly.map((ring, i) => {
      const inverted = ringArea(ring) > Math.PI * 2;
      const wantInverted = i !== 0; // 内环（洞）应当是「反的」
      return inverted === wantInverted ? ring : ring.slice().reverse();
    })),
  };
}

/** 先四舍五入再定绕向 —— 顺序不能反，绕向检查要跑在**最终写出去的那份坐标**上。 */
const finalize = (geom) => orient(round3(geom));

function mapCoords(geom, fn) {
  const walk = (arr) => (typeof arr[0] === 'number' ? fn(arr) : arr.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

const round3 = (geom) => mapCoords(geom, (p) => [Math.round(p[0] * 10 ** DECIMALS) / 10 ** DECIMALS, Math.round(p[1] * 10 ** DECIMALS) / 10 ** DECIMALS]);

/**
 * 经度平移，用来处理跨 ±180° 的几何（俄罗斯、斐济、阿拉斯加）。
 *
 * `polygon-clipping` 是纯平面算法：一个从 179° 走到 -179° 的环，在它眼里是横跨整个
 * 地球的一条长边。直接算 difference 会造出巨大的假多边形（实测俄罗斯面积从 1710 万
 * km² 虚增到 1959 万 km²）。做法是先把负经度 +360 搬到 0..360 坐标系里算，算完再搬回来。
 */
const shiftLng = (geom, to360) => mapCoords(geom, (p) => {
  let x = p[0];
  if (to360 && x < 0) x += 360;
  if (!to360 && x > 180) x -= 360;
  return [x, p[1]];
});

/** 包围盒横跨东西两端 = 这个图元跨了日期变更线 */
const crossesAntimeridian = (b) => b[0] < -170 && b[2] > 170;

/* ------------------------------------------------------------------ *
 * Douglas–Peucker 简化
 * ------------------------------------------------------------------ */
function douglasPeucker(pts, tol) {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const den = Math.sqrt(dx * dx + dy * dy);
    let best = -1;
    let bi = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      const dist = den < 1e-12
        ? Math.hypot(px - x1, py - y1)
        : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / den;
      if (dist > best) {
        best = dist;
        bi = i;
      }
    }
    if (best > tol && bi !== -1) {
      keep[bi] = 1;
      stack.push([s, bi], [bi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(ring, tol) {
  if (ring.length <= 6) return ring;
  const out = douglasPeucker(ring, tol);
  if (out.length < 4) return ring; // 别把环简化没了
  const [fx, fy] = out[0];
  const [lx, ly] = out[out.length - 1];
  if (fx !== lx || fy !== ly) out.push(out[0]);
  return out;
}

/** 只简化外环；内环（洞）样本很少，保留原样 */
function simplifyGeometry(geom, tol) {
  return {
    type: 'MultiPolygon',
    coordinates: toMultiPolygon(geom).map((poly) => poly.map((ring, i) => (i === 0 ? simplifyRing(ring, tol) : ring))),
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
console.log('构建底图（中国标准地图口径）');

if (!fs.existsSync(ATLAS)) {
  console.error(`✗ 找不到 ${ATLAS}，请先 npm install`);
  process.exit(1);
}

const atlas = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
const all = feature(atlas, atlas.objects.countries).features;
const dropped = all.filter((f) => +f.id === ID_CN || +f.id === ID_TW);
const world = all.filter((f) => +f.id !== ID_CN && +f.id !== ID_TW);
console.log(`   world-atlas: ${all.length} 个图元，剔除 ${dropped.map((f) => f.properties.name).join('、')}，剩 ${world.length}`);

const outline = await fetchCached('datav-100000.json', SRC_CN_OUTLINE);
const full = await fetchCached('datav-100000_full.json', SRC_CN_FULL);

const chinaSrc = outline.features[0];
const chinaGeom = simplifyGeometry(chinaSrc.geometry, SIMPLIFY_TOL);
console.log(`   中国疆域: ${countPoints(chinaSrc.geometry)} 点 → 简化后 ${countPoints(chinaGeom)} 点`);

const jdSrc = full.features.find((f) => String(f.properties?.adcode) === '100000_JD');
if (!jdSrc) throw new Error('DataV 数据里没找到九段线图元（adcode=100000_JD）');
console.log(`   九段线:   ${countPoints(jdSrc.geometry)} 点（不简化，细长图形会被打断）`);

// 从重叠的邻国身上把中国挖掉
const cnMP = toMultiPolygon(chinaGeom);
const cnBox = bbox(chinaGeom);
const carved = [];
for (const f of world) {
  if (!f.geometry) continue;
  const b = bbox(f.geometry);
  if (b[0] > cnBox[2] || b[2] < cnBox[0] || b[1] > cnBox[3] || b[3] < cnBox[1]) continue;
  // 跨日期变更线的图元先搬到 0..360 坐标系里再算，算完搬回来
  const cross = crossesAntimeridian(b);
  const mp = toMultiPolygon(cross ? shiftLng(f.geometry, true) : f.geometry);
  const other = cross ? toMultiPolygon(shiftLng(chinaGeom, true)) : cnMP;
  const inter = clipping.intersection(mp, other);
  if (!inter.length) continue;
  const area = planarArea(inter);
  if (area < OVERLAP_MIN_AREA) continue;
  let diff = clipping.difference(mp, other);
  if (!diff.length) continue;
  if (cross) diff = toMultiPolygon(shiftLng({ type: 'MultiPolygon', coordinates: diff }, false));
  f.geometry = finalize({ type: 'MultiPolygon', coordinates: diff });
  carved.push(`${f.properties.name} ${area.toFixed(2)}°²${cross ? '（跨日期变更线）' : ''}`);
}
console.log(`   布尔减:   ${carved.length ? carved.join('、') : '无'}`);

const features = [
  ...world,
  { type: 'Feature', id: ID_CN, properties: { name: 'China' }, geometry: finalize(chinaGeom) },
  { type: 'Feature', properties: { name: '南海诸岛', kind: KIND_NINE_DASH }, geometry: finalize(jdSrc.geometry) },
];

// 绕向自检：d3-geo 按球面解释，绕反了 geoArea 会变成「整个球面减去它」
const inverted = features.filter((f) => geoArea(f) > Math.PI * 2);
if (inverted.length) {
  console.error(`✗ ${inverted.length} 个图元绕向反了（geoArea 超过半个球面）：${inverted.slice(0, 5).map((f) => f.properties.name).join('、')}`);
  process.exit(1);
}
const km2 = (f) => `${Math.round(geoArea(f) * 6371 * 6371).toLocaleString('en-US')} km²`;
const pick = (n) => features.find((f) => f.properties?.name === n);
console.log(`   自检:     中国 ${km2(pick('China'))}（官方口径约 960 万）、俄罗斯 ${km2(pick('Russia'))}、印度 ${km2(pick('India'))}、九段线 ${km2(features.at(-1))}，绕向全部正常 ✅`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'countries-110m.json');
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`   ✓ ${path.relative(ROOT, out)}  ${features.length} 个图元 / ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
