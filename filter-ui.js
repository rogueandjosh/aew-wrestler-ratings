// ============================================================================
// filter-ui.js — shared filter controls (styles in filter-ui.css)
// Used by wrestler-stats.html and best-match-of-the-week.html.
//
//   FilterUI.yearPicker(root, {...})     ALL | Single | Multiple + year buttons
//   FilterUI.setupDropdowns(groups)      tick-list boxes: one open at a time,
//                                        outside click / Escape closes
//   FilterUI.markColumns(grid)           which column each box is in (phones:
//                                        lists open across the whole box)
//   FilterUI.checkboxFacet(group, {...}) a simple tick-list box: All + options,
//                                        counts, button text
// ============================================================================
(function () {

    // ------------------------------------------------------------------
    // YEAR PICKER — works on existing markup inside `root`:
    //   .year-mode-btn[data-mode="all|single|multi"] and .year-btn[data-year]
    // ALL = no year picked. Single: a tap shows just that year. Multiple: taps
    // add/remove years (removing the last one, or picking every year, goes
    // back to ALL). Single/Multiple from ALL starts on the latest year; back
    // to Single keeps the latest picked year. Several initial years open in
    // Multiple. onChange(selected) gets null (ALL) or a Set of years.
    // ------------------------------------------------------------------
    function yearPicker(root, { available, initial = [], onChange = () => {} }) {
        const yearBtns = [...root.querySelectorAll('.year-btn')];
        const modeBtns = [...root.querySelectorAll('.year-mode-btn')];
        const box = root.querySelector('.year-buttons');
        yearBtns.forEach(b => { b.style.display = available.includes(Number(b.dataset.year)) ? '' : 'none'; });

        const asSelection = years => years.length === 0 || years.length >= available.length ? null : new Set(years);
        const start = initial.map(Number).filter(y => available.includes(y));
        let selected = asSelection(start);
        let mode = start.length > 1 ? 'multi' : 'single';
        const latest = () => Math.max(...selected);

        function refresh() {
            yearBtns.forEach(btn => {
                const on = !!selected && selected.has(Number(btn.dataset.year));
                btn.classList.toggle('active', on);
                btn.setAttribute('aria-pressed', on);
            });
            if (box) box.classList.toggle('multi', mode === 'multi' && !!selected);
            const lit = selected ? mode : 'all';
            modeBtns.forEach(btn => {
                const on = btn.dataset.mode === lit;
                btn.classList.toggle('active', on);
                btn.setAttribute('aria-pressed', on);
            });
        }
        const changed = () => { refresh(); onChange(selected); };

        yearBtns.forEach(btn => btn.addEventListener('click', () => {
            const y = Number(btn.dataset.year);
            if (mode === 'single' || !selected) {
                selected = asSelection([y]);
            } else {
                const next = new Set(selected);
                if (next.has(y)) next.delete(y); else next.add(y);
                selected = asSelection([...next]);
            }
            changed();
        }));

        modeBtns.forEach(btn => btn.addEventListener('click', () => {
            const m = btn.dataset.mode;
            if (m === 'all') {
                if (!selected) return;
                selected = null;
            } else if (!selected) {
                mode = m;
                selected = asSelection([Math.max(...available)]);
            } else {
                if (m === mode) return;
                mode = m;
                if (m === 'single' && selected.size > 1) selected = new Set([latest()]);
            }
            changed();
        }));

        refresh();
        return {
            get selected() { return selected; },
            get mode() { return mode; },
            reset() { selected = null; refresh(); }
        };
    }

    // ------------------------------------------------------------------
    // TICK-LIST BOXES — each group is a .match-filter-group holding a
    // .match-filter-toggle button and a .match-filter-options list.
    // Only one is open at a time (across every call on the page).
    // ------------------------------------------------------------------
    const allGroups = [];
    let listening = false;

    function closeAll(except = null) {
        allGroups.forEach(g => {
            if (g === except) return;
            g.classList.remove('open');
            const t = g.querySelector('.match-filter-toggle');
            if (t) t.setAttribute('aria-expanded', 'false');
        });
    }

    function setupDropdowns(groups) {
        groups.filter(Boolean).forEach(group => {
            if (allGroups.includes(group)) return;
            allGroups.push(group);
            const toggle = group.querySelector('.match-filter-toggle');
            toggle.addEventListener('click', () => {
                const opening = !group.classList.contains('open');
                closeAll(group);
                group.classList.toggle('open', opening);
                toggle.setAttribute('aria-expanded', opening);
            });
        });
        if (listening) return;
        listening = true;
        document.addEventListener('click', e => {
            if (!e.target.closest('.match-filter-group')) closeAll();
        });
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            const open = allGroups.find(g => g.classList.contains('open'));
            if (open) {
                closeAll();
                open.querySelector('.match-filter-toggle').focus();
            }
        });
    }

    // Phones: boxes sit 2 per row; the right-hand column's lists open leftwards
    function markColumns(grid) {
        if (!grid) return [];
        const visible = [...grid.querySelectorAll('.match-filter-group')].filter(g => g.style.display !== 'none');
        visible.forEach((g, i) => g.classList.toggle('col-right', i % 2 === 1));
        return visible;
    }

    // ------------------------------------------------------------------
    // SIMPLE TICK-LIST BOX — "All" plus one box per option. State: null =
    // All (no filtering), otherwise a Set of ticked values (empty = none).
    // options: [{ value, label }]. setCounts(counts, total) shows "(n)" and
    // greys out options at 0; leave it out for a box without counts.
    // ------------------------------------------------------------------
    // showTotal: false keeps the closed box as plain "All" (counts stay in the list)
    function checkboxFacet(group, { options, onChange = () => {}, initial = null, showTotal = true }) {
        const list = group.querySelector('.match-filter-options');
        const toggle = group.querySelector('.match-filter-toggle');
        const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const ALL = '__ALL__';
        let selected = initial;
        let total = null;

        list.innerHTML = [{ value: ALL, label: '<strong>All</strong>', raw: true }].concat(options).map((o, i) => `
            <label data-value="${esc(o.value)}"${i === 0 ? ' class="shortcut"' : ''}>
                <input type="checkbox" value="${esc(o.value)}">
                <span>${o.raw ? o.label : esc(o.label)} <span class="count"></span></span>
            </label>`).join('');
        const boxes = [...list.querySelectorAll('input')];
        const allBox = boxes[0];
        const items = boxes.slice(1);

        function sync() {
            items.forEach(cb => { cb.checked = selected === null || selected.has(cb.value); });
            allBox.checked = items.every(cb => cb.checked);
            refreshToggle();
        }
        function refreshToggle() {
            let text;
            if (selected === null) text = total === null || !showTotal ? 'All' : `All (${total})`;
            else if (selected.size === 0) text = 'None selected';
            else {
                const names = options.filter(o => selected.has(String(o.value))).map(o => o.label);
                text = names.length <= 2 ? names.join(', ') : `${names.length} selected`;
            }
            toggle.querySelector('.toggle-text').textContent = text;
            toggle.title = text;
            toggle.classList.toggle('is-set', selected !== null);
        }

        list.addEventListener('change', e => {
            const cb = e.target;
            if (!cb.matches('input[type="checkbox"]')) return;
            if (cb === allBox) items.forEach(i => { i.checked = allBox.checked; });
            const ticked = items.filter(i => i.checked).map(i => i.value);
            selected = ticked.length === items.length ? null : new Set(ticked);
            sync();
            onChange(selected);
        });
        sync();

        return {
            get selected() { return selected; },
            set(value) { selected = value; sync(); },
            setCounts(counts, all) {
                total = all;
                list.querySelectorAll('label[data-value]').forEach(label => {
                    const v = label.dataset.value;
                    const n = v === ALL ? all : (counts[v] || 0);
                    label.querySelector('.count').textContent = `(${n})`;
                    label.classList.toggle('is-zero', n === 0);
                });
                refreshToggle();
            }
        };
    }

    window.FilterUI = { yearPicker, setupDropdowns, markColumns, checkboxFacet, closeAllDropdowns: () => closeAll() };
})();
