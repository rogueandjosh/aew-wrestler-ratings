// ============================================================================
// SHARED: Match filter groupings
// Used by wrestler-stats.html (Match Filters panel). Raw Cagematch values stay
// untouched in the wrestler JSON files — all grouping happens here, so if a
// grouping needs changing, edit this file only. No re-export required.
//
// Each grouping function takes a raw value and returns a group label.
// Rules are checked top to bottom; the first match wins, so ORDER MATTERS.
// When a new raw value appears in the data that lands in the wrong group,
// add a rule above the one that's catching it.
// ============================================================================

// ---------------------------------------------------------------------------
// FORMAT — grouped from matchType (e.g. "One on One", "8 Man Tag", "4 Way Tag")
// ---------------------------------------------------------------------------
const FORMAT_GROUPS = ['Singles', 'Tag Team', 'Trios', 'Multi-Person Tag', 'Multi-Way', 'Battle Royal & Gauntlet', 'Other'];

function getFormatGroup(matchType) {
    const t = (matchType || '').trim();
    if (!t) return 'Other';
    if (/gauntlet|battle royal/i.test(t)) return 'Battle Royal & Gauntlet';  // incl. Tag/Trios Battle Royal
    if (/\bway\b|^multi/i.test(t)) return 'Multi-Way';                        // 3 Way, 4 Way Tag, Multi Trios...
    if (/^\d+\s+(man|woman|person)\s+tag$/i.test(t)) return 'Multi-Person Tag'; // 8 Man Tag, 12 Person Tag...
    if (/handicap/i.test(t)) return 'Multi-Person Tag';
    if (/trios/i.test(t)) return 'Trios';                                      // Trios, Mixed Trios
    if (/tag/i.test(t)) return 'Tag Team';                                     // Tag Team, Mixed Tag (Team)
    if (/^one on one$/i.test(t)) return 'Singles';
    return 'Other';
}

// ---------------------------------------------------------------------------
// STAKES — grouped from stakes (e.g. "Title Match", "Continental Classic Final")
// ---------------------------------------------------------------------------
const STAKES_GROUPS = ['Title Match', 'Contender & Eliminator', 'Tournament', 'Other Stakes', 'No Stakes'];

function getStakesGroup(stakes) {
    const s = (stakes || '').trim();
    if (!s || /^none$/i.test(s)) return 'No Stakes';
    if (/title match|^title vs|vs title$/i.test(s)) return 'Title Match';      // incl. Title vs Career / Hair
    if (/contender|eliminator|future title shot|number one entry|advantage/i.test(s)) return 'Contender & Eliminator';
    if (/tournament|classic|continental cup|qualifying|best of 7|diamond ring|face of the revolution/i.test(s)) return 'Tournament';
    return 'Other Stakes';                                                       // Cash, Hair vs Hair, Authority Position...
}

// ---------------------------------------------------------------------------
// STIPULATION — individual stipulations, with similar variants merged.
// Extends the rules used in the Best Match archive (Street Fight, Texas Death).
// ---------------------------------------------------------------------------
const STIPULATION_RULES = [
    // Order matters — first match wins.
    { pattern: /street fight/i,                       canonical: 'Street Fight' },   // Chicago, Philly, Mid-South...
    { pattern: /texas death/i,                        canonical: 'Texas Death' },
    { pattern: /steel cage/i,                         canonical: 'Steel Cage' },     // Lights Out / Barbed Wire Steel Cage
    { pattern: /barbed wire death/i,                  canonical: 'Barbed Wire Death Match' },
    { pattern: /^ladder( match)?$/i,                  canonical: 'Ladder' },
    { pattern: /^(the butcher )?battle royal$/i,      canonical: 'Battle Royal' },
    { pattern: /^gauntlet( challenge)?$/i,            canonical: 'Gauntlet' },
    { pattern: /^tables( match)?$/i,                  canonical: 'Tables' },
    { pattern: /^(no dq|no disqualification)$/i,      canonical: 'No DQ' },
    { pattern: /^no count outs?( match)?$/i,          canonical: 'No Count Out' },
    { pattern: /^iron man/i,                          canonical: 'Iron Man' }
];

function normalizeMatchStipulation(raw) {
    const s = (raw || '').trim();
    if (!s || /^none$/i.test(s)) return 'None';
    for (const rule of STIPULATION_RULES) {
        if (rule.pattern.test(s)) return rule.canonical;
    }
    return s;
}

// ---------------------------------------------------------------------------
// SHOW TYPE — from showType (Column E). Kept as-is; older files without the
// field (or blank values) fall under 'Not Recorded'.
// ---------------------------------------------------------------------------
const SHOW_TYPE_GROUPS = ['Pay Per View', 'TV Special', 'Quarterly TV Show', 'YouTube Special', 'Weekly TV', 'Not Recorded'];

function getShowTypeGroup(showType) {
    const s = (showType || '').trim();
    return s || 'Not Recorded';
}

// ---------------------------------------------------------------------------
// CARD POSITION — from matchPos (Column O). Values shown as they are in the sheet.
// ---------------------------------------------------------------------------
const CARD_POSITION_GROUPS = ['Main Event', 'Other', 'Opener', 'Not Recorded'];

function getCardPositionGroup(matchPos) {
    const s = (matchPos || '').trim();
    if (!s) return 'Not Recorded';
    if (/^main event$/i.test(s)) return 'Main Event';
    if (/^opener$/i.test(s)) return 'Opener';
    if (/^other$/i.test(s)) return 'Other';
    return s;   // any new value appears under its own name
}

// ---------------------------------------------------------------------------
// FILTER FACETS — each facet reads one group from a match.
// Filter state per facet: null = "All" (no filtering), otherwise a Set of
// selected groups (an empty Set means nothing ticked = no matches).
// Within a facet the selections are OR'd; across facets they're AND'd.
// ---------------------------------------------------------------------------
const MATCH_FACETS = {
    format:   m => getFormatGroup(m.matchType),
    stakes:   m => getStakesGroup(m.stakes),
    stip:     m => normalizeMatchStipulation(m.matchStipulation),
    showType: m => getShowTypeGroup(m.showType),
    cardPos:  m => getCardPositionGroup(m.matchPos)
};

// Simple facets: a fixed list of groups, shown as All + one box each.
// (Stipulation is built separately because of its Any/None shortcuts.)
const SIMPLE_FACET_GROUPS = {
    format: FORMAT_GROUPS,
    stakes: STAKES_GROUPS,
    showType: SHOW_TYPE_GROUPS,
    cardPos: CARD_POSITION_GROUPS
};

// exceptFacet: skip one facet's own selection — used for faceted counts, so
// each section's numbers reflect the OTHER sections' choices, not its own.
function matchPassesFilters(match, state, exceptFacet = null) {
    for (const facet in MATCH_FACETS) {
        if (facet === exceptFacet) continue;
        const selected = state[facet];
        if (selected && !selected.has(MATCH_FACETS[facet](match))) return false;
    }
    return true;
}

// Count how many of a wrestler's matches fall in each group — used to build
// dropdowns that only show options this wrestler actually has.
function countBy(matches, groupFn) {
    const counts = {};
    matches.forEach(m => {
        const g = groupFn(m);
        counts[g] = (counts[g] || 0) + 1;
    });
    return counts;
}
