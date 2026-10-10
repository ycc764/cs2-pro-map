/**
 * HLTV 历届世界排名抓取器
 * ==================================================================
 * 产出 data/rankings.json：从最新一期一路回溯到第一期（2015-10-05）的全部快照。
 *
 * 怎么枚举日期（这是本脚本唯一的技术点，别改成"猜周一"）：
 *   HLTV **没有**归档索引页 —— `/ranking/archive` 会 302 回首页。
 *   但每一期排名页的头部都带着 `a.pagination-prev`，指向**上一期的确切日期**：
 *       /ranking/teams/2024/january/8  → prev = /ranking/teams/2024/january/1
 *   所以从 `/ranking/teams`（最新一期）出发，顺着 prev 一路往回走，
 *   就能不重不漏地拿到全部期次 —— 不用猜日期、不用处理 404、也不会漏掉
 *   节假日跳期（HLTV 有时隔两周才发一期）。走到没有 prev 就是第一期。
 *
 * 每期的结构（实测）：
 *   .regional-ranking-header-text  → "Counter-Strike World ranking on January 8th, 2024"
 *   .ranked-team                   → 一行
 *     .position                    → "#1"
 *     .teamLine .name              → "Vitality"
 *     .teamLine .points            → "(980 HLTV points)"
 *     .change                      → "-" / "+2" / "-3"（名次升降）
 *     .rankingNicknames span       → 5 个昵称（简表）
 *     .lineup a[href^="/player/"]  → 选手 id + 昵称 + 国旗（详表，信息更全）
 *
 * 用法：
 *   npm run scrape:rankings                    # 全部期次，每期留前 30 名
 *   npm run scrape:rankings -- --top 50
 *   npm run scrape:rankings -- --max 20        # 只往回走 20 期，用来验证
 *   npm run scrape:rankings -- --every 4       # 每 4 期取 1 期（省时间）
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, sleep } from './lib/browser.mjs';
import { connect, waitFor } from './lib/cdp.mjs';

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const OUT = String(flag('out', 'data/rankings.json'));
const PORT = Number(flag('port', 9333)) || 9333;
const DELAY_MS = Number(flag('delay', 1500)) || 1500;
const TOP = Number(flag('top', 30)) || 30;      // 每期保留多少名
const MAX = Number(flag('max', 0)) || 0;        // 最多抓多少期（0 = 直到第一期）
const EVERY = Number(flag('every', 1)) || 1;    // 每 N 期取 1 期
const HEADLESS = !!flag('headless', false);
const KEEP_OPEN = !!flag('keep-open', false);
const FORCE = !!flag('force', false);

const ORIGIN = 'https://www.hltv.org';
const START = `${ORIGIN}/ranking/teams`;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** /ranking/teams/2024/january/8 → "2024-01-08" */
function dateFromHref(href) {
  const m = String(href).match(/\/ranking\/teams\/(\d{4})\/([a-z]+)\/(\d{1,2})/i);
  if (!m) return '';
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return '';
  return `${m[1]}-${String(mi + 1).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 兜底：最新一期的地址是不带日期的 `/ranking/teams`，只能从页面头部的
 * "October 5th, 2026" 里读。缺了它第一期就会是空日期，排序和续抓都会错位。
 */
function dateFromText(text) {
  const m = String(text).match(/([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (!m) return '';
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return '';
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 在页面里执行的代码
 * ------------------------------------------------------------------ */
const EXTRACT_RANKING = (href) => `(async () => {
  try {
    const res = await fetch(${JSON.stringify(href)}, { credentials: 'include' });
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const head = (doc.querySelector('.regional-ranking-header-text')?.textContent || '').trim();
    const prevEl = doc.querySelector('a.pagination-prev');
    const prev = prevEl?.getAttribute('href') || '';
    const teams = [...doc.querySelectorAll('.ranked-team')].map((el) => {
      const rank = Number((el.querySelector('.ranking-header .position')?.textContent || '').replace(/[^\\d]/g, '')) || 0;
      const name = (el.querySelector('.teamLine .name')?.textContent || '').trim();
      const points = Number((el.querySelector('.teamLine .points')?.textContent || '').replace(/[^\\d]/g, '')) || 0;
      const changeRaw = (el.querySelector('.change')?.textContent || '').trim();
      // "-" 表示名次没动；"+2" 升 2 名；"-3" 掉 3 名
      const change = (changeRaw === '-' || changeRaw === '') ? 0 : (Number(changeRaw.replace(/[^\\d-]/g, '')) || 0);
      const players = [...el.querySelectorAll('.lineup a[href^="/player/"]')].map((a) => {
        const h = a.getAttribute('href') || '';
        const id = Number((h.match(/\\/player\\/(\\d+)/) || [])[1]) || 0;
        const nick = (a.querySelector('.nick')?.textContent || '').trim();
        const cc = ((a.querySelector('.nick img.flag')?.getAttribute('src') || '').match(/\\/([A-Z]{2})\\.gif/) || [])[1] || '';
        return id ? [id, nick, cc] : null;
      }).filter(Boolean);
      return { rank, name, points, change, players };
    }).filter((t) => t.rank && t.name);
    return { ok: true, head, prev, total: teams.length, teams };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 160) };
  }
})()`;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  /* ---- 断点续抓：读回已有快照，从最早那期的 prev 继续往回走 ---- */
  const store = {
    source: 'hltv',
    sourceUrl: START,
    license: '个人学习研究用途，请勿再分发',
    fetchedAt: '',
    top: TOP,
    snapshots: [],
  };
  if (fs.existsSync(OUT) && !FORCE) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (Array.isArray(prev?.snapshots) && prev.snapshots.length) {
        store.snapshots = prev.snapshots;
        console.log(`续抓：${OUT} 里已有 ${store.snapshots.length} 期`);
      }
    } catch { /* 坏文件就当没有 */ }
  }
  const have = new Set(store.snapshots.map((s) => s.date));
  // 从最新一期出发；已经有数据就从最早那期的 prev 接着走
  const oldest = store.snapshots[store.snapshots.length - 1];
  let nextUrl = oldest?.prev ? new URL(oldest.prev, ORIGIN).href : START;

  console.log(`起点：${nextUrl}`);
  console.log(`每期保留前 ${TOP} 名，每 ${EVERY} 期取 1 期，间隔 ${DELAY_MS}ms${MAX ? `，最多 ${MAX} 期` : ''}\n`);

  console.log('启动浏览器 …', HEADLESS ? '（无头，Cloudflare 几乎必然拦住）' : '（有窗口，首次通过校验约需 20–40s）');
  const browser = await launchBrowser({ port: PORT, headless: HEADLESS });
  const cdp = await connect(browser.cdpUrl);

  const passed = () => cdp.eval(
    `(() => {
       const t = document.title || '';
       const blocked = /just a moment|attention required|checking your browser|请稍候/i.test(t)
         || !!document.querySelector('#challenge-running, #cf-challenge-running');
       return !blocked && document.readyState !== 'loading';
     })()`,
  );

  const save = () => {
    store.fetchedAt = new Date().toISOString();
    store.snapshots.sort((a, b) => (a.date < b.date ? 1 : -1)); // 新 → 旧
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(store));
  };

  let fetched = 0;
  let failures = 0;
  const t0 = Date.now();

  try {
    process.stdout.write('→ 打开 HLTV 排名页取通行证 … ');
    await cdp.goto(START, { timeout: 60000 }).catch(() => {});
    await waitFor(passed, { timeout: 100000, label: '通过 Cloudflare 校验' });
    console.log('ok\n');

    let visited = 0;      // 走过多少期（含被 every 跳过的）
    let url = nextUrl;
    while (url) {
      if (MAX && fetched >= MAX) { console.log(`\n已达到 --max ${MAX}，停下。`); break; }
      const take = visited % EVERY === 0;

      let res = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        res = await cdp.eval(EXTRACT_RANKING(new URL(url).pathname));
        if (res?.ok) break;
        process.stdout.write(`(${attempt} 次失败: ${res?.err ?? '未知'}) `);
        await sleep(2500 * attempt);
      }
      if (!res?.ok) {
        failures++;
        console.log(`✗ ${dateFromHref(url) || url} 放弃：${res?.err ?? '未知'}`);
        if (failures >= 5) { console.log('连续失败太多，提前停下（已抓到的都已落盘）。'); break; }
        url = '';
        break;
      }
      failures = 0;

      // 最新一期的地址不带日期，只能从页面头部读。读不到就用地址兜底。
      const text = res.head.replace(/^Counter-Strike World ranking on\s*/i, '');
      const date = dateFromHref(url) || dateFromText(text);
      if (!date) {
        console.log(`⚠ 这一期读不出日期（head="${res.head}"），跳过以免污染时间轴`);
        visited++;
        url = res.prev ? new URL(res.prev, ORIGIN).href : '';
        await sleep(DELAY_MS);
        continue;
      }

      if (take && !have.has(date)) {
        store.snapshots.push({
          date,
          text,
          prev: res.prev || '',
          total: res.total,
          teams: res.teams.slice(0, TOP),
        });
        have.add(date);
        fetched++;
        const lead = res.teams[0];
        const avg = ((Date.now() - t0) / fetched / 1000).toFixed(1);
        console.log(
          `[${String(fetched).padStart(4)}] ${date}  ${String(res.total).padStart(3)} 队  `
          + `#1 ${(lead?.name || '?').padEnd(16)} ${String(lead?.points ?? '').padStart(4)} 分  `
          + `(${avg}s/期)`,
        );
        if (fetched % 10 === 0) save();
      }

      visited++;
      url = res.prev ? new URL(res.prev, ORIGIN).href : '';
      await sleep(DELAY_MS);
    }

    save();
    const span = store.snapshots.length
      ? `${store.snapshots[store.snapshots.length - 1].date} → ${store.snapshots[0].date}`
      : '(空)';
    const size = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
    console.log(`\n写入 ${OUT}：${store.snapshots.length} 期（${span}），${size} MB`);
  } finally {
    save();
    if (!KEEP_OPEN) {
      cdp.close();
      await browser.close().catch(() => {});
      console.log('浏览器已关闭');
    } else {
      console.log('浏览器保持打开（--keep-open）');
    }
  }
}

main().catch((e) => {
  console.error('\n抓取失败：', e.message);
  process.exit(1);
});
