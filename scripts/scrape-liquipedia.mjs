/**
 * Liquipedia 抓取器
 * ------------------------------------------------------------------
 * 数据源: https://liquipedia.net/counterstrike
 *  - Portal:Teams  → 按赛区列出「现役」战队（排除女子队/青训队）
 *  - 各队页面      → {{Infobox team}} 的 location/region + {{Squad|status=active}}
 *                    中的 {{Person|flag=..|id=..|name=..}} 得到现役阵容
 *
 * Liquipedia API 限速：串行请求，间隔 >= 2s。本脚本遵守该限制。
 * 用法:
 *   node scripts/scrape-liquipedia.mjs            # 全量
 *   node scripts/scrape-liquipedia.mjs --limit 40 # 只抓前 40 队（调试）
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://liquipedia.net/counterstrike/api.php';
const UA = 'CS2ProMap/0.2 (https://github.com/local/cs2-pro-map; educational data-visualization prototype)';
const OUT_DIR = 'data';
const THROTTLE = 2100; // ms，遵守 Liquipedia 的 1 req / 2s
const BATCH = 50; // 一次 action=query 可取的页面数上限

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(params, { retries = 3 } = {}) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${API}?${q}`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(90000),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`API: ${j.error.info}`);
      return j;
    } catch (e) {
      if (attempt === retries) throw e;
      log(`  重试 ${attempt}/${retries - 1} (${e.message})`);
      await sleep(4000 * attempt);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 花括号配平：从 text[start] 处的 "{{" 取出完整模板字符串
 * ------------------------------------------------------------------ */
function matchTemplate(text, start) {
  if (text[start] !== '{' || text[start + 1] !== '{') return null;
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; continue; }
    if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** 按顶层 "|" 切分模板参数（跳过 {{...}} 与 [[...]] 内部） */
function splitParams(tpl) {
  const inner = tpl.slice(2, -2);
  const out = [];
  let buf = '';
  let tb = 0; // {{ }} 深度
  let sb = 0; // [[ ]] 深度
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{' && inner[i + 1] === '{') { tb++; buf += '{{'; i++; continue; }
    if (c === '}' && inner[i + 1] === '}') { tb--; buf += '}}'; i++; continue; }
    if (c === '[' && inner[i + 1] === '[') { sb++; buf += '[['; i++; continue; }
    if (c === ']' && inner[i + 1] === ']') { sb--; buf += ']]'; i++; continue; }
    if (c === '|' && tb === 0 && sb === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

/** 模板参数 → { k: v }，无名参数放到 _ 数组 */
function parseParams(tpl) {
  const parts = splitParams(tpl);
  const named = {};
  const positional = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf('=');
    if (eq > 0 && /^[A-Za-z0-9_\- ]+$/.test(p.slice(0, eq))) named[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    else positional.push(p.trim());
  }
  return { named, positional };
}

/**
 * 页面标题归一化：Portal 的 href 给的是 `Team_Vitality`，
 * 而 API 返回的是 `Team Vitality`（重定向后还可能变成另一个名字），
 * 所以查表前统一成小写 + 空格。
 */
function normPage(t) {
  return decodeURIComponent(String(t))
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 去掉 wiki 标记，得到纯文本 */
function clean(s) {
  if (!s) return '';
  return s
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{abbr\|([^|]*)\|[^}]*\}\}/gi, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取出「Player Roster」段里 CS2 那一页的内容。
 * 队伍页通常是 {{Tabs dynamic |name1=CS2 |name2=CS:GO |content1=.. |content2=..}}，
 * 但也可能没有 tab，或 tab 顺序不同，所以按 nameN 找 CS2，找不到再退回 content1。
 */
function cs2Section(wikitext) {
  const rosterIdx = wikitext.search(/==\s*Player Roster\s*==/i);
  const scope = rosterIdx >= 0 ? wikitext.slice(rosterIdx) : wikitext;

  const tabsIdx = scope.search(/\{\{\s*Tabs dynamic/i);
  if (tabsIdx < 0) return scope;

  const tpl = matchTemplate(scope, tabsIdx);
  if (!tpl) return scope;

  const { named } = parseParams(tpl);
  // 找出 nameN 里写着 CS2 的那一页
  let pick = null;
  for (const [k, v] of Object.entries(named)) {
    const m = k.match(/^name(\d+)$/);
    if (!m) continue;
    if (/cs2|counter-?strike\s*2/i.test(v)) { pick = m[1]; break; }
  }
  if (pick && named[`content${pick}`] != null) return named[`content${pick}`];
  if (named.content1 != null) return named.content1;
  return scope;
}

/** 从队伍页 wikitext 解析出现役阵容 + 队伍元信息 */
function parseTeam(title, wikitext, portalSection = '') {
  const team = {
    page: title, name: title, location: '', region: portalSection,
    portalSection, logo: null, players: [],
  };

  const infoboxStart = wikitext.search(/\{\{\s*Infobox team/i);
  if (infoboxStart >= 0) {
    const tpl = matchTemplate(wikitext, infoboxStart);
    if (tpl) {
      const { named } = parseParams(tpl);
      team.name = clean(named.name) || title;
      team.location = clean(named.location);
      team.infoboxRegion = (named.region || '').trim().toLowerCase();
      team.logo = named.image ? named.image.trim() : named.imagedark ? named.imagedark.trim() : null;
    }
  }

  const seg = cs2Section(wikitext);
  // 找第一个 status=active 的 {{Squad}}（宽松匹配模板头，再核对 status 参数）
  const squadRe = /\{\{\s*Squad\b/gi;
  let m;
  while ((m = squadRe.exec(seg))) {
    const squad = matchTemplate(seg, m.index);
    if (!squad) continue;
    const { named } = parseParams(squad);
    if ((named.status || 'active').toLowerCase() !== 'active') continue;

    for (const p of splitParams(squad)) {
      const pi = p.indexOf('{{Person');
      if (pi < 0) continue;
      const personTpl = matchTemplate(p, pi);
      if (!personTpl) continue;
      const pp = parseParams(personTpl).named;
      const role = (pp.role || '').toLowerCase();
      if (role.includes('coach') || role.includes('manager') || role.includes('analyst')) continue;
      const id = clean(pp.id);
      if (!id) continue;
      team.players.push({
        id,
        name: clean(pp.name),
        flag: (pp.flag || '').trim().toLowerCase(),
        role: role || 'player',
        igl: pp.igl === 'y' || pp.igl === '1',
        joindate: clean(pp.joindate).slice(0, 10),
      });
    }
    break; // 只要第一段现役阵容
  }
  return team;
}

/* ------------------------------------------------------------------ *
 * 1. 取 Portal:Teams 的渲染 HTML（这样 {{Team|x}} 别名会被解析成真实页面链接）
 * ------------------------------------------------------------------ */
async function fetchPortal() {
  log('拉取 Portal:Teams …');
  const j = await api({ action: 'parse', page: 'Portal:Teams', prop: 'text', disablelimitreport: '1' });
  const html = j.parse.text;
  fs.mkdirSync(path.join(OUT_DIR, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'raw', 'portal-teams.html'), html);

  const body = html.slice(html.indexOf('mw-parser-output'));
  const tokens = body.split(/(<h[234][^>]*>[\s\S]*?<\/h[234]>|<li>[\s\S]*?<\/li>)/g);
  const SKIP_SECTION = /disbanded|women|academy|inactive/i;

  const groups = new Map();
  let section = '';
  for (const tk of tokens) {
    const h = tk.match(/^<h[234][^>]*>([\s\S]*?)<\/h[234]>$/);
    if (h) { section = clean(h[1]).replace(/\[edit\]/i, '').trim(); continue; }
    if (!tk.startsWith('<li>')) continue;
    if (!section || SKIP_SECTION.test(section)) continue;
    const links = [...tk.matchAll(/href="\/counterstrike\/([^"#?]+)"/g)].map((m) => decodeURIComponent(m[1]));
    if (!links.length) continue;
    // {{Team|..}} 通常渲染成 li 里唯一的队伍链接
    const page = links.find((l) => !l.includes(':')) ?? links[0];
    if (!page || page.startsWith('Special:')) continue;
    if (!groups.has(section)) groups.set(section, new Map());
    groups.get(section).set(page, true);
  }

  const bySection = {};
  const pageToSection = new Map();
  const all = new Set();
  for (const [sec, m] of groups) {
    bySection[sec] = [...m.keys()].sort();
    bySection[sec].forEach((p) => {
      all.add(p);
      const k = normPage(p);
      if (!pageToSection.has(k)) pageToSection.set(k, sec);
    });
  }
  return { bySection, pageToSection, all: [...all].sort() };
}

/* ------------------------------------------------------------------ *
 * 2. 批量取队伍页 wikitext
 * ------------------------------------------------------------------ */
async function fetchPages(titles) {
  const out = new Map();
  const aliases = new Map(); // 归一化后的重定向源 → 归一化后的真实标题
  const chunks = [];
  for (let i = 0; i < titles.length; i += BATCH) chunks.push(titles.slice(i, i + BATCH));

  for (let c = 0; c < chunks.length; c++) {
    const titlesParam = chunks[c].join('|');
    const j = await api({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: titlesParam,
      redirects: '1',
    });
    for (const r of j.query?.redirects ?? []) aliases.set(normPage(r.from), normPage(r.to));
    for (const n of j.query?.normalized ?? []) aliases.set(normPage(n.from), normPage(n.to));
    for (const p of j.query?.pages ?? []) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      if (content && !p.missing) out.set(p.title, content);
    }
    log(`  页面 ${Math.min((c + 1) * BATCH, titles.length)}/${titles.length}（累计 ${out.size} 篇）`);
    if (c < chunks.length - 1) await sleep(THROTTLE);
  }
  return { pages: out, aliases };
}

/* ------------------------------------------------------------------ */
const portal = await fetchPortal();
const allTeams = portal.all.slice(0, LIMIT === Infinity ? undefined : LIMIT);
log(`赛区数 ${Object.keys(portal.bySection).length}，现役战队 ${portal.all.length} 支，本次抓取 ${allTeams.length} 支`);

await sleep(THROTTLE);
const { pages, aliases } = await fetchPages(allTeams);

/** 赛区查表：先用真实标题查，再用「重定向源标题」兜底 */
const reverseAliases = new Map(); // 目标标题 → 曾在 Portal 上出现过的源标题
for (const [from, to] of aliases) if (!reverseAliases.has(to)) reverseAliases.set(to, from);
function sectionOf(title) {
  const k = normPage(title);
  const viaSource = reverseAliases.has(k) ? portal.pageToSection.get(reverseAliases.get(k)) : undefined;
  return portal.pageToSection.get(k) ?? viaSource ?? '';
}

const teams = [];
const emptyTeams = [];
for (const [title, wt] of pages) {
  try {
    const t = parseTeam(title, wt, sectionOf(title));
    if (t.players.length) teams.push(t);
    else emptyTeams.push(title);
  } catch (e) {
    log(`  解析失败 ${title}: ${e.message}`);
  }
}

const dataset = {
  source: 'liquipedia',
  sourceUrl: 'https://liquipedia.net/counterstrike/Portal:Teams',
  license: 'Liquipedia content is available under CC-BY-SA 3.0',
  fetchedAt: new Date().toISOString(),
  sections: portal.bySection,
  teams,
  emptyTeams,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'liquipedia.json'), JSON.stringify(dataset, null, 2));
const nPlayers = teams.reduce((a, t) => a + t.players.length, 0);
log(`完成：${teams.length} 支战队 / ${nPlayers} 名现役选手 → data/liquipedia.json`);
