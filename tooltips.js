// ===== SHARED TOOLTIP SYSTEM =====

document.addEventListener('DOMContentLoaded', function () {

    // Inject #ttBox if not already present
    if (!document.getElementById('ttBox')) {
        const box = document.createElement('div');
        box.id = 'ttBox';
        document.body.appendChild(box);
    }

    // Inject toggle button into subtitle if not already present
    if (!document.getElementById('tooltipToggle')) {
        const subtitle = document.querySelector('p.subtitle');
        if (subtitle) {
            const btn = document.createElement('button');
            btn.id = 'tooltipToggle';
            btn.onclick = toggleTooltips;
            subtitle.appendChild(btn);
        }
    }

    // Apply saved preference
    const stored = localStorage.getItem('aewTooltips');
    const on = stored === null ? true : stored === 'true';
    if (on) document.body.classList.add('tooltips-on');
    updateToggleBtn(document.getElementById('tooltipToggle'));

    // JS-powered tooltips for table headers
    const ttBox = document.getElementById('ttBox');
    let ttTimer = null;

    document.addEventListener('mouseover', function (e) {
        const el = e.target.closest('th.tt, td.tt');
        if (!el || !document.body.classList.contains('tooltips-on')) return;
        const text = el.getAttribute('data-tt');
        if (!text) return;
        ttTimer = setTimeout(() => {
            const rect = el.getBoundingClientRect();
            ttBox.textContent = text;
            ttBox.style.display = 'block';
            const left = rect.left + rect.width / 2 - 100;
            const top = rect.top - 70;
            ttBox.style.left = Math.max(5, left) + 'px';
            ttBox.style.top = Math.max(5, top) + 'px';
        }, 400);
    });

    document.addEventListener('mouseout', function (e) {
        const el = e.target.closest('th.tt, td.tt');
        if (!el) return;
        clearTimeout(ttTimer);
        ttBox.style.display = 'none';
    });

});

function toggleTooltips() {
    const on = document.body.classList.toggle('tooltips-on');
    localStorage.setItem('aewTooltips', on);
    updateToggleBtn(document.getElementById('tooltipToggle'));
}

function updateToggleBtn(btn) {
    if (!btn) return;
    const on = document.body.classList.contains('tooltips-on');
    btn.textContent = on ? '💡 Tooltips ON' : '💡 Tooltips OFF';
    btn.classList.toggle('active', on);
}
