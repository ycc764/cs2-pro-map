/**
 * 浏览器会话工具。
 *
 * 沙箱限制说明：Node 的 child_process 在受限模式下无法用管道 stdio 拉起子进程（EPERM），
 * 而 playwright 默认用 `--remote-debugging-pipe`（命名管道）启动浏览器，必然失败。
 * 因此这里改为：用 stdio:'ignore' 独立拉起 Chrome，开放 TCP 调试端口，再用 connectOverCDP 连接。
 *
 * ⚠ 反爬教训（2026-10 实测，别再踩）：
 *   这里曾经传过 `--user-agent=<硬编码 UA>`，结果访问 HLTV 时 Cloudflare 挑战永远过不去。
 *   原因有两层：
 *     1) 无头模式下浏览器原生 UA 是 `HeadlessChrome/154.0.0.0`，而 `navigator.userAgentData`
 *        是 undefined —— 伪造成 `Chrome/...` 反而制造了「UA 说有头、指纹说无头」的矛盾；
 *     2) Chrome 的 UA 缩减策略让 UA 串里的版本号恒为 `x.0.0.0`，与真实小版本不同，
 *        而 `--user-agent` 并不会同步改写 `navigator.userAgentData`。
 *   所以：**不要覆写 UA**，让浏览器用它自己的。同时 `--hide-scrollbars`、
 *   `--disable-background-networking` 这类"自动化常用开关"也会被指纹识别，已一并去掉。
 *   实测对照：覆写 UA → 卡 `Just a moment...` 90s 超时；不覆写 + 有窗口 → 38s 自动通过。
 *   （无头模式仍然过不去，因为 UA 里就写着 HeadlessChrome，抓 HLTV 必须开窗口。）
 *
 * ⚠ 系统代理教训（2026-10-10 实测，同一台机器）：
 *   Chrome 默认跟随 Windows 的系统代理。本机 `ProxyEnable=1`、`ProxyServer=127.0.0.1:7897`
 *   （clash / v2ray 那一类）。**走代理时 Cloudflare 的 managed challenge 永远过不去**
 *   （75s 仍是 "Just a moment..."），而同一个 Chrome、同一个 profile 加上
 *   `--no-proxy-server` 直连 —— **3 秒就过**。
 *   原因：代理是共享出口 IP，信誉分被拉低，Cloudflare 直接判成 bot。
 *   所以这里固定带上 `--no-proxy-server`。这不只是"能过挑战"的问题：直连时
 *   浏览器和 Node 的出口一致，抓下来的数据和 `fetch` 探测的结果才是同一个来源。
 *   要临时走代理调试，就用 `extraArgs` 覆盖不掉（它在后面追加，同名后者生效）——
 *   直接传 `extraArgs: ['--proxy-server=...']` 即可。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge 可执行文件');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 拉起一个可远程调试的 Chrome，返回 { cdpUrl, close() }。
 */
export async function launchBrowser({ port = 9333, profileDir, headless = true, extraArgs = [] } = {}) {
  const exe = findBrowser();
  const dir = profileDir || path.join(process.cwd(), '.tmp-profile', `p${port}`);
  fs.mkdirSync(dir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    // Chrome 111+ 会拒绝没有合法 Origin 的 DevTools WebSocket 连接
    '--remote-allow-origins=*',
    `--user-data-dir=${dir}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-sync',
    '--mute-audio',
    '--window-size=1440,900',
    '--lang=en-US',
    // 必须绕过系统代理：走代理时 HLTV 的 Cloudflare 挑战永远过不去（实测 75s 超时），
    // 直连 3s 就过。详见文件头部的教训注释。
    '--no-proxy-server',
    ...extraArgs,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(exe, args, { stdio: 'ignore', detached: false, windowsHide: true });
  child.on('error', (e) => console.error('[browser] spawn error', e.message));

  const cdpUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  if (!ready) {
    try { child.kill(); } catch {}
    throw new Error(`Chrome 调试端口 ${port} 未在 30s 内就绪`);
  }

  return {
    cdpUrl,
    exe,
    async close() {
      try {
        await fetch(`${cdpUrl}/json/close/${(await (await fetch(`${cdpUrl}/json/list`)).json())[0]?.id ?? ''}`).catch(() => {});
      } catch {}
      try { child.kill(); } catch {}
      await sleep(400);
      try { child.kill('SIGKILL'); } catch {}
    },
  };
}

export { sleep };
export const tmp = (name) => path.join(os.tmpdir(), name);
