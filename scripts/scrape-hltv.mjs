/**
 * HLTV 抓取器
 * ==================================================================
 * HLTV 前面挂着 Cloudflare 的 managed challenge，普通 fetch / curl 一律 403
 * （页面标题是 "Just a moment..."）。必须开一个**真实的、有窗口的**浏览器让它
 * 自动过挑战。实测结论：
 *   - 无头模式：原生 UA 是 `HeadlessChrome/154.0.0.0` → 永远过不去；
 *   - 覆写 `--user-agent`：会与 `navigator.userAgentData` 不一致 → 也过不去；
 *   - 有窗口 + 不覆写 UA：约 20–40s 自动通过 ✅
 * 所以本脚本默认开窗口（不再是 `--headful` 开关），也不要再去调
 * `Network.setUserAgentOverride`。详见 lib/browser.mjs 顶部的教训注释。
 *
 * 用法（在项目目录下）：
 *   npm run scrape:hltv                  # 世界排名前 30 队（会弹出一个浏览器窗口）
 *   npm run scrape:hltv -- --limit 60    # 抓前 60 队
 *   npm run scrape:hltv -- --keep-open   # 抓完不关浏览器，便于自己看
 *   npm run scrape:hltv -- --headless    # 无头（几乎必然被拦，仅供调试）
 *
 * 产出：data/hltv.json，与 data/liquipedia.json 结构完全一致，
 *       因此可以直接 `npm run dataset hltv` 生成前端数据。
 *
 * 说明：HLTV 的页面结构会变。如果解析出 0 名选手，脚本会把页面原始 HTML
 *       存到 data/raw/hltv-sample.html，照着改下面的选择器即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, sleep } from './lib/browser.mjs';
import { connect, waitFor } from './lib/cdp.mjs';
import { toCode } from './lib/countries.mjs';

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
const LIMIT = Number(flag('limit', 30)) || 30;
// 默认开窗口：无头模式的原生 UA 是 HeadlessChrome/154.0.0.0，Cloudflare 一眼识破
// （实测卡在 Just a moment... 直到 90s 超时）。有窗口时不覆写 UA 可 38s 自动通过。
const HEADLESS = !!flag('headless', false);
const KEEP_OPEN = !!flag('keep-open', false);
const PORT = Number(flag('port', 9333)) || 9333;
const OUT = String(flag('out', 'data/hltv.json'));
const RANKING_URL = String(flag('ranking', 'https://www.hltv.org/ranking/teams'));
const DELAY_MS = Number(flag('delay', 2600)) || 2600;

const ORIGIN = 'https://www.hltv.org';

/* ------------------------------------------------------------------ *
 * 在页面里执行的解析代码（返回纯 JSON）
 * ------------------------------------------------------------------ */

/** 从排名页抓队伍列表 */
const EXTRACT_RANKING = `(() => {
  const out = [];
  const seen = new Set();
  const push = (name, href) => {
    if (!href || !href.includes('/team/')) return;
    const id = (href.match(/\\/team\\/(\\d+)/) || [])[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: (name || '').trim(), href: href.split('?')[0] });
  };
  // 新版排名页
  document.querySelectorAll('.ranked-team, .ranking-team, .team-ranked').forEach((el) => {
    const a = el.querySelector('a[href*="/team/"]');
    const nameEl = el.querySelector('.team-name .name, .name, .team-name');
    if (a) push(nameEl ? nameEl.textContent : a.textContent, a.getAttribute('href'));
  });
  // 兜底：整页所有队伍链接
  if (!out.length) {
    document.querySelectorAll('a[href*="/team/"]').forEach((a) => {
      push(a.textContent, a.getAttribute('href'));
    });
  }
  return out;
})()`;

/** 从队伍页抓名字 / 队标 / 所在地 / 现役阵容 */
const EXTRACT_TEAM = `(() => {
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const attr = (el, a) => (el ? el.getAttribute(a) : null);
  // HLTV 的 <img alt> 形如 "Image of Counter-Strike player sh1ro"，这里剥掉描述前缀，
  // 只留昵称；同时挡掉没剥干净时把整句当昵称的情况。
  const cleanNick = (s) => {
    let v = (s || '').replace(/\\s+/g, ' ').trim();
    v = v.replace(/^Image of .*?player\\s*/i, '').replace(/^Counter-Strike player\\s*/i, '').trim();
    return /^Image of/i.test(v) ? '' : v;
  };

  const titleEl = document.querySelector('.team-profile h1, h1.profile-title, .profile-title h1, h1');
  const logoEl = document.querySelector('.team-profile .teamlogo, .teamlogo img, .teamlogo, img.team-logo');

  // 所在地：HLTV 用 .team-country 里的 .flag
  const countryEl = document.querySelector('.team-country .flag, .team-country img, .team-profile .flag');
  const location =
    countryEl?.getAttribute('alt') ||
    txt(document.querySelector('.team-country')) ||
    '';

  // ---- 阵容 ----
  const players = [];
  const seen = new Set();

  const addPlayer = (a, nameHint, countryHint) => {
    const href = a?.getAttribute('href') || '';
    const m = href.match(/\\/player\\/(\\d+)\\/([^/?#]+)/);
    if (!m) return;
    const id = nameHint || decodeURIComponent(m[2] || '');
    if (!id || seen.has(id.toLowerCase())) return;
    seen.add(id.toLowerCase());
    players.push({
      id,
      name: a.getAttribute('data-fullname') || '',
      flag: countryHint || '',
      role: '',
      igl: false,
      joindate: '',
      page: href,
    });
  };

  document.querySelectorAll('.team-roster, .bodyshot-team, .team-roster-container').forEach((block) => {
    block.querySelectorAll('a[href*="/player/"]').forEach((a) => {
      const img = a.querySelector('img');
      // ⚠ 优先取链接里的可见文本。HLTV 的 <img alt> 是
      // "Image of Counter-Strike player sh1ro" 这种描述句，直接当昵称会污染 id 字段。
      const nick = cleanNick(txt(a.querySelector('.text-ellipsis, .player-holder, .nick')) || txt(a))
        || cleanNick(img?.getAttribute('alt'));
      // 国旗：同一条目里找 .flag
      let cc = '';
      const flagEl = a.querySelector('.flag, img.flag') || a.closest('tr, li, div')?.querySelector('.flag');
      if (flagEl) cc = flagEl.getAttribute('alt') || (attr(flagEl, 'class') || '').match(/flag-([a-z]{2})/i)?.[1] || '';
      addPlayer(a, nick, cc);
    });
  });

  // 兜底：整页 player 链接（只取可能的阵容区）
  if (!players.length) {
    document.querySelectorAll('.team-profile a[href*="/player/"], .standard-box a[href*="/player/"]').forEach((a) => {
      const img = a.querySelector('img');
      const flagEl = a.querySelector('.flag') || a.closest('div')?.querySelector('.flag');
      addPlayer(a, cleanNick(txt(a)) || cleanNick(img?.getAttribute('alt')),
        flagEl?.getAttribute('alt') || (attr(flagEl, 'class') || '').match(/flag-([a-z]{2})/i)?.[1] || '');
    });
  }

  return {
    name: txt(titleEl),
    logo: logoEl ? (attr(logoEl, 'src') || attr(logoEl.querySelector?.('img'), 'src') || '') : '',
    location,
    players,
  };
})()`;

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */
function writeDataset(teams) {
  const nonEmpty = teams.filter((t) => t.players.length > 0);
  const dataset = {
    source: 'hltv',
    sourceUrl: 'https://www.hltv.org/ranking/teams',
    license: '个人学习研究用途，请勿再分发',
    fetchedAt: new Date().toISOString(),
    sections: {},
    teams: nonEmpty,
    emptyTeams: teams.filter((t) => t.players.length === 0).map((t) => ({ name: t.name, page: t.page })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2));
  const players = nonEmpty.reduce((n, t) => n + t.players.length, 0);
  console.log(`\n写入 ${OUT}：${nonEmpty.length} 支战队 / ${players} 名选手 / ${dataset.emptyTeams.length} 支空阵容`);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  console.log('启动浏览器 …', HEADLESS ? '（无头，Cloudflare 几乎必然拦住，仅供参考）' : '（有窗口，首次通过校验约需 20–40s）');
  const browser = await launchBrowser({ port: PORT, headless: HEADLESS });
  const cdp = await connect(browser.cdpUrl);
  await cdp.send('Network.enable').catch(() => {});
  // 注意：这里**不能**调 Network.setUserAgentOverride。覆写 UA 会让 navigator.userAgent
  // 与 navigator.userAgentData 不一致，Cloudflare 挑战就永远过不去（详见 lib/browser.mjs 注释）。

  const passed = () => cdp.eval(
    `(() => {
       const t = document.title || '';
       const blocked = /just a moment|attention required|checking your browser|请稍候/i.test(t)
         || !!document.querySelector('#challenge-running, #cf-challenge-running');
       return !blocked && document.readyState !== 'loading';
     })()`,
  );

  async function open(url, label) {
    process.stdout.write(`→ ${label} … `);
    await cdp.goto(url, { timeout: 60000 }).catch(() => {});
    await waitFor(passed, { timeout: 90000, label: `${label} 通过 Cloudflare 校验` });
    console.log('ok');
  }

  try {
    /* 1) 排名页 → 队伍列表 */
    await open(RANKING_URL, '加载队伍排名');
    let list = await cdp.eval(EXTRACT_RANKING);
    if (!Array.isArray(list)) list = [];
    list = list.filter((t) => t.name && t.href).slice(0, LIMIT);
    console.log(`找到 ${list.length} 支战队${LIMIT < 999 ? `（上限 ${LIMIT}）` : ''}`);
    if (!list.length) {
      const html = await cdp.html();
      fs.mkdirSync('data/raw', { recursive: true });
      fs.writeFileSync('data/raw/hltv-ranking.html', html);
      throw new Error('没解析出战队列表，原始 HTML 已存到 data/raw/hltv-ranking.html，请照着改 EXTRACT_RANKING');
    }

    /* 2) 逐队抓阵容 */
    const teams = [];
    let first = true;
    for (const [i, t] of list.entries()) {
      const url = t.href.startsWith('http') ? t.href : ORIGIN + t.href;
      process.stdout.write(`[${i + 1}/${list.length}] ${t.name} … `);
      try {
        await cdp.goto(url, { timeout: 60000 }).catch(() => {});
        await waitFor(passed, { timeout: 90000, interval: 900, label: `${t.name} 通过校验` });
        const info = await cdp.eval(EXTRACT_TEAM);
        const players = (info?.players ?? []).map((p) => ({
          id: p.id,
          name: p.name || '',
          flag: toCode(p.flag) || '',
          role: p.role || '',
          igl: !!p.igl,
          joindate: p.joindate || '',
          // 选手页相对路径（/player/11893/zywoo）。scrape-players.mjs 靠它去抓
          // 头像和冠军荣誉，**不能丢**——丢了就得重新从排名页反查一遍。
          page: p.page || '',
        }));
        teams.push({
          name: info?.name || t.name,
          page: url,
          location: info?.location || '',
          portalSection: '',
          infoboxRegion: '',
          logo: info?.logo || '',
          players,
        });
        console.log(`${players.length} 人`);
        if (first) {
          first = false;
          if (!players.length) {
            fs.mkdirSync('data/raw', { recursive: true });
            fs.writeFileSync('data/raw/hltv-sample.html', await cdp.html());
            console.log('  ⚠ 第一支队没解析出选手，页面已存到 data/raw/hltv-sample.html');
          }
        }
      } catch (e) {
        console.log(`失败：${e.message}`);
        teams.push({ name: t.name, page: url, location: '', portalSection: '', infoboxRegion: '', logo: '', players: [] });
      }
      await sleep(DELAY_MS);
    }

    writeDataset(teams);
  } finally {
    if (!KEEP_OPEN) {
      cdp.close();
      await browser.close();
    } else {
      console.log('浏览器保持打开，自行关闭即可。');
    }
  }
}

main().catch((e) => {
  console.error('\n抓取失败：', e.message);
  process.exitCode = 1;
});
