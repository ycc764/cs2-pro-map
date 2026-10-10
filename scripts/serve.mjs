/**
 * 零依赖静态服务器（替代 vite dev）
 * ------------------------------------------------------------------
 * 为什么不用 vite dev：本机沙箱禁止管道 stdio 起子进程，vite 内部
 *   exec('net use') 会抛 spawn EPERM。这个服务器只用 node:http。
 *
 * 解析规则（模仿 vite）：先找 public/，再回退到项目根。
 *   /src/main.js        → <root>/src/main.js
 *   /vendor/three.module.js → <root>/public/vendor/three.module.js
 *   /data/dataset.json  → <root>/public/data/dataset.json
 *
 * 用法：node scripts/serve.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 端口取第一个非选项参数；注意不能直接用 argv[2]，否则 `--no-open` 会被当成 NaN
const ARGS = process.argv.slice(2);
const PORT_ARG = ARGS.find((a) => !a.startsWith('-'));
const PORT = Number(PORT_ARG || process.env.PORT || 5173);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`端口不合法：${PORT_ARG}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  // ⚠ 顺序是 public/ 优先，**不能反过来**。
  //
  // public/ 才是这个站的根（vendor、data、avatars 都在里面），根目录只是额外
  // 提供 src/*.js、*.html 这些源文件。反过来的话，/data/ratings.json 会先命中
  // 根目录下那份**抓取原始产物**（形状完全不同：是 {ranges:{...}}），页面拿到
  // 一个结构不对的 JSON，报"没有任何选手记录"而不是 404 —— 这个坑真踩过。
  for (const base of [path.join(ROOT, 'public'), ROOT]) {
    const full = path.resolve(base, rel);
    // 目录穿越保护
    if (!full.startsWith(base)) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile()) return full;
      if (st.isDirectory()) {
        const idx = path.join(full, 'index.html');
        if (fs.existsSync(idx)) return idx;
      }
    } catch { /* 继续找下一处 */ }
  }
  return null;
}

function handler(req, res) {
  const file = resolve(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + req.url);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ *
 * 端口占用就自动往后找一个，避免"上次的窗口没关"导致启动失败
 * ------------------------------------------------------------------ */
const WANT_OPEN = !process.argv.includes('--no-open');
const MAX_TRIES = 10;

/**
 * 打开浏览器。
 *
 * 为什么不能只靠 `cmd /c start "" <url>`：
 *   `start` 打开 URL 走的是 Windows 的协议关联（注册表里的 MSEdgeHTM / ChromeHTML）。
 *   这条链一旦出问题（关联损坏、被安全软件拦、浏览器没注册好），`start` 会**静默失败** ——
 *   不报错、不返回非零、也不弹窗口。用户看到的就是「双击了启动.bat，但没反应」。
 *   直接启动浏览器可执行文件不依赖任何关联，是最确定的一条路，所以放在最前面。
 *
 * 只有 spawn 本身失败（异步的 error 事件，比如 ENOENT）才换下一种，
 * 否则会同时弹出好几个窗口。
 */
function openBrowser(url) {
  const attempts = [];
  if (process.platform === 'win32') {
    try {
      const exe = findBrowser();          // Chrome 优先，其次 Edge
      attempts.push([exe, ['--no-first-run', '--no-default-browser-check', url]]);
    } catch { /* 一个都没找到，靠下面的兜底 */ }
    attempts.push(['cmd.exe', ['/c', 'start', '', url]]);          // 尊重系统默认浏览器
    attempts.push(['explorer.exe', [url]]);
    attempts.push(['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  } else if (process.platform === 'darwin') {
    attempts.push(['open', [url]]);
  } else {
    attempts.push(['xdg-open', [url]], ['sensible-browser', [url]], ['x-www-browser', [url]]);
  }

  const tryAt = (i) => {
    if (i >= attempts.length) return;
    const [file, args] = attempts[i];
    let child;
    try {
      // 必须 stdio:'ignore'：本环境禁止用管道 stdio 拉起子进程
      child = spawn(file, args, { stdio: 'ignore', detached: true, windowsHide: true });
    } catch {
      tryAt(i + 1);
      return;
    }
    // spawn 的失败是「异步」的（ENOENT 等走 error 事件），不监听就会变成未捕获异常
    child.on('error', () => tryAt(i + 1));
    child.unref();
  };
  tryAt(0);
}

/**
 * 关键点：每次尝试都新建一个 server。
 * Node 的 listen() 会把回调挂成 once('listening')，端口占用时这个监听器**不会被移除**，
 * 复用同一个 server 重试就会在真正成功那一次把两个回调都触发，打印出错误的地址。
 */
function listen(port, triesLeft) {
  const server = http.createServer(handler);
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`  ⚠ 端口 ${port} 已被占用（可能是上次没关掉的服务器），改用 ${port + 1}。`);
      listen(port + 1, triesLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 及之后 ${MAX_TRIES} 个端口都被占用了，请关掉多余的窗口后重试。`);
    } else {
      console.error(`无法启动服务器：${err.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  ────────────────────────────────────────────────');
    console.log('   CS2 现役职业选手全球分布');
    console.log('  ────────────────────────────────────────────────');
    console.log('');
    console.log(`   地址： ${url}`);
    console.log('');
    console.log('   浏览器应该已经自动打开了。');
    console.log('   如果没有，就把上面那行「地址」复制到浏览器里打开。');
    console.log('   注意：必须用这个 http:// 地址，双击 index.html 是不行的。');
    console.log('');
    console.log('   关掉这个窗口 = 停止服务。');
    console.log('');
    if (WANT_OPEN) openBrowser(url);
  });
}

listen(PORT, MAX_TRIES);
