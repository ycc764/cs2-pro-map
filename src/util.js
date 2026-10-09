/** 小工具集：国旗 emoji、颜色刻度、经纬度 → 球面坐标 */

const REGIONAL_INDICATOR = 0x1f1e6;

/** 两字母国家码 → 国旗 emoji（不依赖任何数据表） */
export function flagEmoji(code) {
  if (!code || code.length !== 2 || !/^[a-z]{2}$/i.test(code)) return '🏳️';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => REGIONAL_INDICATOR + c.charCodeAt(0) - 65),
  );
}

/* ------------------------------------------------------------------ *
 * 顺序色标：人数越多 → 颜色越浓
 *
 * 两个刻意的决定：
 *
 * 1) **连续插值，不切档**。原来是 5 档硬切（`floor(t * 5)`），相邻两个
 *    国家差 1 个人就可能换色、差 20 个人反而同色。改成在色标上连续取色后，
 *    "深浅"可以直接读出多少，图例也能画成一条真正的渐变条。
 *
 * 2) **深色主题下，"越深"只能做成"越浓"**。字面上"人数多 → 颜色更深"在
 *    这张图上是行不通的：海面本身就是深蓝（2D 的 #ocean 渐变是
 *    #12304f → #0c2036 → #081626），国家一暗就沉进背景里，
 *    反而比人少的国家更看不见。所以这条色标抬的是**饱和度 + 亮度**：
 *    1 人是一层几乎透明的暗蓝（弱），83 人是饱和的金黄（重）。
 *    视觉重量单调递增，"多 = 重"这个读数是一致的。
 *
 * 色标首档也从原来的 #1d2b53 提亮了 —— 那一档跟海面几乎同色，
 * 而 48 个地区里大量是 1–2 人，等于最该被看见的一批全糊在背景里。
 * ------------------------------------------------------------------ */
const RAMP = [
  '#20395a', // 最少：暗蓝，看得见但不抢眼
  '#28618f', // 钢蓝
  '#2c93a3', // 青
  '#4fc08d', // 绿
  '#a6d96a', // 黄绿
  '#ffc94d', // 最多：饱和金黄，视觉重量最大
];

export const RAMP_COLORS = RAMP;

const RAMP_RGB = RAMP.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

/**
 * 人数 → 色标位置 0..1。
 *
 * 用 sqrt 而不是 log1p：选手数分布是长尾（83 / 43 / 31 / … / 1），
 * log 会把头部压扁 —— 43 人和 83 人几乎同色，而"俄罗斯比巴西多一倍"
 * 恰恰是这张图最该说清的一件事。sqrt 和"面积 ∝ 人数"是同一个尺度，
 * 圆的大小和颜色深浅说的是同一件事，不会互相打架。
 */
export function countT(count, max) {
  return Math.min(1, Math.sqrt(count / Math.max(max, 1)));
}

/** 在色标上取色，t ∈ [0,1] */
export function rampAt(t) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP_RGB.length - 1);
  const i = Math.min(RAMP_RGB.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP_RGB[i];
  const b = RAMP_RGB[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},`
    + `${Math.round(a[1] + (b[1] - a[1]) * f)},`
    + `${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** count 是整数且高度重复，缓存一下省掉每帧几十次字符串拼接 */
const colorCache = new Map();

export function colorFor(count, max) {
  if (!count) return 'rgba(120,150,200,0.10)';
  const key = `${count}/${max}`;
  let c = colorCache.get(key);
  if (!c) {
    c = rampAt(countT(count, max));
    colorCache.set(key, c);
  }
  return c;
}

/** 气泡半径：按 sqrt 缩放，视觉面积正比于人数 */
export function radiusFor(count, max, base = 3, scale = 16) {
  return base + scale * Math.sqrt(count / Math.max(max, 1));
}

const D2R = Math.PI / 180;

/** 经纬度 → 三维单位球坐标（y 轴朝北，与 geoOrthographic 一致） */
export function lngLatToXYZ([lng, lat], r = 1) {
  const phi = (90 - lat) * D2R;
  const theta = (lng + 180) * D2R;
  return [
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  ];
}

/** 三维球面点 → 经纬度（用于射线拾取） */
export function xyzToLngLat([x, y, z], r = 1) {
  const phi = Math.acos(Math.max(-1, Math.min(1, y / r)));
  const theta = Math.atan2(z, -x);
  return [((theta * 180) / Math.PI - 180 + 540) % 360 - 180, 90 - (phi * 180) / Math.PI];
}

export const debounce = (fn, ms = 140) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

/**
 * 建元素。第 3 个参数起都是子节点：节点直接 append，其余按文本处理。
 *
 * 之所以做成可变参数：早先只认一个 textContent，写
 * el('span', null, circle, el('b', null, '83')) 时第二个节点会被
 * String() 成 "[object HTMLElement]" 直接渲染到页面上。
 */
export function el(tag, cls, ...children) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const c of children) {
    if (c == null || c === false) continue;
    n.append(c && typeof c === 'object' && 'nodeType' in c ? c : String(c));
  }
  return n;
}
