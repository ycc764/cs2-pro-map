/**
 * 测试替身：把 three 的 WebGLRenderer 换成一个不做渲染的空壳，
 * 这样在没有 GPU / 没有浏览器的环境里也能把 createGlobe3D 的**全部构建代码**
 * 真跑一遍（世界贴图、气泡 Sprite、星空、几何体、事件绑定都真执行），
 * 只有最后的 draw call 是假的。
 *
 * 由 scripts/dev/loader.mjs 在 CS2_STUB_THREE=1 时启用。
 * 显式导出的 WebGLRenderer 会覆盖 `export *` 带来的同名导出（ES 规范如此）。
 */
export * from '../../public/vendor/three.module.js';

const stub = { renders: 0, sizes: [], instances: 0 };
globalThis.__THREE_STUB__ = stub;

export class WebGLRenderer {
  constructor(params = {}) {
    stub.instances += 1;
    this.params = params;
    this.calls = 0;
    this.domElement = document.createElement('canvas');
    this.domElement.width = 300;
    this.domElement.height = 150;
    if (!this.domElement.style) this.domElement.style = {};
    this.domElement.style.touchAction = '';
    this.shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    this.capabilities = { isWebGL2: true, getMaxAnisotropy: () => 4 };
    this.outputColorSpace = '';
  }

  setPixelRatio(v) { this.pixelRatio = v; }
  setClearColor(c, a) { this.clearColor = c; this.clearAlpha = a; }
  setSize(w, h) {
    stub.sizes.push([w, h]);
    this.domElement.width = w;
    this.domElement.height = h;
  }
  setViewport() {}
  setScissorTest() {}
  getContext() { return null; }
  getPixelRatio() { return this.pixelRatio ?? 1; }
  clear() {}
  render(scene, camera) {
    stub.renders += 1;
    stub.lastScene = scene;      // 供检查脚本遍历场景，验证气泡/星空真的建出来了
    stub.lastCamera = camera;
    // 真 three 的 render() 会先刷新世界矩阵，这里也要照做，否则 worldToLocal 拿到的是旧矩阵
    scene?.updateMatrixWorld?.(true);
    camera?.updateMatrixWorld?.(true);
    this.calls += 1;
  }
  dispose() {}
  forceContextLoss() {}
}
