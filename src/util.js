/** 小工具集：国旗 emoji、颜色刻度、经纬度 → 球面坐标 */

const REGIONAL_INDICATOR = 0x1f1e6;

/** 两字母国家码 → 国旗 emoji（不依赖任何数据表） */
export function flagEmoji(code) {
  if (!code || code.length !== 2 || !/^[a-z]{2}$/i.test(code)) return '🏳️';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => REGIONAL_INDICATOR + c.charCodeAt(0) - 65),
  );
}

/** 蓝 → 青 → 黄 的顺序色标（用于选手数量分级） */
const RAMP = ['#1d2b53', '#2f6f9f', '#3fa7a0', '#8fd07a', '#ffd166'];

export function colorFor(count, max) {
  if (!count) return 'rgba(120,150,200,0.10)';
  const t = Math.min(1, Math.log1p(count) / Math.log1p(Math.max(max, 2)));
  const i = Math.min(RAMP.length - 1, Math.floor(t * RAMP.length));
  return RAMP[i];
}

export const RAMP_COLORS = RAMP;

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

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
