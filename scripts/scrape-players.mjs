/**
 * HLTV 选手资料抓取器（头像 + 冠军荣誉）
 * ==================================================================
 * 跑在 scrape-hltv.mjs **之后**：读 data/hltv.json 里的选手页路径，
 * 逐个补上头像和「冠军」列表，产出 data/players.json + public/avatars/<id>.webp。
 *
 * 为什么写得这么绕（三条都是实测踩出来的，改之前先读）：
 *
 *  1) 头像图片在 img-cdn.hltv.org，同样被 Cloudflare 挡着：普通 node fetch 403。
 *     在 hltv.org 页面里 `fetch(头像URL)` 也不行 —— 跨域且 CDN 不返回 CORS 头，
 *     报 `TypeError: Failed to fetch`。**唯一能走通的是 CDP `Network.getResponseBody`**：
 *     先让页面把图片加载出来（`new Image()`），再从 Network 事件里按 URL 找到
 *     requestId，取回原始字节。这是浏览器自己的网络栈，不受 CORS 约束。
 *
 *  2) CDN 的 `s=` 签名**绑定 `w=` 参数**：把 w=400 改成 w=120 直接 403。
 *     所以拿不到小图，原图 w=400 约 88–96 KB，500 人就是 40+ MB，不能直接入库。
 *     解法：把原图当 data: URL 塞回页面 —— data URL 是同源的，不会污染 canvas ——
 *     用 canvas 缩到 120×120 再 `toDataURL('image/webp', 0.88)`，约 4 KB/张，
 *     alpha 也保得住（实测角落像素 rgba=[0,0,0,0]）。500 人 ≈ 2 MB。
 *     ⚠ 直接用 CDN 的 URL 画 canvas 会因跨域**污染画布**，toDataURL 抛 SecurityError。
 *
 *  3) 逐个 `Page.navigate` 打开 500 个选手页太慢。改成**停留在 hltv.org 上用同源
 *     fetch 拉 HTML**，再用 DOMParser 在页面里解析出需要的那点字段，只把结果传回
 *     Node。省掉了每次渲染整页（广告/图片/脚本）的开销。
 *     ⚠ 选手页 HTML 解压后约 2.7 MB，但走 gzip 实际传输小得多；即便如此也要
 *     保持 --delay 的礼貌间隔，别把人家站点打疼。
 *
 * 冠军的判据（用户要求"只加冠军"）：
 *   `.trophySection a.trophy[href^="/events/"]` —— 只有这种块才代表拿过某个赛事冠军。
 *   同一排里的其它块一律不要：MVP 次数（div + .mvp-count）、`#N best player in YY`、
 *   Player/AWPer of the Year、`Winner of ESL Grand Slam`（href 是 /news/）、
 *   `Faceit winner of: FPL`。实测 ZywOo 的 44 块里只有 28 块是赛事冠军。
 *
 * 用法：
 *   npm run scrape:players                 # 全部（可中断，重跑自动续）
 *   npm run scrape:players -- --only 5     # 只跑前 5 个，用来验证
 *   npm run scrape:players -- --force      # 已有头像也重抓
 *   npm run scrape:players -- --size 160   # 头像边长（默认 120，用 --force 才会重存）
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
const IN = String(flag('input', 'data/hltv.json'));
const OUT = String(flag('out', 'data/players.json'));
const AVATAR_DIR = String(flag('avatars', 'public/avatars'));
const PORT = Number(flag('port', 9333)) || 9333;
const DELAY_MS = Number(flag('delay', 1500)) || 1500;
const SIZE = Number(flag('size', 120)) || 120;
const QUALITY = Number(flag('quality', 0.88)) || 0.88;
const ONLY = Number(flag('only', 0)) || 0;
const FORCE = !!flag('force', false);
const HEADLESS = !!flag('headless', false);
const KEEP_OPEN = !!flag('keep-open', false);

const ORIGIN = 'https://www.hltv.org';
const RANKING_URL = 'https://www.hltv.org/ranking/teams';

/* ------------------------------------------------------------------ *
 * 在页面里执行的代码
 * ------------------------------------------------------------------ */

/**
 * 同源 fetch 一个选手页，解析出头像地址 + 冠军列表。
 * 返回体积很小（几十条字符串），HTML 本身留在页面里丢掉。
 */
const EXTRACT_PLAYER = (href) => `(async () => {
  try {
    const res = await fetch(${JSON.stringify('')} + ${JSON.stringify(href)}, { credentials: 'include' });
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status };
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const og = doc.querySelector('meta[property="og:image"]')?.content || '';
    const shot = doc.querySelector('img.player-summary-stat-box-left-bodyshot')?.getAttribute('src') || og;
    const nick = (doc.querySelector('.player-summary-container h1, h1')?.textContent || '').trim();

    // 只认 <a class="trophy" href="/events/...">，其余（MVP/年度最佳/FPL）全部丢掉
    const raw = [...doc.querySelectorAll('.trophySection a.trophy')]
      .filter((a) => (a.getAttribute('href') || '').startsWith('/events/'))
      .map((a) => ({
        name: (a.querySelector('.trophyDescription')?.getAttribute('title') || '').trim(),
        href: a.getAttribute('href'),
      }))
      .filter((t) => t.name);

    // 去重只能用 href（每个 href 是一个独立的赛事届次），**不能用赛事名**：
    // HLTV 的 title 经常不带年份，像 "IEM Katowice"、"BLAST Premier World Final"
    // 这种年年都办的比赛，赢了 3 次就是 3 个不同的 /events/<id>，按名字去重会
    // 把它们压成 1 条，冠军数直接少算。
    const seen = new Set();
    const trophies = [];
    for (const t of raw) {
      if (seen.has(t.href)) continue;
      seen.add(t.href);
      trophies.push(t);
    }
    // 顺带数一下被丢掉的块，便于判断选择器有没有失效
    const allBlocks = doc.querySelectorAll('.trophySection .trophy').length;
    return { ok: true, nick, og, shot, trophies, allBlocks };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 160) };
  }
})()`;

/** 让页面把头像真加载一遍（这样才能在 Network 事件里拿到 requestId） */
const LOAD_IMAGE = (url) => `(async () => {
  const img = new Image();
  img.decoding = 'sync';
  return await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, why: '加载超时' }), 25000);
    img.onload = () => { clearTimeout(t); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(t); resolve({ ok: false, why: 'onerror（多半 403）' }); };
    img.src = ${JSON.stringify(url)};
  });
})()`;

/** 把原图当 data URL 画进 canvas 缩小，返回小图 data URL（同源，不会污染画布） */
const DOWNSCALE = (dataUrl) => `(async () => {
  const img = new Image();
  img.src = ${JSON.stringify(dataUrl)};
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('解码失败')); });
  const c = document.createElement('canvas');
  c.width = ${SIZE}; c.height = ${SIZE};
  const ctx = c.getContext('2d');
  // 原图 400×417 的 bodyshot，人脸在上半部：取顶部正方形（头 + 肩）
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0, s, s, 0, 0, ${SIZE}, ${SIZE});
  return c.toDataURL('image/webp', ${QUALITY});
})()`;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  if (!fs.existsSync(IN)) {
    console.error(`找不到 ${IN} —— 先跑 npm run scrape:hltv 生成队伍与选手名单。`);
    process.exit(1);
  }
  const src = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const wanted = [];
  const seen = new Set();
  for (const t of src.teams ?? []) {
    for (const p of t.players ?? []) {
      if (!p.page || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      // 文件名一律用选手页 URL 里的**数字 id**：昵称里可能有 . - _ 甚至空格，
      // 直接拿来做文件名迟早出事（顺便也让 url 稳定，改名不会换图）。
      const num = String(p.page).match(/\/player\/(\d+)/)?.[1] || '';
      wanted.push({ id: String(p.id), nick: p.id, page: p.page, team: t.name, num: num || String(p.id) });
    }
  }
  console.log(`${IN}：${src.teams?.length ?? 0} 支队，待补资料的选手 ${wanted.length} 名`);

  // ---- 断点续抓 ----
  let store = { source: 'hltv', sourceUrl: 'https://www.hltv.org/', fetchedAt: '', players: {} };
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prev?.players) store = { ...store, ...prev };
      console.log(`续抓：${OUT} 里已有 ${Object.keys(store.players).length} 名选手的记录`);
    } catch { /* 坏文件就当没有 */ }
  }
  fs.mkdirSync(AVATAR_DIR, { recursive: true });

  const todo = wanted.filter((p) => {
    if (FORCE) return true;
    const rec = store.players[p.id];
    if (!rec) return true;
    if (!rec.avatar) return false; // 明确查过头像但没有（404），不反复试
    return !fs.existsSync(path.join(AVATAR_DIR, path.basename(rec.avatar)));
  });
  const list = ONLY ? todo.slice(0, ONLY) : todo;
  if (!list.length) {
    console.log('没有需要补的选手，全部已就绪 ✅');
    return;
  }
  console.log(`本次要处理 ${list.length} 名选手（间隔 ${DELAY_MS}ms，预计 ${Math.ceil((list.length * (DELAY_MS + 900)) / 60000)} 分钟）\n`);

  console.log('启动浏览器 …', HEADLESS ? '（无头，Cloudflare 几乎必然拦住）' : '（有窗口，首次通过校验约需 20–40s）');
  const browser = await launchBrowser({ port: PORT, headless: HEADLESS });
  const cdp = await connect(browser.cdpUrl);
  await cdp.send('Network.enable').catch(() => {});

  /** url → requestId，用来把加载过的图片换成原始字节 */
  const imgReq = new Map();
  cdp.on('Network.responseReceived', (p) => {
    const u = p.response?.url || '';
    if (u.includes('playerbodyshot') || u.includes('img-cdn.hltv.org')) {
      imgReq.set(u, p.requestId);
    }
  });

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
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(store, null, 2));
  };

  let okAvatar = 0, failAvatar = 0, okTrophy = 0, failTrophy = 0, bytes = 0;
  const t0 = Date.now();

  try {
    /* 先落地一个 hltv.org 页面，拿到 Cloudflare 通行证 —— 后面所有 fetch 都靠它 */
    process.stdout.write('→ 打开 HLTV 排名页取通行证 … ');
    await cdp.goto(RANKING_URL, { timeout: 60000 }).catch(() => {});
    await waitFor(passed, { timeout: 100000, label: '通过 Cloudflare 校验' });
    console.log('ok\n');

    for (const [i, p] of list.entries()) {
      const tag = `[${i + 1}/${list.length}] ${p.nick}`.padEnd(30);
      process.stdout.write(`${tag} `);
      try {
        /* 1) 选手页：头像地址 + 冠军列表 */
        const info = await cdp.eval(EXTRACT_PLAYER(p.page));
        if (!info?.ok) {
          failTrophy++;
          console.log(`✗ 选手页取不到：${info?.err ?? '未知'}`);
          store.players[p.id] = { id: p.id, nick: p.nick, error: info?.err ?? 'unknown', trophies: [] };
          await sleep(DELAY_MS);
          continue;
        }
        okTrophy++;
        const reco = {
          id: p.id,
          nick: info.nick || p.nick,
          team: p.team,
          avatar: null,
          trophies: info.trophies ?? [],
        };

        /* 2) 头像：让浏览器加载 → 取原始字节 → 回页面缩小 → 写文件 */
        if (info.shot) {
          const loaded = await cdp.eval(LOAD_IMAGE(info.shot));
          if (loaded?.ok) {
            const rid = imgReq.get(info.shot);
            let raw = null;
            if (rid) {
              try {
                const body = await cdp.send('Network.getResponseBody', { requestId: rid });
                raw = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
              } catch (e) {
                raw = null;
                console.log(`(取字节失败: ${e.message.slice(0, 40)}) `);
              }
            }
            if (raw && raw.length > 1000) {
              const small = await cdp.eval(DOWNSCALE('data:image/webp;base64,' + raw.toString('base64')));
              const b64 = String(small).split(',')[1] || '';
              const out = Buffer.from(b64, 'base64');
              if (out.length > 500) {
                const rel = `avatars/${p.num}.webp`;
                fs.writeFileSync(path.join(AVATAR_DIR, `${p.num}.webp`), out);
                reco.avatar = rel;
                okAvatar++;
                bytes += out.length;
              }
            }
          } else {
            failAvatar++;
            reco.avatarError = loaded?.why ?? '加载失败';
          }
        } else {
          failAvatar++;
          reco.avatarError = '页面里没有头像地址';
        }

        store.players[p.id] = reco;
        const avg = okAvatar ? (bytes / okAvatar / 1024).toFixed(1) : '0';
        const eta = Math.ceil(((list.length - i - 1) * (DELAY_MS + (Date.now() - t0) / (i + 1))) / 60000);
        console.log(
          `冠军 ${String(reco.trophies.length).padStart(2)} 个 / 共 ${String(info.allBlocks).padStart(2)} 块` +
          `  头像 ${reco.avatar ? '✅' : '✗'} (均 ${avg}KB)  剩约 ${eta} 分钟`,
        );
      } catch (e) {
        failTrophy++;
        console.log(`✗ ${e.message}`);
      }

      if ((i + 1) % 10 === 0) save(); // 每 10 个落一次盘，中断也不白跑
      await sleep(DELAY_MS);
    }

    save();
    console.log(`\n写入 ${OUT}：${okTrophy} 名选手取到资料、${okAvatar} 张头像（共 ${(bytes / 1024 / 1024).toFixed(2)} MB，均 ${okAvatar ? (bytes / okAvatar / 1024).toFixed(1) : 0} KB）`);
    if (failAvatar) console.log(`⚠ ${failAvatar} 张头像没拿到（多半是那张图确实不存在或 CDN 抽风，重跑会自动重试记录里有 avatarError 的）`);
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
