/**
 * 极简 CDP 客户端（Chrome DevTools Protocol over WebSocket）
 * ------------------------------------------------------------------
 * 为什么不用 playwright：它在受限环境下会用命名管道启动浏览器而失败。
 * 这里只用 Node 自带的全局 WebSocket（Node 22+），零依赖。
 *
 *   const cdp = await connect(http://127.0.0.1:9333)
 *   await cdp.goto('https://example.com')
 *   const title = await cdp.eval('document.title')
 *   cdp.close()
 */
import { sleep } from './browser.mjs';

export class CDP {
  constructor(ws, defaultSessionId = null) {
    this.ws = ws;
    this.defaultSessionId = defaultSessionId;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    }
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (p) => { off(); clearTimeout(t); resolve(p); });
      const t = setTimeout(() => { off(); reject(new Error(`等待事件 ${method} 超时`)); }, timeoutMs);
    });
  }

  send(method, params = {}, sessionId = this.defaultSessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  /** 在页面里跑一段表达式（可以是 async IIFE 字符串），返回 JSON 值 */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  /** 导航到 url，等 load 事件（超时不算失败，有些页面 load 永不触发） */
  async goto(url, { timeout = 45000 } = {}) {
    const loaded = this.once('Page.loadEventFired', timeout).catch(() => null);
    await this.send('Page.navigate', { url });
    await loaded;
    return this;
  }

  /** 当前文档的 HTML */
  html() {
    return this.eval('document.documentElement.outerHTML');
  }

  close() {
    try { this.ws.close(); } catch { /* 忽略 */ }
  }
}

/**
 * 连接到一个已经开着调试端口的 Chrome，返回页级 CDP 会话。
 * @param {string} cdpUrl 形如 http://127.0.0.1:9333
 */
export async function connect(cdpUrl, { timeout = 20000 } = {}) {
  // 挑一个真实的 page target（不要 devtools:// 那种）
  const deadline = Date.now() + timeout;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${cdpUrl}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (target) break;
    } catch { /* 端口还没就绪 */ }
    await sleep(300);
  }
  if (!target) throw new Error('找不到可用的页面 target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket 连接失败')), { once: true });
    setTimeout(() => reject(new Error('DevTools WebSocket 连接超时')), timeout);
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

/** 轮询直到 fn() 返回真值（用于等 Cloudflare 挑战自动放行） */
export async function waitFor(fn, { timeout = 60000, interval = 800, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch { /* 页面可能正在跳转 */ }
    await sleep(interval);
  }
  throw new Error(`等待「${label}」超时（${timeout}ms）`);
}
