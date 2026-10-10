/**
 * HLTV 年度 TOP20 选手抓取器
 * ==================================================================
 * 产出 data/top20.json：2013–2025 共 13 届「HLTV 年度 TOP20 选手」。
 *
 * 页面（实测）：
 *   总览  https://www.hltv.org/players/top20        → 里面有各年的 /players/top20/<年> 链接
 *   单年  https://www.hltv.org/players/top20/2025   → 一张表，表头 1 行 + 20 行
 *   注意：2013 年之前的页面是 **404**，HLTV 自己就只提供 2013 起（共 13 届）。
 *
 * 单行结构（实测原文，2025 的 #2）：
 *   <tr><td class="text-ellipsis">
 *     <div class="top20-year-player-wrapper">
 *       <img class="top20-table-img" alt="Danil 'donk' Kryshkovets"
 *            src="https://img-cdn.hltv.org/playerbodyshot/sEw....png?bg=3e4c54&h=100&...&w=100&s=...">
 *       <a href="/news/43609/top-20-players-of-2025-donk-2" class="top20-year-playername-wrapper">
 *         <b class="top20-year-playernick">donk</b>
 *         <div class="top20-year-playername">
 *           <img alt="Russia" src="/img/static/flags/30x20/RU.gif" class="flag">Danil Kryshkovets
 *         </div></a></div></td>
 *     <td><a href="/team/7020/spirit" class="top20-year-teamlogo-container">
 *       <img alt="Spirit" src="..."></a></td>
 *     <td>#2</td></tr>
 *
 * 取值要点：
 *   - **行序就是名次序**（第 1 个数据行 = #1）；名次本身在**最后一格**的文字里（"#1"）。
 *   - 国家两字母码从国旗 `src` 里抠（`/flags/30x20/RU.gif` → `ru`），`alt` 是英文国名。
 *   - 选手页链接指向的是 `/news/<id>/top-20-players-of-...` 而非 `/player/<id>`，
 *     所以这里拿不到数字 ID —— 前端靠昵称和 `public/data/ratings.json` 对齐。
 *
 * 用法：
 *   npm run scrape:top20
 *   npm run scrape:top20 -- --out data/top20.json --delay 1200
 *   npm run scrape:top20 -- --years 2020-2025    # 只抓一段，用来验证
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

const OUT = String(flag('out', 'data/top20.json'));
const PORT = Number(flag('port', 9333)) || 9333;
const DELAY_MS = Number(flag('delay', 1500)) || 1500;
const HEADLESS = !!flag('headless', false);
const KEEP_OPEN = !!flag('keep-open', false);
const FORCE = !!flag('force', false);
const RANGE = String(flag('years', ''));

const ORIGIN = 'https://www.hltv.org';
const START = `${ORIGIN}/players/top20`;

/* ------------------------------------------------------------------ *
 * 在页面里执行的代码
 * ------------------------------------------------------------------ */
/** 从总览页取出所有年份 */
const EXTRACT_YEARS = `(async () => {
  try {
    const res = await fetch(${JSON.stringify(START)}, { credentials: 'include' });
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const years = [...new Set([...doc.querySelectorAll('a[href*="/players/top20/"]')]
      .map((a) => (a.getAttribute('href').match(/\\/players\\/top20\\/(\\d{4})/) || [])[1])
      .filter(Boolean))].map(Number).sort((a, b) => b - a);
    return { ok: true, years };
  } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
})()`;

/** 抓某一年的 20 行 */
const EXTRACT_YEAR = (year) => `(async () => {
  try {
    const res = await fetch(${JSON.stringify(ORIGIN)} + '/players/top20/' + ${JSON.stringify(String(year))}, { credentials: 'include' });
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const rows = [...doc.querySelectorAll('table tr')].slice(1);   // 去掉表头
    const entries = rows.map((tr, i) => {
      const tds = [...tr.querySelectorAll('td')];
      const flagImg = tr.querySelector('.top20-year-playername img.flag');
      const flagSrc = flagImg?.getAttribute('src') || '';
      const cc = (flagSrc.match(/\\/flags\\/[^/]+\\/([A-Za-z]{2})\\.gif/) || [])[1] || '';
      const nickEl = tr.querySelector('.top20-year-playernick');
      const realEl = tr.querySelector('.top20-year-playername');
      // realEl 里除了文字还有一个国旗 <img>，把 img 去掉再取文字
      let real = '';
      if (realEl) {
        const clone = realEl.cloneNode(true);
        clone.querySelectorAll('img').forEach((im) => im.remove());
        real = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      const rankTxt = (tds[tds.length - 1]?.textContent || '').replace(/[^\\d]/g, '');
      return {
        rank: Number(rankTxt) || i + 1,          // 最后一格写着 "#2"；缺了就退回行序
        nick: (nickEl?.textContent || '').trim(),
        real,
        cc: cc.toLowerCase(),
        country: flagImg?.getAttribute('alt') || '',
        team: (tr.querySelector('.top20-year-teamlogo-container img')?.getAttribute('alt') || '').trim(),
        teamHref: tr.querySelector('.top20-year-teamlogo-container')?.getAttribute('href') || '',
        news: tr.querySelector('.top20-year-playername-wrapper')?.getAttribute('href') || '',
        img: tr.querySelector('.top20-table-img')?.getAttribute('src') || '',
      };
    }).filter((e) => e.nick);
    return { ok: true, year: ${year}, entries };
  } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
})()`;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const prev = !FORCE && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const done = new Map((prev?.years || []).map((y) => [y.year, y]));

const browser = await launchBrowser({ port: PORT, headless: HEADLESS });
const cdp = await connect(browser.cdpUrl);

try {
  // 先开首页把 Cloudflare 的 managed challenge 过掉，否则后面全是 403 挑战页
  await cdp.goto(ORIGIN);
  process.stdout.write('等待 Cloudflare 校验');
  await waitFor(async () => !/just a moment/i.test(await cdp.eval('document.title')), {
    timeout: 120000, interval: 1000, label: '通过 Cloudflare 校验',
  });
  console.log(' 通过 ✅');

  const yrs = await cdp.eval(EXTRACT_YEARS);
  if (!yrs.ok) throw new Error(`取年份列表失败：${yrs.err}`);
  let years = yrs.years;
  if (RANGE) {
    const m = RANGE.match(/^(\d{4})(?:-(\d{4}))?$/);
    if (!m) throw new Error(`--years 格式应为 2020 或 2020-2025，收到 "${RANGE}"`);
    const [a, b] = [Number(m[1]), Number(m[2] || m[1])];
    years = years.filter((y) => y >= Math.min(a, b) && y <= Math.max(a, b));
  }
  console.log(`年份：${years.join(' ')}（共 ${years.length} 届）`);

  const out = [];
  for (const year of years) {
    if (done.has(year)) {
      console.log(`[${year}] 已有，跳过`);
      out.push(done.get(year));
      continue;
    }
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await cdp.eval(EXTRACT_YEAR(year));
      if (r.ok) break;
      console.log(`[${year}] 第 ${attempt} 次失败：${r.err}`);
      await sleep(DELAY_MS * attempt);
    }
    if (!r || !r.ok) {
      console.log(`[${year}] 放弃（${r?.err || '未知错误'}）`);
      continue;
    }
    const ranks = r.entries.map((e) => e.rank).join(',');
    console.log(`[${year}] ${r.entries.length} 人  名次 ${ranks.slice(0, 18)}…  #1 ${r.entries[0]?.nick}`);
    out.push({ year, entries: r.entries });
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          source: 'HLTV.org',
          sourceUrl: START,
          license: '个人学习研究用途，请勿再分发',
          fetchedAt: new Date().toISOString(),
          years: [...out].sort((a, b) => b.year - a.year),
        },
        null,
        1,
      ),
    );
    await sleep(DELAY_MS);
  }

  const yearsOut = [...out].sort((a, b) => b.year - a.year);
  const people = new Set(yearsOut.flatMap((y) => y.entries.map((e) => e.nick.toLowerCase())));
  console.log(`\n写入 ${OUT}：${yearsOut.length} 届（${yearsOut[yearsOut.length - 1]?.year}–${yearsOut[0]?.year}），${people.size} 位不同选手`);
} finally {
  if (KEEP_OPEN) {
    console.log('（--keep-open，浏览器保持打开）');
  } else {
    try { await cdp.close(); } catch { }
    try { await browser.close(); } catch { }
    console.log('浏览器已关闭');
  }
}
