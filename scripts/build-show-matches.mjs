// Builds show-matches.json for the Show Statistics page (shows.html): every wrestler's and
// team's matches in ONE file, so the page loads a single file instead of ~675 wrestler files.
//
// It follows exactly what the page used to do itself:
//   - the wrestler list comes from statistics.json (divisions in order mens, womens, menstag,
//     womenstag, trios; first division a name appears in wins; duplicates skipped)
//   - each one's file is wrestlers/<createSlug(name)>.json (skipped if missing)
//
// Layout (kept small: each match's shared details are stored once, names once):
//   names     [name, ...]                                     (every name used below)
//   matches   [[id, date, event, show, showType, rating, matchType, matchStipulation,
//               stakes, matchPos, division], ...]
//   wrestlers [[nameIdx, slug, division, isTeam 0/1, peakRating,
//               [[matchIdx, [opponents], [versus], [partners]], ...]], ...]
//              (opponents / versus / partners are name indexes)
//
// Runs on GitHub Actions (Node 20, no packages) together with build-show-details.mjs.
// Usage: node scripts/build-show-matches.mjs

import { readFile, writeFile } from 'node:fs/promises';

const OUT_FILE = 'show-matches.json';
const DIVISIONS = ['mens', 'womens', 'menstag', 'womenstag', 'trios'];
const MATCH_FIELDS = ['id', 'date', 'event', 'show', 'showType', 'rating', 'matchType', 'matchStipulation', 'stakes', 'matchPos', 'division'];

// Same as createSlug() in shows.html
const createSlug = name => name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();

async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { return null; }
}

export async function main() {
    const stats = await readJson('statistics.json');
    if (!stats) throw new Error('statistics.json missing');

    const list = [];
    DIVISIONS.forEach(div => (stats[div] || []).forEach(w => {
        if (w.name && !list.find(x => x.name === w.name)) list.push({ name: w.name, slug: createSlug(w.name), division: div });
    }));

    const names = [], nameIdx = new Map();
    const nameRef = n => {
        if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
        return nameIdx.get(n);
    };
    const matches = [], matchIdx = new Map();
    const matchRef = m => {
        const row = MATCH_FIELDS.map(k => (m[k] === undefined ? null : m[k]));
        const key = JSON.stringify(row);           // identical details → stored once
        if (!matchIdx.has(key)) { matchIdx.set(key, matches.length); matches.push(row); }
        return matchIdx.get(key);
    };

    const wrestlers = [];
    let missing = 0;
    for (const w of list) {
        const d = await readJson(`wrestlers/${w.slug}.json`);
        if (!d) { missing++; continue; }
        const apps = (d.allMatches || []).map(m => [
            matchRef(m),
            (m.opponents || []).map(nameRef),
            (m.versus || []).map(nameRef),
            (m.partners || []).map(nameRef)
        ]);
        wrestlers.push([nameRef(d.name), d.slug || null, w.division, d.isTeam ? 1 : 0, d.peakRating ?? null, d.allMatches ? apps : null]);
    }

    const out = { built: new Date().toISOString(), names, matches, wrestlers };
    await writeFile(OUT_FILE, JSON.stringify(out));
    console.log(`${wrestlers.length} wrestlers/teams (${missing} without a file), ${matches.length} match rows, ${names.length} names`);
}

main().catch(e => { console.error(e); process.exit(1); });
