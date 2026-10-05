/**
 * 国家名 / 旗帜名 → ISO 3166-1 alpha-2
 * ------------------------------------------------------------------
 * HLTV 的国旗给的是国名（alt="Denmark"、class="flag flag-dk"），
 * 而 dataset 全流程统一用两字母码，所以这里做一次翻译。
 * 数据源：data/countries.raw.json（build-dataset.mjs 已经下载缓存过）
 */
import fs from 'node:fs';

const CACHE = 'data/countries.raw.json';

/* HLTV / 常见写法与 world-countries 不一致的，手工兜底 */
const ALIAS = {
  'czech republic': 'cz',
  czechia: 'cz',
  turkey: 'tr',
  türkiye: 'tr',
  turkiye: 'tr',
  russia: 'ru',
  'south korea': 'kr',
  korea: 'kr',
  'republic of korea': 'kr',
  'north macedonia': 'mk',
  macedonia: 'mk',
  'bosnia and herzegovina': 'ba',
  kosovo: 'xk',
  'united states': 'us',
  'united states of america': 'us',
  usa: 'us',
  'united kingdom': 'gb',
  'great britain': 'gb',
  england: 'gb',
  scotland: 'gb',
  wales: 'gb',
  'northern ireland': 'gb',
  netherlands: 'nl',
  'the netherlands': 'nl',
  holland: 'nl',
  'south africa': 'za',
  'saudi arabia': 'sa',
  'united arab emirates': 'ae',
  'hong kong': 'hk',
  taiwan: 'tw',
  'chinese taipei': 'tw',
  vietnam: 'vn',
  'viet nam': 'vn',
  moldova: 'md',
  'ivory coast': 'ci',
  'cape verde': 'cv',
  'democratic republic of the congo': 'cd',
  'republic of the congo': 'cg',
  palestine: 'ps',
  'dominican republic': 'do',
  'puerto rico': 'pr',
  'trinidad and tobago': 'tt',
  'el salvador': 'sv',
  'costa rica': 'cr',
};

function normalize(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const table = new Map();

function add(key, code) {
  const k = normalize(key);
  if (k && !table.has(k)) table.set(k, code);
}

let loaded = false;
export function loadCountries() {
  if (loaded) return table;
  loaded = true;
  for (const [k, v] of Object.entries(ALIAS)) add(k, v);
  if (!fs.existsSync(CACHE)) return table;
  const list = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  for (const c of list) {
    const code = c.cca2?.toLowerCase();
    if (!code) continue;
    add(c.name?.common, code);
    add(c.name?.official, code);
    add(c.translations?.zho?.common, code);
    for (const s of c.altSpellings ?? []) add(s, code);
  }
  return table;
}

/**
 * 把 HLTV 的国名/旗帜标识转成两字母码。
 * 接受："Denmark" / "flag-dk" / "dk" / 空值
 */
export function toCode(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (/^flag-([a-z]{2})$/i.test(s)) return s.slice(5).toLowerCase();
  if (/^[a-z]{2}$/i.test(s)) return s.toLowerCase();
  return loadCountries().get(normalize(s)) || '';
}
