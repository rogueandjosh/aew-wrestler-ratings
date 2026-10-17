// Builds championship-timeline.json from the weekly championship archive.
//
// For every title it keeps the LAST week of each spell in the rankings, with that
// week's stats. championships.html uses it to list, for any selected week, the
// titles that had been ranked before but aren't ranked now (Inactive Titles), with
// their stats as of the last week they were ranked — so nothing from the future
// shows up when looking back at an old week.
//
// Runs on GitHub Actions (Node 20, no packages) whenever championship-archive changes.
// Usage: node scripts/build-championship-timeline.mjs

import { readFile, writeFile } from 'node:fs/promises';

const ARCHIVE_DIR = 'championship-archive';
const OUT_FILE = 'championship-timeline.json';

// Stats kept per entry, in this order (short arrays keep the file small)
const FIELDS = ['rating', 'peak', 'floor', 'highestMatch', 'lowestMatch', 'streak',
    'totalMatches', 'allTimePeak', 'allTimeFloor', 'allTimeHighest', 'allTimeLowest'];

const round = v => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v ?? null);

export async function main() {
    const index = JSON.parse(await readFile(`${ARCHIVE_DIR}/index.json`, 'utf8'));
    const weeks = (index.weeks || []).slice().reverse(); // oldest first
    const keys = weeks.map(w => w.file.replace(/^championship-/, '').replace(/\.json$/, ''));

    const titles = {};     // title -> [[weekIdx, ...FIELDS], ...] (last week of each spell)
    const lastSeen = {};   // title -> weekIdx it was last ranked

    for (let i = 0; i < weeks.length; i++) {
        let data;
        try {
            data = JSON.parse(await readFile(`${ARCHIVE_DIR}/${weeks[i].file}`, 'utf8'));
        } catch (e) {
            console.log(`⚠️ Skipped ${weeks[i].file}: ${e.message}`);
            continue;
        }
        for (const c of data.championships || []) {
            const entry = [i, ...FIELDS.map(f => round(c[f]))];
            const list = titles[c.title] || (titles[c.title] = []);
            // Still in the same spell (ranked the week before) → move its end to this week
            if (lastSeen[c.title] === i - 1 && list.length) list[list.length - 1] = entry;
            else list.push(entry);
            lastSeen[c.title] = i;
        }
    }

    const out = { fields: ['week', ...FIELDS], weeks: keys, labels: weeks.map(w => w.week), titles };
    const text = JSON.stringify(out);
    let old = null;
    try { old = await readFile(OUT_FILE, 'utf8'); } catch (e) {}
    if (old === text) {
        console.log('No timeline changes.');
        return;
    }
    await writeFile(OUT_FILE, text);
    console.log(`✅ ${OUT_FILE}: ${keys.length} weeks, ${Object.keys(titles).length} titles, ${(text.length / 1024).toFixed(0)} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
