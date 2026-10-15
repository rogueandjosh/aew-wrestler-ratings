// Updates champions.json from Wikipedia, through the official Wikipedia API:
//   • today's champions — from the "List of current champions" pages (AEW + ROH)
//   • each title's full reign history — from its "List of … Champions" page (or the
//     title's own article), so the championships page can show who held each title
//     in any archive week, plus the 3 champions before them
//   • each archive week's end date — from the site's own archive/*.json "dateRange",
//     used to match a week to the reign that covered it
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
// New titles are picked up automatically: every title found in the site's own data
// (championship-competitors.json, current-championship-rankings.json and the championship
// archive) is looked up — first by the usual Wikipedia page names, then with a Wikipedia
// search if those don't exist. Interim titles are matched to their main title the same way.
// The lists below are only shortcuts/corrections for names that can't be worked out.
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
const REQUEST_GAP_MS = 300;            // be polite to Wikipedia between page requests
const FUZZY_THRESHOLD = 0.78;
const USER_AGENT = 'EliteWrestlerRatingsBot/1.0 (https://www.elitewrestlerratings.com; contact@elitewrestlerratings.com)';

// Wikipedia title name → the site's title name, where the simple
// "Championship → Title/Titles" rule isn't enough.
const TITLE_NAME_OVERRIDES = {
  'AEW World Championship': 'AEW World Heavyweight Title',
  'ROH World Championship': 'ROH World Heavyweight Title',
  'ROH World Six-Man Tag Team Championship': 'ROH World Six Man Tag Titles',
  'ROH World Television Championship': 'ROH World TV Title',
  "ROH Women's World Television Championship": "ROH Women's TV Title",
};

// Titles that aren't on the AEW/ROH "current champions" pages but whose history should
// still be read (site title → Wikipedia title). Add more here, e.g. other promotions' titles.
const EXTRA_HISTORY_TITLES = {
  'FTW Title': 'FTW Championship',
  'AEW American Title': 'AEW American Championship',
  // AAA
  'AAA Mega Title': 'AAA Mega Championship',
  'AAA Latin American Title': 'AAA Latin American Championship',
  'AAA World Tag Team Titles': 'AAA World Tag Team Championship',
  // CMLL
  'CMLL World Heavyweight Title': 'CMLL World Heavyweight Championship',
  "CMLL Women's World Title": "CMLL World Women's Championship",
  'CMLL World Trios Titles': 'CMLL World Trios Championship',
  // NJPW
  'IWGP World Heavyweight Title': 'IWGP World Heavyweight Championship',
  'IWGP Global Heavyweight Title': 'IWGP Global Heavyweight Championship',
  'IWGP United States Title': 'IWGP United States Heavyweight Championship',
  'IWGP Tag Team Titles': 'IWGP Tag Team Championship',
  'NJPW World TV Title': 'NJPW World Television Championship',
  'NJPW STRONG Openweight Title': 'Strong Openweight Championship',
  "NJPW STRONG Women's Title": "Strong Women's Championship",
  // Impact / TNA (Wikipedia now files these under TNA — its redirects are followed)
  'Impact World Title': 'TNA World Championship',
  'Impact World Tag Team Titles': 'TNA World Tag Team Championship',
  // Others
  "NWA World Women's Title": "NWA World Women's Championship",
  'Regina Di WAVE Title': 'Regina di WAVE Championship',
  "RevPro Undisputed British Women's Title": "Undisputed British Women's Championship",
};

// Interim titles: read from the main title's history, using only its interim reigns
// (Wikipedia lists them as "Name (Interim)" in the main title's table).
const INTERIM_TITLES = {
  'AEW Interim World Title': 'AEW World Heavyweight Title',
  'AEW Interim TNT Title': 'AEW TNT Title',
  "ROH Interim Women's TV Title": "ROH Women's TV Title",
};

// Reigns that began before this date are from before the site's data starts (AEW's first
// show) — only exact or team-member matches are used for those, never "closest" guesses,
// so an old ROH champion can't be mistaken for a current wrestler with a similar name.
const SITE_DATA_STARTS = '2019-05-01';

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
async function fetchPageHtml(page, { allowMissing = false } = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2&redirects=1`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Wikipedia ${page}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error && allowMissing) return null;           // e.g. page doesn't exist
  if (!data.parse || !data.parse.text) throw new Error(`Wikipedia ${page}: no page text`);
  return data.parse.text;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- dates ----------
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DATE_US = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})\\b`);           // August 30, 2026
const DATE_UK = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'g'); // 30 August 2026 / 30th August 2026
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function toIsoDate(text) {
  if (!text) return null;
  const us = text.match(DATE_US);
  if (us) return iso(us[3], MONTHS.indexOf(us[1]) + 1, us[2]);
  const uk = [...text.matchAll(DATE_UK)][0];
  if (uk) return iso(uk[3], MONTHS.indexOf(uk[2]) + 1, uk[1]);
  return null;
}

// "4th September 2024 to 10th September 2024" / "7th to 13th October 2026" → last full date
export function weekEndFromRange(range) {
  const all = [...(range || '').matchAll(DATE_UK)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  return iso(last[3], MONTHS.indexOf(last[2]) + 1, last[1]);
}

// ---------- reign history ----------
// Reads a title's reigns table. Rows are found by their date: the champion is the cell
// just before the first date in the row (No. | Champion | Date | Event | …). Vacancies
// are kept as markers (they end the previous reign) and interim reigns are skipped.
// The table with the most reign rows wins, so "combined reigns" and other tables are ignored.
export function parseReignRows(html, { interimOnly = false } = {}) {
  const tables = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/gi) || [];
  let best = [];
  for (const table of tables) {
    if (!/Champion/i.test(table)) continue;
    const reigns = [];
    for (const rowHtml of table.split(/<tr\b/i).slice(1)) {
      const cells = [...rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)(?=<\/?(?:td|th)\b|<\/tr>|$)/gi)]
        .map(m => ({ html: m[2], text: cleanCellText(m[2]) }));
      const dateIdx = cells.findIndex(c => toIsoDate(c.text));
      if (dateIdx < 1) continue;
      const champ = cells[dateIdx - 1];
      if (!champ.text || /^[\d—–-]+$/.test(champ.text)) continue;
      const isInterim = /\binterim\b/i.test(champ.text);
      if (interimOnly !== isInterim) continue;
      if (isInterim) champ.text = champ.text.replace(/\s*\(?\binterim\b\)?/ig, '').trim();
      const vacant = /^(vacat|deactivat|retired|unified|abandon)/i.test(champ.text);
      reigns.push({
        start: toIsoDate(cells[dateIdx].text),
        vacant,
        wikiChampion: vacant ? null : champ.text,
        wikiLinks: vacant ? [] : linkTexts(champ.html),
      });
    }
    if (reigns.length > best.length) best = reigns;
  }
  // Oldest first, without duplicates
  const seen = new Set();
  return best
    .filter(r => { const k = r.start + '|' + r.wikiChampion; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Site title → Wikipedia page names to try for its history
function historyPageCandidates(siteTitle, wikiTitle) {
  const reverse = Object.fromEntries(Object.entries(TITLE_NAME_OVERRIDES).map(([w, s]) => [s, w]));
  const wiki = wikiTitle || reverse[siteTitle] || siteTitle.replace(/\s+Titles?$/, ' Championship');
  const base = wiki.replace(/\s+Championship$/, '');
  return [`List of ${base} Champions`, `List of ${base} champions`, wiki];
}

// Wikipedia search, used when the usual page names don't exist (e.g. a newly added title
// whose Wikipedia page has a slightly different name). Returns page titles, best first.
async function searchWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const data = await res.json();
  return ((data.query && data.query.search) || [])
    .map(r => r.title)
    .filter(t => /champion/i.test(t));          // only championship / champions pages
}

// Main title for an interim title: "AEW Interim World Title" → "AEW World Heavyweight Title"
function interimParent(title, siteTitles) {
  if (INTERIM_TITLES[title]) return INTERIM_TITLES[title];
  const without = title.replace(/\binterim\s+/i, '');
  let best = null, bestScore = 0;
  for (const t of siteTitles) {
    if (/\binterim\b/i.test(t)) continue;
    const sc = similarity(without, t);
    if (sc > bestScore) { best = t; bestScore = sc; }
  }
  return bestScore >= 0.6 ? best : null;
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
// Removes ring nicknames in quotes and titles like Mr./Dr./D.M.D. before matching:
// '"Hangman" Adam Page' → 'Adam Page', 'Dr. Britt Baker, D.M.D.' → 'Britt Baker'
export function stripNicknames(name) {
  return (name || '')
    .replace(/["“”][^"“”]*["“”]\s*/g, '')
    .replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, '')
    .replace(/,?\s*D\.?M\.?D\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The people Wikipedia names in brackets after a team: "The Elite (Adam Page, Matt
// Jackson, and Nick Jackson)" → ["Adam Page", "Matt Jackson", "Nick Jackson"]
export function bracketPeople(wikiChampion) {
  const inBrackets = (stripNicknames(wikiChampion || '').match(/\(([^)]*)\)/) || [])[1] || '';
  return inBrackets.split(/\s*(?:,|&|\band\b)\s*/).map(s => s.trim()).filter(Boolean);
}

// true if the person `m` is one of `names` (exact, near-identical, or all of their name's words)
// ---------- people: Wikipedia's spelling → the site's name ----------
// Set once in main() (and in tests): every individual on the site, and every name that
// appears in name-changes.json.
let siteSinglesNames = [];
let nameChangeNames = new Set();
export function setSiteContext(wrestlersIndex, nameChanges = []) {
  siteSinglesNames = wrestlersIndex.filter(w => !w.isTeam).map(w => w.name);
  nameChangeNames = new Set(nameChanges.flatMap(c => [c.oldName, c.newName]));
}

// Turns Wikipedia's spelling of a person into the name the site uses, so the right photo
// and page are found:
//   "Penta El Zero Miedo" → "Penta El Zero M"   (site name is an abbreviation of it)
//   "Fénix"               → "Rey Fenix"         (the only site name containing all its words)
//   "Pentagón Jr."        → "Pentagon Jr."      (accents ignored)
// Names from name-changes.json count as site names too. Unknown people are left as they are.
export function resolvePerson(name) {
  const clean = stripNicknames(name || '');
  const norm = normalizeName(clean);
  if (!norm) return clean;
  const pool = [...new Set([...siteSinglesNames, ...nameChangeNames])];
  const exact = pool.find(n => normalizeName(n) === norm);
  if (exact) return exact;

  const tokens = norm.split(' ');
  // site name is an abbreviation: same number of words, each a start of Wikipedia's word
  const abbrev = pool.filter(n => {
    const nt = normalizeName(n).split(' ');
    return nt.length === tokens.length && nt.every((t, i) => tokens[i].startsWith(t));
  });
  if (abbrev.length === 1) return abbrev[0];

  // all of Wikipedia's words appear in exactly one site name
  const subset = pool.filter(n => {
    const nt = new Set(normalizeName(n).split(' '));
    return tokens.every(t => nt.has(t));
  });
  if (subset.length === 1) return subset[0];

  // very close spelling
  let best = null, bestScore = 0, tie = false;
  for (const n of pool) {
    const sc = similarity(clean, n);
    if (sc > bestScore) { best = n; bestScore = sc; tie = false; } else if (sc === bestScore) tie = true;
  }
  return best && bestScore >= 0.85 && !tie ? best : clean;
}

// true if the person `m` is one of `names` (exact, near-identical, all of their name's
// words, or the same site person once Wikipedia's spelling is resolved)
function personAmong(m, names) {
  const mNorm = normalizeName(m);
  const mTokens = mNorm.split(' ');
  return names.some(raw => {
    const p = normalizeName(raw);
    return p === mNorm || similarity(p, m) >= 0.9
      || (mTokens.length >= 2 && mTokens.every(t => p.split(' ').includes(t)))     // "Hangman" Adam Page
      || normalizeName(resolvePerson(raw)) === mNorm;                               // Penta El Zero Miedo
  });
}

// Team members to show photos for: the site's own list for the matched team (when it agrees
// with Wikipedia), otherwise the people Wikipedia names — each matched to the site's own
// spelling where there's an exact match.
export function teamMembersFor(row, matchedName, kind, wrestlersIndex, teamMembers) {
  if (kind === 'singles' || row.vacant) return [];
  const size = kind === 'trios' ? 3 : 2;
  const named = bracketPeople(row.wikiChampion);
  const siteList = matchedName && teamMembers ? teamMembers[matchedName] : null;
  if (siteList && siteList.length === size && (named.length < 2 || siteList.every(m => personAmong(m, named)))) return siteList;
  const singles = wrestlersIndex.filter(w => !w.isTeam);
  const base = normalizeName(stripNicknames(row.wikiChampion || '').replace(/\s*\(.*\)\s*$/, ''));
  const people = named.length >= 2 ? named : (row.wikiLinks || []).map(stripNicknames)
    .filter(n => n && normalizeName(n) !== base && !wrestlersIndex.some(w => w.isTeam && normalizeName(w.name) === normalizeName(n)));
  const siteNames = people.map(resolvePerson);
  return siteNames.length >= 2 ? [...new Set(siteNames)].slice(0, size) : [];
}

export function matchChampion(row, kind, wrestlersIndex, teamMembers, { allowGuesses = true } = {}) {
  if (row.vacant || !row.wikiChampion) return { name: null, slug: null, matchedBy: 'vacant', score: 0 };

  const full = stripNicknames(row.wikiChampion);
  const base = full.replace(/\s*\(.*\)\s*$/, '').trim();          // "The Young Bucks (Matt and Nick)" → "The Young Bucks"
  const inBrackets = (full.match(/\(([^)]*)\)/) || [])[1] || '';
  const bracketNames = inBrackets.split(/\s*(?:,|&|\band\b)\s*/).map(s => s.trim()).filter(Boolean);
  const baseNames = base.split(/\s*(?:,|&|\band\b)\s*/).map(s => s.trim()).filter(Boolean);
  const people = [...new Set([...row.wikiLinks.map(stripNicknames), ...bracketNames, ...baseNames])];

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

  // 1. exact (normalised) name in this title's division
  const exactIn = list => {
    const candidates = kind === 'singles' ? [full, base, resolvePerson(base)] : [full, base];
    for (const candidate of candidates) {
      const hits = rank(list.filter(w => normalizeName(w.name) === normalizeName(candidate)));
      if (hits.length) return hits[0];
    }
    return null;
  };
  // A team name can be reused by different line-ups (e.g. "The Elite" was Omega & the Bucks
  // and later Page & the Bucks), so an exact name only counts if its members agree with
  // the people Wikipedia names in brackets
  const namedPeople = bracketPeople(row.wikiChampion);
  const teamAgrees = w => {
    if (kind === 'singles' || namedPeople.length < 2 || !teamMembers || !teamMembers[w.name]) return true;
    return teamMembers[w.name].every(m => personAmong(m, namedPeople));
  };
  const exact = exactIn(pool);
  if (exact && teamAgrees(exact)) return result(exact, 'exact', 1);

  // 2. teams: every member of a site team is among the Wikipedia champions
  if (kind !== 'singles' && teamMembers) {
    const isAmong = m => personAmong(m, people);
    const size = kind === 'trios' ? 3 : 2;
    const hits = rank(pool.filter(w => {
      const members = teamMembers[w.name];
      return members && members.length === size && members.every(isAmong);
    }));
    if (hits.length) return result(hits[0], 'members', 1);
  }

  // 2b. exact name anywhere else on the site (e.g. a team listed under Men's Tag
  //     that held a six-man title)
  const wider = kind === 'singles' ? wrestlersIndex.filter(w => !w.isTeam) : wrestlersIndex.filter(w => w.isTeam);
  const exactWider = exactIn(wider);
  if (exactWider && teamAgrees(exactWider)) return result(exactWider, 'exact', 1);

  // Older reigns (before the site's data) stop here — no guessing
  if (!allowGuesses) return { name: base, slug: null, matchedBy: 'none', score: 0 };

  // 3. singles: a shortened name that fits exactly one site name ("Andrade" → "Andrade El Idolo")
  const tokens = n => normalizeName(n).split(' ').filter(Boolean);
  const baseTokens = tokens(base);
  if (kind === 'singles' && baseTokens.length) {
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
  // Teams need a much closer name than people — "The Righteous" must not become "Righteous & Archer"
  const threshold = kind === 'singles' ? FUZZY_THRESHOLD : 0.9;
  if (best && bestScore >= threshold) return result(best, 'closest', bestScore);

  // 5. no good match — keep Wikipedia's name (page shows initials)
  return { name: base, slug: null, matchedBy: 'none', score: Math.round(bestScore * 100) / 100 };
}

// ---------- main ----------
export async function main() {
  const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
  const wrestlersIndex = await readJson('wrestlers/index.json');
  const teamMembers = (await readJson('team-members.json')).teams || {};
  let nameChanges = [];
  try { nameChanges = (await readJson('name-changes.json')).changes || []; } catch {}
  setSiteContext(wrestlersIndex, nameChanges);
  // Every title the site has ever shown — so any new title is looked up automatically
  const knownTitleSet = new Set();
  try { (await readJson('championship-competitors.json')).titles.forEach(t => knownTitleSet.add(t.title)); } catch {}
  try { (await readJson('current-championship-rankings.json')).championships.forEach(c => knownTitleSet.add(c.title)); } catch {}
  try {
    const champIndex = await readJson('championship-archive/index.json');
    for (const w of champIndex.weeks || []) {
      try {
        const wk = await readJson(`championship-archive/${w.file}`);
        [...(wk.championships || []), ...(wk.droppedOut || [])].forEach(c => c.title && knownTitleSet.add(c.title));
      } catch {}
    }
  } catch {}
  const knownTitles = [...knownTitleSet];

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
        members: teamMembersFor(row, match.name, titleKind(title), wrestlersIndex, teamMembers),
        since: row.since,
        wikiTitle: row.wikiTitle,
        wikiChampion: row.wikiChampion,
        matchedBy: match.matchedBy,
        matchScore: match.score,
      };
      console.log(`${title.padEnd(42)} ${String(match.name).padEnd(34)} (${match.matchedBy}${match.matchedBy === 'closest' ? ' ' + match.score : ''}) ← ${row.wikiChampion}`);
    }
  }

  // ----- reign history for every title the site knows about (AEW/ROH incl. retired,
  //       interim titles, and the other promotions' titles listed above) -----
  const historyTitles = new Map();   // site title → Wikipedia title (if known)
  for (const [title, c] of Object.entries(champions)) historyTitles.set(title, c.wikiTitle);
  for (const [t, wiki] of Object.entries(EXTRA_HISTORY_TITLES)) if (!historyTitles.has(t)) historyTitles.set(t, wiki);
  for (const t of knownTitles) if (!historyTitles.has(t)) historyTitles.set(t, null);   // any other (new) title
  for (const t of Object.keys(INTERIM_TITLES)) historyTitles.set(t, null);
  const newlyFound = [];
  const isAewOrRoh = t => /^(AEW|ROH)\b/.test(t);

  const history = {};
  for (const [title, wikiTitle] of historyTitles) {
    let reigns = [];
    let usedPage = null;
    const interimOf = /\binterim\b/i.test(title) ? interimParent(title, knownTitles) : null;
    if (/\binterim\b/i.test(title) && !interimOf) { console.warn(`⚠️ Couldn't work out the main title for ${title}`); continue; }
    const pages = interimOf
      ? historyPageCandidates(interimOf, historyTitles.get(interimOf))
      : historyPageCandidates(title, wikiTitle);
    const isListed = !!(EXTRA_HISTORY_TITLES[title] || INTERIM_TITLES[title] || champions[title] || isAewOrRoh(title));
    let searched = false;
    const wikiName = pages[pages.length - 1] || title;     // e.g. "AAA Mega Championship"
    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi];
      try {
        await sleep(REQUEST_GAP_MS);
        const html = await fetchPageHtml(page, { allowMissing: true });
        const found = html ? parseReignRows(html, { interimOnly: !!interimOf }) : [];
        if (found.length >= (interimOf ? 1 : 2)) { reigns = found; usedPage = page; break; }
      } catch (e) {
        problems.push(e.message);
      }
      // Usual page names didn't work — add Wikipedia's own search results and keep trying
      if (pi === pages.length - 1 && !searched && !interimOf) {
        searched = true;
        try {
          await sleep(REQUEST_GAP_MS);
          const results = await searchWikipedia(`${wikiName} champions`);
          for (const r of results) if (!pages.includes(r)) pages.push(r);
        } catch (e) {
          problems.push(e.message);
        }
      }
    }
    if (reigns.length && !isListed) newlyFound.push(`${title} → "${usedPage}"`);
    if (!reigns.length) { console.warn(`⚠️ No reign history found for ${title}`); continue; }
    history[title] = reigns.map(r => {
      if (r.vacant) return { start: r.start, vacant: true };
      // Close-name guesses only for AEW/ROH reigns from the site's era — other promotions'
      // champions must match exactly (or by team members), so nobody is mis-identified
      const m = matchChampion({ ...r, vacant: false }, titleKind(title), wrestlersIndex, teamMembers,
        { allowGuesses: isAewOrRoh(title) && r.start >= SITE_DATA_STARTS });
      const members = teamMembersFor(r, m.name, titleKind(title), wrestlersIndex, teamMembers);
      return { start: r.start, champion: m.name, slug: m.slug, ...(members.length ? { members } : {}), wikiChampion: r.wikiChampion, matchedBy: m.matchedBy };
    });
    const unmatchedCount = history[title].filter(r => r.matchedBy === 'none').length;
    console.log(`📜 ${title.padEnd(42)} ${String(reigns.length).padStart(3)} reigns from "${usedPage}"${unmatchedCount ? ` (${unmatchedCount} without a site match)` : ''}`);
  }

  // ----- each archive week's end date, from the site's own archive files -----
  const weekEnds = {};
  try {
    const index = await readJson('archive/index.json');
    for (const w of index.weeks || []) {
      if (!w.filename || w.filename === 'archive-index.json' || weekEnds[w.label]) continue;
      try {
        const week = await readJson(`archive/${w.filename}`);
        // The first three entries are whole months ("Jun '19") with no date range —
        // use the last day of that month
        const monthOnly = w.label.match(/^(\w{3})\s+'(\d{2})$/);
        const monthIdx = monthOnly ? MONTHS.findIndex(m => m.startsWith(monthOnly[1])) : -1;
        const end = weekEndFromRange(week.dateRange)
          || (monthIdx >= 0 ? new Date(Date.UTC(2000 + Number(monthOnly[2]), monthIdx + 1, 0)).toISOString().slice(0, 10) : null);
        if (end) weekEnds[w.label] = end;
      } catch {}
    }
  } catch (e) {
    problems.push('archive/index.json: ' + e.message);
  }
  console.log(`🗓️ ${Object.keys(weekEnds).length} archive weeks with end dates`);
  if (newlyFound.length) console.log(`🆕 New titles found automatically (check they're the right pages):\n  ${newlyFound.join('\n  ')}`);

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
  if (previous && JSON.stringify([previous.champions, previous.history, previous.weekEnds]) === JSON.stringify([champions, history, weekEnds])) {
    console.log('No champion changes.');
    return;
  }
  const out = {
    updated: new Date().toISOString().slice(0, 10),
    source: 'Wikipedia — List of current champions and title histories (AEW, ROH)',
    champions,
    history,
    weekEnds,
  };
  await writeFile('champions.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`✅ champions.json updated (${count} titles).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
