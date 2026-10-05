/**
 * 2D 世界地图（d3-geo）
 * ------------------------------------------------------------------
 * · 自然地球投影，按选手数量给国家上色
 * · 有选手的国家在中心画气泡 + 人数
 * · 事件委托到 svg（原来给 177 个 path 各挂 3 个监听器，改动/重绘都有开销）
 * · 自实现拖动平移 + 滚轮缩放 + 双击复位，选中地区时平滑飞过去
 */
import {
  geoNaturalEarth1, geoPath, geoGraticule10, geoCentroid, geoBounds,
} from 'd3-geo';
import { colorFor, radiusFor, flagEmoji } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls) => {
  const n = document.createElementNS(SVG_NS, tag);
  if (cls) n.setAttribute('class', cls);
  return n;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - (1 - t) ** 3;

// 在没有 rAF 的环境里（比如 Node 里的离线启动检查）退化成 setTimeout
const RAF = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(() => fn(performance.now()), 16);
const CAF = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;

export function createGlobe2D(container, { onSelect, onHover } = {}) {
  const svg = el('svg');
  const defs = el('defs');
  const gRoot = el('g', 'root');
  const gSphere = el('path', 'sphere');
  const gGraticule = el('path', 'graticule');
  const gLand = el('g', 'land');
  const gNineDash = el('g', 'nine-dash');
  const gBubble = el('g', 'bubbles');
  const gLabel = el('g', 'labels');

  // 海面渐变（用 DOM API 建，避免 innerHTML 在 SVG 命名空间下的解析差异）
  const grad = el('radialGradient');
  grad.setAttribute('id', 'ocean');
  grad.setAttribute('cx', '50%');
  grad.setAttribute('cy', '42%');
  grad.setAttribute('r', '72%');
  for (const [off, color] of [['0%', '#12304f'], ['62%', '#0c2036'], ['100%', '#081626']]) {
    const s = el('stop');
    s.setAttribute('offset', off);
    s.setAttribute('stop-color', color);
    grad.append(s);
  }
  defs.append(grad);

  // 九段线在陆地之上、气泡之下（它就是画在海面上的，压住陆地反而怪）
  gRoot.append(gSphere, gGraticule, gLand, gNineDash, gBubble, gLabel);
  svg.append(defs, gRoot);
  container.append(svg);

  const projection = geoNaturalEarth1();
  const path = geoPath(projection);

  const state = { selected: null, hovered: null, data: null, byNumeric: new Map(), geo: null };
  const size = [0, 0];
  const view = { k: 1, x: 0, y: 0 };
  let bubbles = [];   // { code, r, node, label }
  let anim = 0;

  /* ---------------- 变换 ---------------- */
  function applyTransform() {
    gRoot.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    // 气泡随缩放做部分反向补偿，标签完全反向补偿，保证屏幕上大小稳定
    const br = 1 / Math.sqrt(view.k);
    for (const b of bubbles) {
      b.node.setAttribute('r', (b.r * br).toFixed(2));
      if (b.label) {
        b.label.setAttribute('y', (b.ly - b.r * br - 3 / view.k).toFixed(2));
        b.label.setAttribute('font-size', (11 / view.k).toFixed(2));
      }
    }
  }

  function stopAnim() {
    if (anim) CAF(anim);
    anim = 0;
  }

  /** 平滑过渡到目标变换 */
  function animateTo(target, ms = 620) {
    stopAnim();
    const from = { ...view };
    const t0 = performance.now();
    const step = (now) => {
      const p = clamp((now - t0) / ms, 0, 1);
      const e = easeOut(p);
      view.k = from.k + (target.k - from.k) * e;
      view.x = from.x + (target.x - from.x) * e;
      view.y = from.y + (target.y - from.y) * e;
      applyTransform();
      if (p < 1) anim = RAF(step);
      else anim = 0;
    };
    anim = RAF(step);
  }

  /** 把某个 geo 要素框满视口 */
  function frameFeature(f, { pad = 70, maxK = 5.5 } = {}) {
    const b = path.bounds(f);
    const dx = b[1][0] - b[0][0];
    const dy = b[1][1] - b[0][1];
    if (!(dx > 0) || !(dy > 0)) return null;
    const k = clamp(Math.min(
      (size[0] - pad * 2) / dx,
      (size[1] - pad * 2) / dy,
    ), 1, maxK);
    const cx = (b[0][0] + b[1][0]) / 2;
    const cy = (b[0][1] + b[1][1]) / 2;
    return { k, x: size[0] / 2 - k * cx, y: size[1] / 2 - k * cy };
  }

  /* ---------------- 绘制 ---------------- */
  function resize() {
    const r = container.getBoundingClientRect();
    size[0] = Math.max(320, Math.round(r.width) || 320);
    size[1] = Math.max(240, Math.round(r.height) || 240);
    svg.setAttribute('viewBox', `0 0 ${size[0]} ${size[1]}`);
    svg.setAttribute('width', size[0]);
    svg.setAttribute('height', size[1]);
    projection.fitExtent([[16, 16], [size[0] - 16, size[1] - 16]], { type: 'Sphere' });
    draw();
  }

  function draw() {
    if (!state.geo) return;
    const max = state.data?.meta?.maxCountry ?? 1;

    gSphere.setAttribute('d', path({ type: 'Sphere' }) || '');
    gGraticule.setAttribute('d', path(geoGraticule10()) || '');

    const frag = document.createDocumentFragment();
    const ndfrag = document.createDocumentFragment();
    for (const f of state.geo.features) {
      // 九段线单独成层：它不是「有数据的国家」，不参与上色、气泡和选中
      if (f.properties?.kind === 'nine-dash') {
        const nd = path(f);
        if (nd) {
          const np = el('path', 'nine-dash-line');
          np.setAttribute('d', nd);
          ndfrag.append(np);
        }
        continue;
      }
      const d = path(f);
      if (!d) continue;
      const p = el('path', 'country');
      p.setAttribute('d', d);
      const rec = state.byNumeric.get(String(f.id));
      p.dataset.code = rec?.code ?? '';
      if (rec) {
        // 上色统一走 CSS 变量，让 :hover / .selected 可以在样式表里覆盖
        p.setAttribute('fill', colorFor(rec.count, max));
        p.classList.add('has-data');
      }
      frag.append(p);
    }
    gLand.replaceChildren(frag);
    gNineDash.replaceChildren(ndfrag);

    const points = Object.values(state.data.countries).filter((c) => c.count > 0 && c.center);
    const labelSet = new Set(
      points.slice().sort((a, b) => b.count - a.count).slice(0, 12).map((c) => c.code),
    );

    bubbles = [];
    const bfrag = document.createDocumentFragment();
    const lfrag = document.createDocumentFragment();
    for (const c of points) {
      const xy = projection(c.center);
      if (!xy) continue;
      const r = radiusFor(c.count, max, 2.5, 15);
      const circle = el('circle', 'bubble');
      circle.setAttribute('cx', xy[0].toFixed(2));
      circle.setAttribute('cy', xy[1].toFixed(2));
      circle.setAttribute('r', r);
      circle.setAttribute('fill', colorFor(c.count, max));
      circle.dataset.code = c.code;
      bfrag.append(circle);

      let label = null;
      if (labelSet.has(c.code)) {
        label = el('text', 'bubble-label');
        label.setAttribute('x', xy[0].toFixed(2));
        label.setAttribute('y', (xy[1] - r - 4).toFixed(2));
        label.setAttribute('text-anchor', 'middle');
        label.textContent = `${flagEmoji(c.code)} ${c.count}`;
        lfrag.append(label);
      }
      bubbles.push({ code: c.code, r, node: circle, label, ly: xy[1] });
    }
    gBubble.replaceChildren(bfrag);
    gLabel.replaceChildren(lfrag);

    applyTransform();
    applySelection();
  }

  function applySelection() {
    for (const p of gLand.children) {
      p.classList.toggle('selected', !!state.selected && p.dataset.code === state.selected);
    }
    for (const b of bubbles) {
      b.node.classList.toggle('selected', !!state.selected && b.code === state.selected);
    }
  }

  function setHovered(code) {
    if (state.hovered === code) return;
    state.hovered = code;
    for (const p of gLand.children) {
      p.classList.toggle('hover', !!code && p.dataset.code === code);
    }
  }

  /* ---------------- 交互 ---------------- */
  let dragging = false;
  let lx = 0;
  let ly = 0;
  let moved = 0;

  function localPoint(e) {
    const r = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = 0;
    lx = e.clientX;
    ly = e.clientY;
    stopAnim();
    svg.setPointerCapture?.(e.pointerId);
    svg.classList.add('grabbing');
  });

  svg.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (view.k > 1) {
        view.x += dx;
        view.y += dy;
        applyTransform();
      }
      return;
    }
    // 事件委托：命中哪个国家 / 气泡
    const t = e.target;
    const node = t?.dataset?.code !== undefined && (t.tagName === 'path' || t.tagName === 'circle') ? t : null;
    const code = node?.dataset.code || '';
    setHovered(code || null);
    if (code) {
      const c = state.data.countries[code];
      onHover?.(c ? { code, x: e.clientX, y: e.clientY } : null);
      svg.style.cursor = 'pointer';
    } else {
      onHover?.(null);
      svg.style.cursor = view.k > 1 ? 'grab' : 'default';
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    svg.classList.remove('grabbing');
    svg.releasePointerCapture?.(e.pointerId);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { setHovered(null); onHover?.(null); });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = localPoint(e);
    const k2 = clamp(view.k * Math.exp(-e.deltaY * 0.0016), 1, 10);
    if (k2 === view.k) return;
    // 让光标下的地理点保持不动
    view.x = px - (k2 / view.k) * (px - view.x);
    view.y = py - (k2 / view.k) * (py - view.y);
    view.k = k2;
    if (view.k === 1) { view.x = 0; view.y = 0; }
    applyTransform();
  }, { passive: false });

  svg.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (view.k > 1) animateTo({ k: 1, x: 0, y: 0 }, 420);
    else {
      const [px, py] = localPoint(e);
      const k = 2.6;
      animateTo({ k, x: px - k * px, y: py - k * py }, 420);
    }
  });

  svg.addEventListener('click', (e) => {
    if (moved > 6) { moved = 0; return; }
    const t = e.target;
    const code = t?.dataset?.code || '';
    onSelect?.(code || null);
  });

  /* ---------------- 对外接口 ---------------- */
  const featureOf = (code) =>
    state.geo?.features.find((f) => state.byNumeric.get(String(f.id))?.code === code);

  return {
    kind: '2d',
    show() {},
    hide() {},
    resize,
    setData(data, geo) {
      state.data = data;
      state.geo = geo;
      state.byNumeric = new Map();
      for (const c of Object.values(data.countries)) {
        if (c.numeric) state.byNumeric.set(String(c.numeric), c);
      }
      view.k = 1;
      view.x = 0;
      view.y = 0;
      resize();
    },
    select(code) {
      state.selected = code;
      applySelection();
      if (!code) return;
      const c = state.data?.countries?.[code];
      if (!c?.center) return;
      const f = featureOf(code);
      const target = f ? frameFeature(f) : null;
      if (target) {
        animateTo(target);
      } else {
        // 没有国土（例如科索沃）就只把气泡拉到中间
        const xy = projection(c.center);
        if (!xy) return;
        const k = 2.4;
        animateTo({ k, x: size[0] / 2 - k * xy[0], y: size[1] / 2 - k * xy[1] });
      }
    },
    reset() {
      state.selected = null;
      applySelection();
      animateTo({ k: 1, x: 0, y: 0 }, 420);
    },
    centroidOf: (code) => {
      const f = featureOf(code);
      return f ? geoCentroid(f) : null;
    },
    boundsOf: (code) => {
      const f = featureOf(code);
      return f ? geoBounds(f) : null;
    },
    featureOf,
    hasCountry: (code) => !!state.data?.countries?.[code],
  };
}
