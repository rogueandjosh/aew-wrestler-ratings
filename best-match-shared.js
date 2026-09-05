// ============================================================================
// SHARED: Best Match of the Week crediting logic
// Used by both index.html (All Wrestler Statistics) and
// best-match-of-the-week.html (Leaderboard) — edit this file once, both
// pages pick up the change automatically. Do not duplicate this logic
// inline in either page again.
// ============================================================================

function stripTrioSuffix(name) {
    return name.replace(/\s*\(Trio\)\s*/gi, '').trim();
}

function getCanonicalName(anyName, nameChanges) {
    if (!nameChanges || nameChanges.length === 0) return anyName;

    const relatedChanges = nameChanges.filter(change =>
        change.oldName === anyName || change.newName === anyName
    );
    if (relatedChanges.length === 0) return anyName;

    relatedChanges.sort((a, b) => a.matchId - b.matchId);

    let earliestName = anyName;
    for (const change of relatedChanges) {
        if (change.newName === earliestName) {
            earliestName = change.oldName;
        }
    }

    let currentName = earliestName;
    for (const change of relatedChanges) {
        if (currentName === change.oldName) {
            currentName = change.newName;
        }
    }

    return currentName;
}

// teamMembersData: the parsed team-members.json object ({ teams: {...} })
// nameChangesMap: simple { oldName: newName } map (not the raw changes array)
function findTeamMembersArrayShared(teamName, teamMembersData, nameChangesMap) {
    if (!teamMembersData || !teamMembersData.teams) return null;

    let members = teamMembersData.teams[teamName];
    if (members && members.length >= 2) return members;

    const nameWithoutThe = teamName.replace(/^The\s+/i, '');
    members = teamMembersData.teams[nameWithoutThe];
    if (members && members.length >= 2) return members;

    const nameWithThe = 'The ' + teamName;
    members = teamMembersData.teams[nameWithThe];
    if (members && members.length >= 2) return members;

    if (nameChangesMap) {
        const oldNameEntry = Object.keys(nameChangesMap).find(oldName =>
            nameChangesMap[oldName] === teamName
        );
        if (oldNameEntry) {
            members = teamMembersData.teams[oldNameEntry];
            if (members && members.length >= 2) return members;
        }
        if (nameChangesMap[teamName]) {
            members = teamMembersData.teams[nameChangesMap[teamName]];
            if (members && members.length >= 2) return members;
        }
    }

    if (teamName.includes(' & ')) {
        const parts = [];
        let current = '';
        let depth = 0;
        for (let i = 0; i < teamName.length; i++) {
            const ch = teamName[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (depth === 0 && teamName.substring(i, i + 3) === ' & ') {
                parts.push(current.trim());
                current = '';
                i += 2;
            } else {
                current += ch;
            }
        }
        if (current.trim()) parts.push(current.trim());
        if (parts.length >= 2) return parts;
    }

    return null;
}

// The single decision: was this wrestler/team credited for this week's
// Best Match? divKey is one of: mens, womens, menstag, womenstag, trios.
// weekBestMatch is that week's best-match-archive entry (or null/undefined
// if that week has no Best Match data).
function isCreditedForBestMatch(divKey, originalName, weekBestMatch, teamMembersData, nameChangesMap) {
    if (!weekBestMatch || !weekBestMatch.wrestlers || weekBestMatch.wrestlers.length === 0) {
        return false;
    }

    const bmNamesLower = weekBestMatch.wrestlers.map(n => n.toLowerCase());
    const bmTagTeamsLower = (weekBestMatch.tagTeams || []).map(n => n.toLowerCase());
    const bmTrioTeamsLower = (weekBestMatch.trioTeams || []).map(n => stripTrioSuffix(n).toLowerCase());

    if (divKey === 'menstag' || divKey === 'womenstag') {
        const teamMembersArr = findTeamMembersArrayShared(originalName, teamMembersData, nameChangesMap) || [];
        const memberMatch = teamMembersArr.length > 0 && teamMembersArr.every(m => bmNamesLower.includes(m.toLowerCase()));
        const namedMatch = bmTagTeamsLower.includes(originalName.toLowerCase());
        return memberMatch || namedMatch;
    }

    if (divKey === 'trios') {
        const teamMembersArr = findTeamMembersArrayShared(originalName, teamMembersData, nameChangesMap) || [];
        const memberMatch = teamMembersArr.length > 0 && teamMembersArr.every(m => bmNamesLower.includes(m.toLowerCase()));
        const namedMatch = bmTrioTeamsLower.includes(stripTrioSuffix(originalName).toLowerCase());
        return memberMatch || namedMatch;
    }

    return bmNamesLower.includes(originalName.toLowerCase());
}
