/**
 * HLTV 选手 Rating 抓取器
 * ==================================================================
 * 数据源：`https://www.hltv.org/stats/players?startDate=…&endDate=…`
 *
 * 为什么用这个页面而不是选手页上的 rating（实测结论，别改回去）：
 *   选手页 `div.playerpage-container-attributes` 里也有一个 "Rating 3.0"，
 *   但那个是**固定窗口**的（页面上写着 "Past 3 months • 50 maps"），
 *   既不能自定义区间、也没法按年切片。stats 表可以随便给区间，而且
 *   **一页就是全量**：`table.player-ratings-table tbody` 里 990 个 `<tr>`，
 *   页面上没有任何分页控件。一次请求拿到全部 990 人的 rating。
 *
 * 关键：id 空间是通的
 *   `/stats/players/<id>/<nick>` 和 `/player/<id>/<nick>` 用的是**同一个数字 id**
 *   （实测 ZywOo=11893、donk=21167、m0NESY=19230、sh1ro=16920、apEX=7322）。
 *   所以这份数据能直接和 data/hltv.json 里的 `page: "/player/11893/zywoo"` 对表，
 *   实测与我们的 485 名选手命中 448 人（92.4%），没命中的多半是统计窗口内
 *   maps 太少被 HLTV 排除了。
 *
 * 用法：
 *   npm run scrape:ratings                    # 职业生涯总计 + 逐年（2012 至今）
 *   npm run scrape:ratings -- --no-years      # 只抓职业生涯总计
 *   npm run scrape:ratings -- --years 2016-2026
 *   npm run scrape:ratings -- --from 2015-01-01
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

const OUT = String(flag('out', 'data/ratings.json'));
const PORT = Number(flag('port', 9333)) || 9333;
const DELAY_MS = Number(flag('delay', 1600)) || 1600;
const HEADLESS = !!flag('headless', false);
const KEEP_OPEN = !!flag('keep-open', false);
const WITH_YEARS = !flag('no-years', false);
const FROM = String(flag('from', '2012-01-01'));

/** 生涯起点：HLTV 的 CS:GO 统计大概从 2012 年开始，早于它的区间只会得到空表 */
const CAREER_FROM = FROM;
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_FROM = Number(FROM.slice(0, 4));
const YEAR_TO = Number(TODAY.slice(0, 4));

const yearFlag = flag('years', '');
const YEARS = (() => {
  if (typeof yearFlag === 'string' && yearFlag.includes('-')) {
    const [a, b] = yearFlag.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return Array.from({ length: YEAR_TO - YEAR_FROM + 1 }, (_, i) => YEAR_FROM + i);
})();

const ORIGIN = 'https://www.hltv.org';
const RANKING_URL = 'https://www.hltv.org/ranking/teams';

/* ------------------------------------------------------------------ *
 * 在页面里执行的代码
 * ------------------------------------------------------------------ */
/**
 * 同源 fetch stats 表并按行解析。返回的是纯数据（990 个小对象），
 * HTML 本身留在页面里丢掉 —— 省掉把 ~1MB 文本传回 Node 的开销。
 */
const EXTRACT_STATS = (qs) => String.raw`(async () => {
  try {
    const res = await fetch('/stats/players?' + ${JSON.stringify(qs)}, { credentials: 'include' });
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table.player-ratings-table');
    if (!table) {
      const t = (doc.querySelector('title')?.textContent || '').trim();
      return { ok: false, err: '找不到 stats 表（title: ' + t.slice(0, 60) + '）' };
    }
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
      const flagImg = tr.querySelector('td.playerCol img.flag');
      const a = tr.querySelector('td.playerCol a[href^="/stats/players/"]');
      const href = a?.getAttribute('href') || '';
      const id = Number((href.match(/\/stats\/players\/(\d+)/) || [])[1]) || 0;
      const teamA = tr.querySelector('td.teamCol a[href^="/stats/teams/"]');
      const teamHref = teamA?.getAttribute('href') || '';
      const details = [...tr.querySelectorAll('td.statsDetail')].map((td) => (td.textContent || '').trim());
      const kdCell = tr.querySelector('td.kdDiffCol');
      const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
      return {
        id,
        nick: (a?.textContent || '').trim(),
        country: flagImg?.getAttribute('alt') || '',
        countryCode: ((flagImg?.getAttribute('src') || '').match(/\/([A-Z]{2})\.gif/) || [])[1] || '',
        team: tr.querySelector('td.teamCol')?.getAttribute('data-sort') || '',
        teamId: Number((teamHref.match(/\/stats\/teams\/(\d+)/) || [])[1]) || 0,
        maps: num(details[0]),
        rounds: num(details[1]),
        kdDiff: num(kdCell?.getAttribute('data-sort') ?? kdCell?.textContent),
        kd: num(details[2]),
        rating: num(tr.querySelector('td.ratingCol')?.textContent),
      };
    }).filter((r) => r.id && r.nick);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 160) };
  }
})()`;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  const ranges = [
    { key: 'career', label: '职业生涯总计', startDate: CAREER_FROM, endDate: TODAY },
    ...(WITH_YEARS
      ? YEARS.map((y) => ({
        key: String(y),
        label: `${y} 年`,
        startDate: `${y}-01-01`,
        endDate: y === YEAR_TO ? TODAY : `${y}-12-31`,
      }))
      : []),
  ];

  console.log(`待抓区间 ${ranges.length} 个：${ranges.map((r) => r.label).join('、')}`);
  console.log(`预计耗时约 ${Math.ceil((ranges.length * (DELAY_MS + 2500)) / 60000)} 分钟\n`);

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

  const store = {
    source: 'hltv',
    sourceUrl: `${ORIGIN}/stats/players`,
    license: '个人学习研究用途，请勿再分发',
    fetchedAt: '',
    ranges: {},
  };

  try {
    process.stdout.write('→ 打开 HLTV 排名页取通行证 … ');
    await cdp.goto(RANKING_URL, { timeout: 60000 }).catch(() => {});
    await waitFor(passed, { timeout: 100000, label: '通过 Cloudflare 校验' });
    console.log('ok\n');

    for (const [i, r] of ranges.entries()) {
      const tag = `[${i + 1}/${ranges.length}] ${r.label}`.padEnd(26);
      process.stdout.write(`${tag} `);
      const qs = `startDate=${r.startDate}&endDate=${r.endDate}`;
      let got = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await cdp.eval(EXTRACT_STATS(qs));
        if (res?.ok) { got = res; break; }
        process.stdout.write(`(${attempt} 次失败: ${res?.err ?? '未知'}) `);
        await sleep(2500 * attempt);
      }
      if (!got) {
        console.log('✗ 放弃');
        store.ranges[r.key] = { ...r, error: 'fetch failed', players: [] };
        continue;
      }
      // 只保留能用的字段，别把空字符串塞进产物
      const players = got.rows
        .filter((p) => p.rating > 0)
        .map((p) => {
          const o = { id: p.id, nick: p.nick, country: p.country, countryCode: p.countryCode, team: p.team, teamId: p.teamId, maps: p.maps, rounds: p.rounds, kd: p.kd, kdDiff: p.kdDiff, rating: p.rating };
          return o;
        });
      store.ranges[r.key] = { label: r.label, startDate: r.startDate, endDate: r.endDate, players };
      const top = players.slice(0, 3).map((p) => `${p.nick} ${p.rating}`).join(' / ');
      console.log(`${players.length} 人   前三：${top || '(空)'}`);
      await sleep(DELAY_MS);
    }

    /* ---- 自检：生涯 maps 必须 ≥ 任何单年的 maps，否则说明区间过滤没生效 ---- */
    const career = store.ranges.career?.players ?? [];
    const byId = new Map(career.map((p) => [p.id, p]));
    let checked = 0;
    const bad = [];
    for (const r of ranges) {
      if (r.key === 'career') continue;
      for (const p of store.ranges[r.key]?.players ?? []) {
        const c = byId.get(p.id);
        if (!c) continue;
        checked++;
        if (c.maps < p.maps) bad.push(`${p.nick}(${r.key}: ${p.maps} > career ${c.maps})`);
      }
    }
    console.log(`\n自检：逐年与生涯比对 ${checked} 次` + (bad.length ? `，⚠ ${bad.length} 处异常：${bad.slice(0, 5).join('、')}` : ' 全部正常 ✅'));

    store.fetchedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(store));
    const size = (fs.statSync(OUT).size / 1024).toFixed(0);
    console.log(`写入 ${OUT}：${Object.keys(store.ranges).length} 个区间、生涯 ${career.length} 人（${size} KB）`);
  } finally {
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
