// ===== SHARED TOOLTIP SYSTEM =====
// Any element with class "tt" and a data-tt attribute gets a tooltip.
// One floating box (#ttBox) is positioned against the screen edges, so a
// tooltip never runs off the side of a laptop or phone screen:
//   - centred over the element where possible, otherwise slid inwards
//   - shown above the element, or below it if there isn't room above
//     (class "tt-below" makes below the first choice)
//   - its width shrinks on narrow screens
// Mouse: appears after a short pause on hover. Touch: appears on tap and
// fades after a few seconds; the tap itself still works as normal.

(function () {
    const SHOW_DELAY_MS = 400;     // hover pause before a tooltip appears
    const TOUCH_HIDE_MS = 4000;    // how long a tapped tooltip stays up
    const EDGE_GAP = 8;            // minimum space from the screen edge
    const ELEMENT_GAP = 10;        // space between tooltip and element
    const MAX_WIDTH = 260;

    let box = null;
    let showTimer = null;
    let hideTimer = null;
    let currentEl = null;
    let lastTouchTime = 0;

    function tooltipsOn() {
        return document.body.classList.contains('tooltips-on');
    }

    function findTarget(node) {
        const el = node && node.closest ? node.closest('.tt[data-tt]') : null;
        return el && el.getAttribute('data-tt') ? el : null;
    }

    function position(el) {
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const rect = el.getBoundingClientRect();

        box.style.maxWidth = Math.min(MAX_WIDTH, vw - EDGE_GAP * 2) + 'px';
        box.style.left = '0px';
        box.style.top = '0px';
        const w = box.offsetWidth;
        const h = box.offsetHeight;

        // Horizontal: centre on the element, then keep inside the screen
        const centre = rect.left + rect.width / 2;
        let left = centre - w / 2;
        left = Math.max(EDGE_GAP, Math.min(left, vw - w - EDGE_GAP));

        // Vertical: preferred side first, flip if it doesn't fit
        const roomAbove = rect.top - ELEMENT_GAP - EDGE_GAP;
        const roomBelow = vh - rect.bottom - ELEMENT_GAP - EDGE_GAP;
        const preferBelow = el.classList.contains('tt-below');
        let below = preferBelow ? (roomBelow >= h || roomBelow >= roomAbove)
                                : !(roomAbove >= h || roomAbove >= roomBelow);
        let top = below ? rect.bottom + ELEMENT_GAP : rect.top - ELEMENT_GAP - h;
        top = Math.max(EDGE_GAP, Math.min(top, vh - h - EDGE_GAP));

        box.style.left = Math.round(left) + 'px';
        box.style.top = Math.round(top) + 'px';
        box.dataset.side = below ? 'below' : 'above';
        // Arrow points at the element's centre, kept within the box's rounded corners
        const arrowX = Math.max(12, Math.min(centre - left, w - 12));
        box.style.setProperty('--tt-arrow-x', Math.round(arrowX) + 'px');
    }

    function show(el) {
        if (!box || !tooltipsOn()) return;
        currentEl = el;
        box.textContent = el.getAttribute('data-tt');
        box.style.display = 'block';
        position(el);
        box.classList.add('visible');
    }

    function hide() {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        currentEl = null;
        if (box) {
            box.classList.remove('visible');
            box.style.display = 'none';
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        // One shared box; the CSS-only tooltips are switched off by the tt-js class
        box = document.getElementById('ttBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ttBox';
            document.body.appendChild(box);
        }
        box.setAttribute('role', 'tooltip');
        document.body.classList.add('tt-js');

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
        let stored = null;
        try { stored = localStorage.getItem('aewTooltips'); } catch (e) {} // storage can be blocked by the browser
        const on = stored === null ? true : stored === 'true';
        if (on) document.body.classList.add('tooltips-on');
        updateToggleBtn(document.getElementById('tooltipToggle'));

        // Mouse: show after a short pause, hide on leaving the element
        document.addEventListener('mouseover', function (e) {
            if (Date.now() - lastTouchTime < 800) return; // ignore the mouse events a tap fires
            const el = findTarget(e.target);
            if (!el || el === currentEl) return;
            clearTimeout(showTimer);
            if (currentEl) hide();
            showTimer = setTimeout(() => show(el), SHOW_DELAY_MS);
        });

        document.addEventListener('mouseout', function (e) {
            if (Date.now() - lastTouchTime < 800) return;
            const el = findTarget(e.target);
            if (!el) return;
            if (e.relatedTarget && el.contains(e.relatedTarget)) return; // still inside the element
            clearTimeout(showTimer);
            if (currentEl === el) hide();
        });

        // Touch: show straight away on tap; tapping anywhere else hides it
        document.addEventListener('touchstart', function (e) {
            lastTouchTime = Date.now();
            const el = findTarget(e.target);
            if (!el) { hide(); return; }
            clearTimeout(hideTimer);
            show(el);
            hideTimer = setTimeout(hide, TOUCH_HIDE_MS);
        }, { passive: true });

        // A fixed-position box would drift away from its element when the page moves
        window.addEventListener('scroll', hide, { passive: true, capture: true });
        window.addEventListener('resize', hide);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    });

    // Exposed so the toggle can clear an open tooltip
    window.hideTooltip = hide;
})();

function toggleTooltips() {
    const on = document.body.classList.toggle('tooltips-on');
    try { localStorage.setItem('aewTooltips', on); } catch (e) {}
    if (!on && window.hideTooltip) window.hideTooltip();
    updateToggleBtn(document.getElementById('tooltipToggle'));
}

function updateToggleBtn(btn) {
    if (!btn) return;
    const on = document.body.classList.contains('tooltips-on');
    btn.textContent = on ? '💡 Tooltips ON' : '💡 Tooltips OFF';
    btn.classList.toggle('active', on);
}
