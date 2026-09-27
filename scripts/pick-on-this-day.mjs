// =====================================================================================
// On This Day — daily pick planner (runs in GitHub Actions, no dependencies)
//
// For each date from yesterday to 2 days ahead (UTC — covers every visitor time zone),
// if no pick is recorded yet for that date + year, it chooses one headline from
// on-this-day-daily/MM-DD.json and records it in on-this-day-picks.json:
//   • skips headlines the site can't display reliably (same checks as index.html)
//   • never re-picks a match already shown on that date in an earlier year —
//     unless every candidate has been shown, then it picks from the least recently shown
//   • weighted by rating (rating ^ WEIGHT_POWER), so stronger matches come up more often
// A recorded pick is never changed, so the file is a permanent history of what was shown.
// Set OTD_NOW=YYYY-MM-DD to simulate another day when testing locally.
// =====================================================================================
import fs from 'fs';

const DAILY_DIR = 'on-this-day-daily';
const PICKS_FILE = 'on-this-day-picks.json';
const WEIGHT_POWER = 5;        // 9.6 vs 6.5 rating ≈ 3x as likely. Raise = favour stronger more.
const DEFAULT_RATING = 6;      // used when a match has no rating
const DAY_OFFSETS = [-1, 0, 1, 2];

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
};

const picksData = readJson(PICKS_FILE, { picks: {} });
if (!picksData.picks) picksData.picks = {};
const teams = (readJson('team-members.json', {}) || {}).teams || {};
const nameChanges = (readJson('name-changes.json', {}) || {}).changes || [];

// ---- Same display checks as index.html (getCompetitorDoubt) ----
function resolveCurrentName(name) {
  let current = name;
  for (let hops = 0; hops < 10; hops++) {
    const change = nameChanges.find(c => c.oldName === current);
    if (!change) break;
    current = change.newName;
  }
  return current;
}
function resolveTeamMembers(teamName) {
  if (teams[teamName]) return teams[teamName];
  return null;
}
function getTeamMemberNames(name) {
  let members = null;
  if (teams[name]) members = resolveTeamMembers(name);
  else {
    const resolved = resolveCurrentName(name);
    if (resolved !== name && teams[resolved]) members = resolveTeamMembers(resolved);
  }
  return members ? members.map(m => resolveCurrentName(m)) : null;
}
function isDoubtful(details) {
  const list = details.competitors || [];
  if (list.length === 0) return true;
  const norm = n => resolveCurrentName(String(n)).trim().toLowerCase();
  const listed = new Set(list.map(norm));
  for (const entry of list) {
    const members = getTeamMemberNames(entry);
    if (members && members.some(m => listed.has(m.trim().toLowerCase()))) return true;
  }
  if (/\bman tag\b/i.test(details.matchType || '') && list.length !== 2) return true;
  return false;
}

// ---- Weighted choice ----
function weightOf(h) {
  const r = typeof h.details.rating === 'number' ? h.details.rating : DEFAULT_RATING;
  return Math.pow(Math.max(r, 1), WEIGHT_POWER);
}
function weightedChoice(items) {
  const total = items.reduce((s, h) => s + weightOf(h), 0);
  let x = Math.random() * total;
  for (const h of items) { x -= weightOf(h); if (x <= 0) return h; }
  return items[items.length - 1];
}

// ---- Plan picks ----
const now = process.env.OTD_NOW ? new Date(process.env.OTD_NOW + 'T12:00:00Z') : new Date();
let added = 0;

for (const offset of DAY_OFFSETS) {
  const d = new Date(now.getTime() + offset * 86400000);
  const year = String(d.getUTCFullYear());
  const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  const history = picksData.picks[mmdd] || {};
  if (history[year] !== undefined) continue;                    // already decided — never change

  const daily = readJson(`${DAILY_DIR}/${mmdd}.json`, null);
  if (!daily || !Array.isArray(daily.headlines)) { console.log(`${year}-${mmdd}: no daily file, skipped`); continue; }

  const candidates = daily.headlines.filter(h => h && h.details && h.matchId != null && !isDoubtful(h.details));
  if (candidates.length === 0) { console.log(`${year}-${mmdd}: no displayable headlines, skipped`); continue; }

  // Most recent year each match was shown on this date (earlier years only)
  const lastShown = {};
  Object.entries(history).forEach(([y, id]) => {
    if (y < year) lastShown[String(id)] = Math.max(lastShown[String(id)] || 0, Number(y));
  });

  let pool = candidates.filter(h => lastShown[String(h.matchId)] === undefined);
  if (pool.length === 0) {                                          // all shown before
    const oldest = Math.min(...candidates.map(h => lastShown[String(h.matchId)]));
    pool = candidates.filter(h => lastShown[String(h.matchId)] === oldest);
  }

  const chosen = weightedChoice(pool);
  picksData.picks[mmdd] = { ...history, [year]: chosen.matchId };
  added++;
  console.log(`${year}-${mmdd}: picked ${chosen.matchId} (${chosen.details.competitorsText || ''}) ` +
              `from ${pool.length} of ${candidates.length} candidate(s)`);
}

if (added > 0) {
  const sorted = {};
  Object.keys(picksData.picks).sort().forEach(k => { sorted[k] = picksData.picks[k]; });
  fs.writeFileSync(PICKS_FILE, JSON.stringify({ picks: sorted }, null, 1) + '\n');
}
console.log(`Done: ${added} new pick(s).`);
