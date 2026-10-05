/**
 * 和 register.mjs 一样注册解析钩子，但额外把 three 换成测试替身
 * （scripts/dev/three-stub.mjs），这样 createGlobe3D 能在无 GPU 环境下跑完整。
 * 供 npm run check:3d 使用 —— 单独一个文件是为了避免跨平台的设置环境变量语法差异。
 */
import { register } from 'node:module';

process.env.CS2_STUB_THREE = '1';
register('./loader.mjs', import.meta.url);
