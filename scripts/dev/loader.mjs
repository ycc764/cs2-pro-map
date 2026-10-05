/**
 * Node ESM 解析钩子：把浏览器 import map 里的裸模块名映射到 public/vendor/
 * 下的真实文件，这样就能在 Node 里跑前端代码（配合 register.mjs 使用）。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/$/, '');

const MAP = {
  three: process.env.CS2_STUB_THREE
    ? `${ROOT}/scripts/dev/three-stub.mjs`
    : `${ROOT}/public/vendor/three.module.js`,
  'd3-geo': `${ROOT}/public/vendor/d3-geo/index.js`,
  'd3-array': `${ROOT}/public/vendor/d3-array/index.js`,
  internmap: `${ROOT}/public/vendor/internmap/index.js`,
  'topojson-client': `${ROOT}/public/vendor/topojson-client/index.js`,
};

export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: pathToFileURL(MAP[specifier]).href, shortCircuit: true };
  return next(specifier, context);
}
