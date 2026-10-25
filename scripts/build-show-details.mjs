// Builds show-details.json for the Show Statistics page (shows.html) from data already on GitHub:
//   shows        "YYYY-MM-DD|Event" → [venue, showRating, weekLabel]
//                venue from each match's `location` (Data column BG, in the wrestler stats export),
//                falling back to the On This Day files; show rating from the On This Day files
//                (any match on a show gives the whole show); week label from the archive's date ranges
//   titles       match id → championship name (joined from championship-matches.json by year,
//                rating and competitors)
//   bestMatches  match ids that won Best Match of the Week (best-match-archive)
//
// Runs on GitHub Actions (Node 20, no packages) whenever those files change.
// Usage: node scripts/build-show-details.mjs

import { readFile, writeFile, readdir } from 'node:fs/promises';

const OUT_FILE = 'show-details.json';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const listJson = async dir => (await readdir(dir)).filter(f => f.endsWith('.json') && f !== 'index.json');
const low = s => String(s || '').trim().toLowerCase();

// "6th October 2026 to 13th October 2026" → ['2026-10-06', '2026-10-13']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function parseRange(text) {
    const parts = String(text || '').toLowerCase().split(/\s+to\s+/);
    if (parts.length !== 2) return null;
    const iso = p => {
        const m = p.match(/(\d+)\w*\s+([a-z]+)\s+(\d{4})/);
        if (!m || MONTHS.indexOf(m[2]) < 0) return null;
        return `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    };
    const a = iso(parts[0]), b = iso(parts[1]);
    return a && b ? [a, b] : null;
}

export async function main() {
    // Every match the site knows about, with everyone involved
    const matches = new Map();     // id → { date, event, rating, year, stakes, people:Set }
    for (const f of await listJson('wrestlers')) {
        let d;
        try { d = await readJson(`wrestlers/${f}`); } catch (e) { continue; }
        for (const m of d.allMatches || []) {
            if (m.id === null || m.id === undefined) continue;
            const rec = matches.get(m.id) || { date: m.date, event: m.event, rating: m.rating, stakes: m.stakes, people: new Set() };
            if (!rec.location && m.location) rec.location = String(m.location).trim();   // Data column BG, once the export has it
            rec.people.add(low(d.name));
            for (const k of ['versus', 'opponents', 'partners']) (m[k] || []).forEach(n => rec.people.add(low(n)));
            matches.set(m.id, rec);
        }
    }
    const showKey = m => `${m.date}|${m.event}`;

    // Week label for each date, from the weekly archive
    const weeks = [];
    const index = await readJson('archive/index.json');
    for (const w of index.weeks || []) {
        if (!w.filename || w.filename === 'archive-index.json') continue;
        try {
            const a = await readJson(`archive/${w.filename}`);
            const range = parseRange(a.dateRange);
            const label = a.currentWeek || w.label;
            if (range) weeks.push({ from: range[0], to: range[1], label });
            else {
                const m = w.filename.match(/^(\d{4})-(\d{2})/);       // monthly weeks (Jun–Aug '19)
                if (m) weeks.push({ from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-31`, label, monthly: true });
            }
        } catch (e) { /* skip unreadable week */ }
    }
    weeks.sort((a, b) => a.from.localeCompare(b.from));
    const weekFor = date => {
        const hit = weeks.find(w => !w.monthly && date >= w.from && date <= w.to) || weeks.find(w => date >= w.from && date <= w.to);
        if (hit) return hit.label;
        // A gap between two weeks' ranges: weeks start with Dynamite, so a show in the gap belongs
        // to the week that starts within the next few days; otherwise to the week before
        const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
        const next = weeks.find(w => w.from > date && days(date, w.from) <= 3);
        if (next) return next.label;
        const before = weeks.filter(w => w.from <= date);
        return before.length ? before[before.length - 1].label : null;
    };

    // Venue and show rating from the On This Day files
    const venueById = new Map(), showRatingById = new Map();
    for (const f of await listJson('on-this-day-daily')) {
        let d;
        try { d = await readJson(`on-this-day-daily/${f}`); } catch (e) { continue; }
        for (const section of Object.values(d)) {
            if (!Array.isArray(section)) continue;
            for (const e of section) {
                if (!e || typeof e !== 'object') continue;
                let det = e.details || {};
                if (typeof det === 'string') { try { det = JSON.parse(det); } catch (err) { det = {}; } }
                let id = e.matchId ?? det.sourceId;
                if (id === undefined || id === null) continue;
                id = Number(id);
                if (det.location) venueById.set(id, det.location);
                if (typeof det.showRating === 'number') showRatingById.set(id, det.showRating);
            }
        }
    }

    const shows = {};
    for (const [id, m] of matches) {
        const key = showKey(m);
        const s = shows[key] || (shows[key] = [null, null, weekFor(m.date)]);
        if (!s[0] && m.location) s[0] = m.location;                 // venue from the wrestler stats export (preferred)
        if (!s[0] && venueById.has(id)) s[0] = venueById.get(id);   // otherwise from the On This Day files
        if (s[1] === null && showRatingById.has(id)) s[1] = showRatingById.get(id);
    }

    // Championship names: match championship-matches.json rows to match ids
    const titles = {};
    try {
        const cm = await readJson('championship-matches.json');
        const byRatingYear = new Map();
        for (const [id, m] of matches) {
            const k = `${Number(m.rating || 0).toFixed(2)}|${String(m.date).slice(0, 4)}`;
            (byRatingYear.get(k) || byRatingYear.set(k, []).get(k)).push(id);
        }
        for (const [, titleIdx, rating, names, year] of cm.matches || []) {
            const comp = new Set(String(names || '').split(';').map(low).filter(Boolean));
            let cands = byRatingYear.get(`${Number(rating || 0).toFixed(2)}|${year}`) || [];
            const titleOnly = cands.filter(id => /title/i.test(matches.get(id).stakes || ''));
            if (titleOnly.length) cands = titleOnly;
            const scored = cands.map(id => ({ id, n: [...comp].filter(x => matches.get(id).people.has(x)).length }))
                .filter(x => x.n > 0).sort((a, b) => b.n - a.n);
            if (scored.length && (scored.length === 1 || scored[0].n > scored[1].n)) titles[scored[0].id] = cm.titles[titleIdx];
        }
    } catch (e) { console.log('⚠️ No championship-matches.json: ' + e.message); }

    // Best Match of the Week winners
    const bestMatches = [];
    for (const f of await listJson('best-match-archive')) {
        try {
            const b = await readJson(`best-match-archive/${f}`);
            if (b && b.id !== undefined && b.id !== null) bestMatches.push(Number(b.id));
        } catch (e) { /* skip */ }
    }

    const out = { shows, titles, bestMatches: [...new Set(bestMatches)].sort((a, b) => a - b) };
    const text = JSON.stringify(out);
    let old = null;
    try { old = await readFile(OUT_FILE, 'utf8'); } catch (e) {}
    const withVenue = Object.values(shows).filter(s => s[0]).length;
    console.log(`Shows ${Object.keys(shows).length} (venue ${withVenue}), titles ${Object.keys(titles).length}, best matches ${out.bestMatches.length}, ${(text.length / 1024).toFixed(0)} KB`);
    if (old === text) { console.log('No changes.'); return; }
    await writeFile(OUT_FILE, text);
    console.log(`✅ ${OUT_FILE} written`);
}

main().catch(e => { console.error(e); process.exit(1); });
