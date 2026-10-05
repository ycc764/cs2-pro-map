/**
 * 检查前端模块图是否自洽：相对 import 是否都存在、裸模块名是否都在
 * index.html 的 import map 里、vendor 入口是否齐备。
 *
 * 运行：npm run check:imports
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
console.log('import map:', JSON.stringify(imports));

const bare = new Map();
const missing = [];
const scanned = [];

function scan(f) {
  scanned.push(path.relative(ROOT, f));
  const code = fs.readFileSync(f, 'utf8');
  const re = /(?:^|\n)\s*(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const s = m[1];
    if (s.startsWith('.')) {
      if (!fs.existsSync(path.resolve(path.dirname(f), s))) missing.push(`${path.relative(ROOT, f)} -> ${s}`);
    } else {
      if (!bare.has(s)) bare.set(s, []);
      bare.get(s).push(path.relative(ROOT, f));
    }
  }
}

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) scan(p);
  }
}

walk(path.join(ROOT, 'src'));
walk(path.join(ROOT, 'public/vendor'));

console.log(`\n扫描了 ${scanned.length} 个 js 文件（src + vendor）`);
console.log('\n裸模块引用:');
for (const [k, v] of bare) {
  console.log('  ', k.padEnd(18), imports[k] ? '[已映射]' : '[!! 缺失 !!]', '<-', v.slice(0, 5).join(', '), v.length > 5 ? `(+${v.length - 5})` : '');
}

const missingVendor = Object.values(imports).filter(
  (u) => u.startsWith('/vendor/') && !fs.existsSync(path.join(ROOT, 'public', u)),
);
console.log('\n相对引用缺失:', missing.length ? missing : '无');
console.log('vendor 入口缺失:', missingVendor.length ? missingVendor : '无');

process.exit(missing.length || missingVendor.length || [...bare.keys()].some((k) => !imports[k]) ? 1 : 0);
