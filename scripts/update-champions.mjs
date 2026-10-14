// Updates champions.json with today's champions, read from Wikipedia's
// "List of current champions" pages (AEW + ROH) through the official Wikipedia API.
//
// Run by .github/workflows/champions.yml. Node 20+, no packages needed.
//
// Each Wikipedia champion name is matched to the site's own name (so the right photo
// and stats page are used):
//   1. exact name match (accents, "The", "and"/"&" and punctuation ignored)
//   2. teams: the site team whose members are all among the Wikipedia champions
//   3. a shortened name that fits exactly one site name ("Andrade" → "Andrade El Idolo")
//   4. closest similar name, if it is close enough
//   5. otherwise the Wikipedia name is kept and the page shows initials
//
// Safety: if fewer than MIN_TITLES titles are read (e.g. Wikipedia changed its page
// layout), champions.json is left untouched and the run fails, so a bad read never
// replaces good data.

import { readFile, writeFile } from 'node:fs/promises';

const SOURCES = [
  { page: 'List_of_current_champions_in_All_Elite_Wrestling', promotion: 'AEW' },
  { page: 'List_of_current_champions_in_Ring_of_Honor', promotion: 'ROH' },
];
const MIN_TITLES = 8;
const FUZZY_THRESHOLD = 0.78;
const USER_AGENT = 'EliteWrestlerRatingsBot/1.0 (https://www.elitewrestlerratings.com; contact@elitewrestlerratings.com)';

// Wikipedia title name → the site's title name, where the simple
// "Championship → Title/Titles" rule isn't enough.
const TITLE_NAME_OVERRIDES = {
  'AEW World Championship': 'AEW World Heavyweight Title',
  'ROH World Championship': 'ROH World Heavyweight Title',
  'ROH World Six-Man Tag Team Championship': 'ROH World Six Man Tag Titles',
};

// Wikipedia champion name → site name, for any that the automatic matching gets wrong.
// Add a line here if a champion ever shows up with the wrong name or photo.
const NAME_OVERRIDES = {
  // 'Wikipedia name': 'Site name',
};

// ---------- helpers ----------
const decodeEntities = s => s
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

const cleanCellText = html => decodeEntities(
  html
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')          // footnote markers [1]
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();

const linkTexts = html => [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(m => cleanCellText(m[1]))
  .filter(t => t && !/^\[?\d+\]?$/.test(t));

export const normalizeName = s => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\band\b/g, '&')
  .replace(/^the\s+/, '')
  .replace(/[^a-z0-9&]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const createSlug = name => name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function similarity(a, b) {
  a = normalizeName(a); b = normalizeName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = levenshtein(a, b);
  const charScore = 1 - d / Math.max(a.length, b.length);
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  const shared = [...ta].filter(t => tb.has(t)).length;
  const tokenScore = shared / Math.max(ta.size, tb.size);
  return Math.max(charScore, tokenScore);
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

const titleKind = title => /trios|six[- ]man/i.test(title) ? 'trios' : /tag/i.test(title) ? 'tag' : 'singles';

function siteTitleName(wikiTitle, knownTitles) {
  if (TITLE_NAME_OVERRIDES[wikiTitle]) return TITLE_NAME_OVERRIDES[wikiTitle];
  const plural = titleKind(wikiTitle) === 'singles' ? 'Title' : 'Titles';
  const simple = wikiTitle.replace(/Championship$/, plural).replace(/Championships$/, 'Titles');
  if (!knownTitles.length || knownTitles.includes(simple)) return simple;
  // Fall back to the closest known site title name
  let best = simple, bestScore = 0;
  for (const t of knownTitles) {
    const sc = similarity(simple, t);
    if (sc > bestScore) { best = t; bestScore = sc; }
  }
  return bestScore >= 0.85 ? best : simple;
}

// ---------- Wikipedia ----------
async function fetchPageHtml(page) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2&redirects=1`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Wikipedia ${page}: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.parse || !data.parse.text) throw new Error(`Wikipedia ${page}: no page text`);
  return data.parse.text;
}

// Reads every table row that has a championship name in it. The champion is taken from
// the next cell after the championship name; the date won is the first cell that looks
// like a date. This doesn't depend on exact column order, so small layout changes on
// Wikipedia don't break it.
export function parseChampionRows(html, promotion) {
  const rows = [];
  const tables = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    for (const rowHtml of table.split(/<tr\b/i).slice(1)) {
      const cells = [...rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)(?=<\/?(?:td|th)\b|<\/tr>|$)/gi)]
        .map(m => ({ html: m[2], text: cleanCellText(m[2]) }));
      const titleIdx = cells.findIndex(c => /\bChampionships?\b/.test(c.text) && c.text.length < 80
        && (c.text.startsWith(promotion) || /^(AEW|ROH)\b/.test(c.text)));
      if (titleIdx === -1) continue;
      const titleText = cells[titleIdx].text.replace(/\s*\(.*\)$/, '').trim();
      const champCell = cells.slice(titleIdx + 1).find(c => c.text && !/^\d+$/.test(c.text));
      if (!champCell) continue;
      const dateCell = cells.find(c => /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/.test(c.text));
      const since = dateCell ? dateCell.text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/)[0] : null;
      const vacant = /^vacant\b/i.test(champCell.text);
      rows.push({
        wikiTitle: titleText,
        wikiChampion: vacant ? null : champCell.text,
        wikiLinks: vacant ? [] : linkTexts(champCell.html),
        since,
        vacant,
      });
    }
  }
  // One entry per title (first row wins)
  const seen = new Set();
  return rows.filter(r => !seen.has(r.wikiTitle) && seen.add(r.wikiTitle));
}

// ---------- name matching ----------
export function matchChampion(row, kind, wrestlersIndex, teamMembers) {
  if (row.vacant || !row.wikiChampion) return { name: null, slug: null, matchedBy: 'vacant', score: 0 };

  const full = row.wikiChampion;
  const base = full.replace(/\s*\(.*\)\s*$/, '').trim();          // "The Young Bucks (Matt and Nick)" → "The Young Bucks"
  const inBrackets = (full.match(/\(([^)]*)\)/) || [])[1] || '';
  const bracketNames = inBrackets.split(/\s*(?:,|&|\band\b)\s*/).map(s => s.trim()).filter(Boolean);
  const baseNames = base.split(/\s*(?:,|&|\band\b)\s*/).map(s => s.trim()).filter(Boolean);
  const people = [...new Set([...row.wikiLinks, ...bracketNames, ...baseNames])];

  const pool = wrestlersIndex.filter(w => kind === 'singles'
    ? !w.isTeam
    : w.isTeam && (kind === 'trios' ? w.division === 'Trios' : /Tag/.test(w.division)));
  const result = (w, matchedBy, score) => ({ name: w.name, slug: w.slug, matchedBy, score: Math.round(score * 100) / 100 });
  const rank = list => list.sort((a, b) => (b.isActive - a.isActive) || ((b.currentRating || 0) - (a.currentRating || 0)));

  const override = NAME_OVERRIDES[full] || NAME_OVERRIDES[base];
  if (override) {
    const w = wrestlersIndex.find(x => x.name === override);
    return w ? result(w, 'override', 1) : { name: override, slug: createSlug(override), matchedBy: 'override', score: 1 };
  }

  // 1. exact (normalised) name
  for (const candidate of [full, base]) {
    const hits = rank(pool.filter(w => normalizeName(w.name) === normalizeName(candidate)));
    if (hits.length) return result(hits[0], 'exact', 1);
  }

  // 2. teams: every member of a site team is among the Wikipedia champions
  if (kind !== 'singles' && teamMembers) {
    const peopleNorm = people.map(normalizeName);
    const isAmong = m => peopleNorm.some(p => p === normalizeName(m) || similarity(p, m) >= 0.9);
    const size = kind === 'trios' ? 3 : 2;
    const hits = rank(pool.filter(w => {
      const members = teamMembers[w.name];
      return members && members.length === size && members.every(isAmong);
    }));
    if (hits.length) return result(hits[0], 'members', 1);
  }

  // 3. a shortened name that fits exactly one site name ("Andrade" → "Andrade El Idolo")
  const tokens = n => normalizeName(n).split(' ').filter(Boolean);
  const baseTokens = tokens(base);
  if (baseTokens.length) {
    const subsetHits = pool.filter(w => {
      const wt = new Set(tokens(w.name));
      return baseTokens.every(t => wt.has(t));
    });
    if (subsetHits.length === 1) return result(subsetHits[0], 'closest', 0.85);
  }

  // 4. closest similar name
  let best = null, bestScore = 0;
  for (const w of pool) {
    const sc = Math.max(similarity(full, w.name), similarity(base, w.name));
    if (sc > bestScore || (sc === bestScore && best && w.isActive && !best.isActive)) { best = w; bestScore = sc; }
  }
  if (best && bestScore >= FUZZY_THRESHOLD) return result(best, 'closest', bestScore);

  // 5. no good match — keep Wikipedia's name (page shows initials)
  return { name: base, slug: null, matchedBy: 'none', score: Math.round(bestScore * 100) / 100 };
}

// ---------- main ----------
export async function main() {
  const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
  const wrestlersIndex = await readJson('wrestlers/index.json');
  const teamMembers = (await readJson('team-members.json')).teams || {};
  let knownTitles = [];
  try { knownTitles = (await readJson('championship-competitors.json')).titles.map(t => t.title); } catch {}

  const champions = {};
  const problems = [];
  for (const src of SOURCES) {
    let rows = [];
    try {
      rows = parseChampionRows(await fetchPageHtml(src.page), src.promotion);
    } catch (e) {
      problems.push(e.message);
      continue;
    }
    for (const row of rows) {
      const title = siteTitleName(row.wikiTitle, knownTitles);
      const match = matchChampion(row, titleKind(title), wrestlersIndex, teamMembers);
      champions[title] = {
        champion: match.name,
        slug: match.slug,
        isTeam: titleKind(title) !== 'singles',
        since: row.since,
        wikiTitle: row.wikiTitle,
        wikiChampion: row.wikiChampion,
        matchedBy: match.matchedBy,
        matchScore: match.score,
      };
      console.log(`${title.padEnd(42)} ${String(match.name).padEnd(34)} (${match.matchedBy}${match.matchedBy === 'closest' ? ' ' + match.score : ''}) ← ${row.wikiChampion}`);
    }
  }

  const count = Object.keys(champions).length;
  if (count < MIN_TITLES) {
    console.error(`❌ Only ${count} titles read — champions.json NOT updated. ${problems.join(' | ')}`);
    process.exit(1);
  }
  const unmatched = Object.entries(champions).filter(([, c]) => c.matchedBy === 'none').map(([t, c]) => `${t}: ${c.wikiChampion}`);
  if (unmatched.length) console.warn(`⚠️ No site match (initials will show):\n  ${unmatched.join('\n  ')}`);

  // Only rewrite the file when a champion actually changed, so the commit history stays clean
  let previous = null;
  try { previous = await readJson('champions.json'); } catch {}
  if (previous && JSON.stringify(previous.champions) === JSON.stringify(champions)) {
    console.log('No champion changes.');
    return;
  }
  const out = {
    updated: new Date().toISOString().slice(0, 10),
    source: 'Wikipedia — List of current champions (AEW, ROH)',
    champions,
  };
  await writeFile('champions.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`✅ champions.json updated (${count} titles).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
