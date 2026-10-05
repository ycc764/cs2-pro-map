/**
 * 3D 地球（three.js）
 * ------------------------------------------------------------------
 * · 用 d3 等距圆柱投影把世界地图画到 canvas，直接当球体贴图（不需要外部图片）
 * · 有选手的国家在球面上放一个 Sprite 气泡，半径 ∝ √人数
 * · 自实现拖动旋转 / 惯性 / 滚轮缩放（不依赖 OrbitControls）
 * · 拾取全部走解析解：气泡用「射线到球心的距离」，球面用「射线与单位球求交」，
 *   不做三角面 raycast（原来对 96×64 的球体求交是卡顿主因）
 * · 按需渲染：只在旋转 / 惯性 / 动画时才跑 rAF，静止时不占 CPU
 */
import * as THREE from 'three';
import { geoEquirectangular, geoPath, geoGraticule10, geoContains } from 'd3-geo';
import { colorFor, radiusFor, lngLatToXYZ, xyzToLngLat } from './util.js';

const TEX_W = 2048;
const TEX_H = 1024;
const AUTO_ROTATE_DELAY = 4500; // 空闲多久后开始自转（ms）
const AUTO_ROTATE_SPEED = 0.055; // 自转角速度（弧度/秒）

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 简易 canvas 2D 上下文（拿不到就返回 null，方便在没有 canvas 的环境里降级） */
function ctx2d(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') };
}

/** 把世界地图画成 2:1 的等距圆柱纹理 */
function makeWorldTexture(geo, byNumeric, max) {
  const { canvas, ctx } = ctx2d(TEX_W, TEX_H);
  if (!ctx) return null;

  // 海洋
  const ocean = ctx.createLinearGradient(0, 0, 0, TEX_H);
  ocean.addColorStop(0, '#081020');
  ocean.addColorStop(0.45, '#0d2038');
  ocean.addColorStop(0.55, '#0d2038');
  ocean.addColorStop(1, '#081020');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  const projection = geoEquirectangular()
    .scale(TEX_W / (2 * Math.PI))
    .translate([TEX_W / 2, TEX_H / 2]);
  const path = geoPath(projection, ctx);

  // 经纬网
  ctx.beginPath();
  path(geoGraticule10());
  ctx.strokeStyle = 'rgba(120,170,220,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 陆地：先铺一层暗底，再按人数上色
  ctx.lineJoin = 'round';
  const nineDash = [];
  for (const f of geo.features) {
    // 九段线留到最后单独画（它压在陆地之上，而且不能被当成国家上色）
    if (f.properties?.kind === 'nine-dash') {
      nineDash.push(f);
      continue;
    }
    const rec = byNumeric.get(String(f.id));
    ctx.beginPath();
    path(f);
    if (rec) {
      ctx.fillStyle = colorFor(rec.count, max);
      ctx.fill();
      // 有数据的国家加一点内发光，方便在球面上认出来
      ctx.save();
      ctx.shadowColor = colorFor(rec.count, max);
      ctx.shadowBlur = 18;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(104,136,186,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,190,240,0.16)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  // 南海诸岛九段线：填充 + 描边都上，否则细长的多边形在 2048 宽的贴图上太淡
  for (const f of nineDash) {
    ctx.beginPath();
    path(f);
    ctx.fillStyle = 'rgba(210,224,244,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(210,224,244,0.92)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 圆形气泡纹理：中心提亮、边缘柔和 */
function makeBubbleTexture(color) {
  const S = 128;
  const { canvas, ctx } = ctx2d(S, S);
  if (!ctx) return null;
  const g = ctx.createRadialGradient(S * 0.36, S * 0.32, S * 0.04, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.42, color);
  g.addColorStop(0.86, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 大气光晕纹理（径向渐变） */
function makeHaloTexture() {
  const S = 256;
  const { canvas, ctx } = ctx2d(S, S);
  if (!ctx) return null;
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.36, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(90,190,215,0.42)');
  g.addColorStop(0.55, 'rgba(63,167,160,0.20)');
  g.addColorStop(1, 'rgba(63,167,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGlobe3D(container, { onSelect, onHover } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  container.append(renderer.domElement);
  const dom = renderer.domElement;
  dom.style.touchAction = 'none';

  /* ---------------- 场景 ---------------- */
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(3, 2, 4);
  scene.add(key);

  // 星空（不跟着地球转，做视差）
  const STAR_N = 1300;
  const starPos = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i += 1) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = 9 + Math.random() * 16;
    const s = Math.sqrt(1 - u * u);
    starPos[i * 3] = r * s * Math.cos(th);
    starPos[i * 3 + 1] = r * u;
    starPos[i * 3 + 2] = r * s * Math.sin(th);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({ color: 0xa8c8ff, size: 0.075, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  scene.add(stars);

  const root = new THREE.Group();
  scene.add(root);

  // 大气光晕
  const haloTex = makeHaloTexture();
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(1.18, 48, 32),
    haloTex
      ? new THREE.MeshBasicMaterial({
        map: haloTex, transparent: true, blending: THREE.AdditiveBlending,
        side: THREE.BackSide, depthWrite: false,
      })
      : new THREE.MeshBasicMaterial({ color: 0x3fa7a0, transparent: true, opacity: 0.14, side: THREE.BackSide }),
  );
  glow.renderOrder = -1;
  root.add(glow);

  const globeMat = new THREE.MeshPhongMaterial({ color: 0x0e2136, shininess: 8, specular: 0x223344 });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 48), globeMat);
  root.add(globe);

  const bubbleGroup = new THREE.Group();
  root.add(bubbleGroup);

  /* ---------------- 状态 ---------------- */
  let data = null;
  let geo = null;
  let byNumeric = new Map();
  let bubbles = [];
  let selected = null;
  let max = 1;

  const state = { rotX: 0, rotY: 0, dist: 3.15, dragging: false, moved: false, lx: 0, ly: 0 };
  let velY = 0;
  let velX = 0;
  let lastT = 0;
  let idleSince = performance.now();
  let rafId = 0;
  let dirty = true;
  let introFrom = 0;
  let introT0 = 0;
  let bubbleAnimating = false;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const tmpVec = new THREE.Vector3();

  function applyCamera() {
    camera.position.set(0, 0, state.dist);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }

  /* ---------------- 渲染循环 ---------------- */
  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function tick(now) {
    rafId = 0;
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    let moved = false;

    // 入场动画
    if (introT0) {
      const k = Math.min(1, (now - introT0) / 1000);
      const e = 1 - (1 - k) ** 3;
      state.dist = introFrom + (3.15 - introFrom) * e;
      applyCamera();
      moved = true;
      if (k >= 1) introT0 = 0;
    }

    if (!state.dragging) {
      // 惯性
      if (Math.abs(velY) > 1e-4 || Math.abs(velX) > 1e-4) {
        state.rotY += velY * dt;
        state.rotX = clamp(state.rotX + velX * dt, -1.25, 1.25);
        const damp = 0.9 ** (dt * 60);
        velY *= damp;
        velX *= damp;
        moved = true;
      } else {
        velY = 0;
        velX = 0;
        // 空闲自转
        if (!selected && !document.hidden && now - idleSince > AUTO_ROTATE_DELAY) {
          state.rotY += AUTO_ROTATE_SPEED * dt;
          moved = true;
        }
      }
    }

    if (moved) {
      root.rotation.x = state.rotX;
      root.rotation.y = state.rotY;
      stars.rotation.y += dt * 0.006;
      dirty = true;
    }
    if (updateBubbleScale(dt)) dirty = true;
    if (dirty) {
      renderer.render(scene, camera);
      dirty = false;
    }
    if (moved || state.dragging || bubbleAnimating) schedule();
  }

  function resize() {
    const r = container.getBoundingClientRect();
    const w = Math.max(320, Math.round(r.width) || 320);
    const h = Math.max(240, Math.round(r.height) || 240);
    renderer.setSize(w, h, false);
    dom.style.width = `${w}px`;
    dom.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyCamera();
    dirty = true;
    schedule();
  }

  /* ---------------- 气泡 ---------------- */
  function buildBubbles() {
    for (const b of bubbles) {
      bubbleGroup.remove(b.sprite);
      b.sprite.material.map?.dispose();
      b.sprite.material.dispose();
    }
    bubbles = [];

    for (const c of Object.values(data.countries)) {
      if (!c.count || !c.center) continue;
      const radius = radiusFor(c.count, max, 0.014, 0.062);
      const tex = makeBubbleTexture(colorFor(c.count, max));
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: true, depthWrite: false, opacity: 0.95,
      });
      const sprite = new THREE.Sprite(mat);
      const p = lngLatToXYZ(c.center, 1.012);
      sprite.position.set(p[0], p[1], p[2]);
      sprite.scale.setScalar(radius);
      sprite.renderOrder = 5;
      bubbleGroup.add(sprite);
      bubbles.push({ sprite, code: c.code, base: radius, target: radius });
    }
    root.updateMatrixWorld(true);
    applyHighlight();
  }

  function applyHighlight() {
    for (const b of bubbles) {
      const on = !!selected && b.code === selected;
      b.target = on ? b.base * 1.7 : (selected ? b.base * 0.72 : b.base);
      b.sprite.material.opacity = selected && !on ? 0.4 : 0.95;
    }
  }

  /** 气泡半径平滑过渡；返回是否仍在动画中 */
  function updateBubbleScale(dt) {
    let animating = false;
    for (const b of bubbles) {
      const cur = b.sprite.scale.x;
      if (Math.abs(cur - b.target) < 1e-3) {
        if (cur !== b.target) b.sprite.scale.setScalar(b.target);
        continue;
      }
      b.sprite.scale.setScalar(cur + (b.target - cur) * Math.min(1, dt * 12));
      animating = true;
    }
    bubbleAnimating = animating;
    return animating;
  }

  /* ---------------- 拾取（解析解） ---------------- */
  function updatePointer(e) {
    const r = dom.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return true;
  }

  /** 只认朝镜头这一面的气泡；气泡是 Sprite，命中区用「射线到球心的距离」判定 */
  function pickBubble() {
    const cam = camera.position;
    const ray = raycaster.ray;
    let best = null;
    root.updateMatrixWorld(true);
    for (const b of bubbles) {
      b.sprite.getWorldPosition(tmpVec);
      // 可见判据：球心在 (0,0,0)、半径 1 时，P 可见 ⟺ P·C > 1
      if (tmpVec.dot(cam) <= 1) continue;
      const r = (b.sprite.scale.x / 2) * 1.25;
      if (ray.distanceToPoint(tmpVec) > r) continue;
      const t = tmpVec.distanceTo(cam);
      if (!best || t < best.t) best = { code: b.code, t };
    }
    return best;
  }

  /** 射线与单位球求交，返回最近交点（没有就是 null） */
  function pickSphere() {
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const b = o.dot(d);
    const c = o.dot(o) - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    return o.clone().addScaledVector(d, t);
  }

  /* ---------------- 交互 ---------------- */
  dom.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    state.moved = false;
    state.lx = e.clientX;
    state.ly = e.clientY;
    velY = 0;
    velX = 0;
    dom.setPointerCapture?.(e.pointerId);
    dom.style.cursor = 'grabbing';
    schedule();
  });

  dom.addEventListener('pointermove', (e) => {
    idleSince = performance.now();
    if (state.dragging) {
      const dx = e.clientX - state.lx;
      const dy = e.clientY - state.ly;
      if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
      state.lx = e.clientX;
      state.ly = e.clientY;
      // 记录速度用于松手后的惯性
      velY = dx * 0.006 * 60;
      velX = -dy * 0.006 * 60;
      state.rotY += dx * 0.006;
      state.rotX = clamp(state.rotX - dy * 0.006, -1.25, 1.25);
      root.rotation.x = state.rotX;
      root.rotation.y = state.rotY;
      dirty = true;
      schedule();
      return;
    }
    if (!updatePointer(e)) return;
    const hit = pickBubble();
    const next = hit ? 'pointer' : 'grab';
    if (dom.style.cursor !== next) dom.style.cursor = next;
    onHover?.(hit ? { code: hit.code, x: e.clientX, y: e.clientY } : null);
  });

  const endDrag = () => {
    if (!state.dragging) return;
    state.dragging = false;
    dom.style.cursor = 'grab';
    idleSince = performance.now();
    schedule();
  };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointercancel', endDrag);
  dom.addEventListener('pointerleave', () => onHover?.(null));

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.dist = clamp(state.dist + e.deltaY * 0.0016, 1.55, 6.5);
    applyCamera();
    idleSince = performance.now();
    dirty = true;
    schedule();
  }, { passive: false });

  dom.addEventListener('click', (e) => {
    if (state.moved) return;
    if (!updatePointer(e)) return;

    const hitBubble = pickBubble();
    if (hitBubble) {
      onSelect?.(hitBubble.code);
      return;
    }
    const p = pickSphere();
    if (!p) {
      onSelect?.(null);
      return;
    }
    const local = globe.worldToLocal(p.clone());
    const [lng, lat] = xyzToLngLat([local.x, local.y, local.z], 1);
    // 九段线只是海面上的界线，不是国家，不参与拾取（否则点到它会清掉选中项）
    const f = geo?.features?.find((ft) => ft.properties?.kind !== 'nine-dash' && geoContains(ft, [lng, lat]));
    const rec = f ? byNumeric.get(String(f.id)) : null;
    onSelect?.(rec ? rec.code : null);
  });

  /* ---------------- 对外接口 ---------------- */
  return {
    kind: '3d',
    show() {
      resize();
      // 首次显示时播一次入场动画
      if (!state._shown) {
        state._shown = true;
        introFrom = 6.4;
        introT0 = performance.now();
        state.dist = introFrom;
        applyCamera();
        schedule();
      }
    },
    hide() {},
    resize,
    setData(dataset, geoData) {
      data = dataset;
      geo = geoData;
      max = dataset.meta?.maxCountry ?? 1;
      byNumeric = new Map();
      for (const c of Object.values(dataset.countries)) {
        if (c.numeric) byNumeric.set(String(c.numeric), c);
      }
      const tex = makeWorldTexture(geo, byNumeric, max);
      if (tex) {
        globeMat.map?.dispose();
        globeMat.map = tex;
        globeMat.color = new THREE.Color(0xffffff);
        globeMat.needsUpdate = true;
      }
      buildBubbles();
      resize();
    },
    select(code) {
      selected = code;
      applyHighlight();
      introT0 = 0;
      if (!code) {
        dirty = true;
        schedule();
        return;
      }
      const c = data?.countries?.[code];
      if (!c?.center) return;
      // 把目标点转到正对镜头。
      // 球面参数与 SphereGeometry 的 uv 完全对齐（见 util.lngLatToXYZ 的推导），
      // 因此 root.rotation（Euler 默认 XYZ = Rx·Ry）取：
      //   rotY = -lng·π/180 - π/2 ,  rotX = lat·π/180
      const [lng, lat] = c.center;
      state.rotY = (-lng * Math.PI) / 180 - Math.PI / 2;
      state.rotX = (lat * Math.PI) / 180;
      state.dist = Math.min(state.dist, 2.5);
      // 必须清掉拖拽残余惯性，否则 tick() 会继续把 rotY/rotX 叠加下去，
      // 把刚转到位的地球又甩走（表现为"点选了国家但镜头飘到别处"）。
      velX = 0;
      velY = 0;
      root.rotation.set(state.rotX, state.rotY, 0);
      applyCamera();
      idleSince = performance.now();
      dirty = true;
      schedule();
    },
    reset() {
      selected = null;
      applyHighlight();
      introT0 = 0;
      state.rotX = 0;
      state.rotY = 0;
      state.dist = 3.15;
      velX = 0;
      velY = 0;
      root.rotation.set(0, 0, 0);
      applyCamera();
      dirty = true;
      schedule();
    },
    hasCountry: (code) => !!data?.countries?.[code],
  };
}
