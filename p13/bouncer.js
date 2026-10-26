/* Paracord — the Bouncer (DEMO ops alert). Watches the top 10% of individual crowd holders by insured value and flags any
 * holder-stock whose price sits far below the holder's insured level K: gap = (K - price) / K. Concerning once the gap has
 * held >= threshold for the nudges' 15 sim-minute sustain; clears under the clear level (hysteresis). Recommended actions are
 * display-only: "Simulate" logs to the console and shows a toast; nothing changes. Constants: PCNudge.BOUNCER (nudge.js). */
(function (g) {
  'use strict';
  var NU = g.PCNudge || (typeof require !== 'undefined' ? require('./nudge.js') : null);
  var B = NU.BOUNCER, PREFIX = 'p13:';

  /* ---------------- engine (pure; node-testable) ---------------- */
  /** stable anonymized id per sampled holder: a fixed permutation of 1000-9999 (7919 is prime, coprime with 9000) */
  function holderId(i) { return 1000 + ((i * 7919 + 1237) % 9000); }
  /** top pct of holders by insured value (ties broken by sample index so the pick is stable) */
  function topHolders(list, pct) {
    var n = Math.ceil(list.length * (pct == null ? B.BOUNCER_TOP_PCT : pct));
    return list.slice().sort(function (a, b) { return b.insured - a.insured || a.i - b.i; }).slice(0, n);
  }
  /** counter position for one holder: COUNTER_PCT of the gap $, capped per holder */
  function counterSize(gapUsd) { return Math.min(B.BOUNCER_PER_HOLDER_CAP, B.BOUNCER_COUNTER_PCT * Math.max(0, gapUsd)); }
  function levels(demo) { return demo ? { th: B.BOUNCER_DEMO_GAP_THRESHOLD, clr: B.BOUNCER_DEMO_CLEAR } : { th: B.BOUNCER_GAP_THRESHOLD, clr: B.BOUNCER_CLEAR }; }
  function create(holders) { return { holders: holders || [], st: {}, minute: 0, flagged: [], count: 0 }; }
  /**
   * One sim minute. mkt: { t: { K, S } } (K = insured level for that name, S = price now), minute = book minute,
   * lv = { th, clr }, inv: { t: { sh, value } } Paracord-owned inventory (optional).
   */
  function step(E, mkt, minute, lv, inv) {
    E.minute = minute; inv = inv || {};
    var groups = {};
    E.holders.forEach(function (h) {
      h.legs.forEach(function (l) {
        var m = mkt[l.t]; if (!m || !(m.K > 0)) return;
        var key = h.i + ':' + l.t, s = E.st[key] || (E.st[key] = { since: null, on: false, from: null });
        var gap = (m.K - m.S) / m.K, cond = gap >= lv.th;
        s.since = NU.since(s.since, cond, minute);
        if (s.on) { if (gap < lv.clr) { s.on = false; s.from = null; } }
        else if (NU.held(s.since, minute, B.BOUNCER_SUSTAIN_MIN)) { s.on = true; s.from = s.since; }
        if (!s.on) return;
        var it = { t: l.t, K: m.K, S: m.S, gapPct: gap, gapUsd: Math.max(0, m.K - m.S) * l.sh, sh: l.sh, minutes: minute - s.from,
          invSh: inv[l.t] ? inv[l.t].sh : 0, invValue: inv[l.t] ? inv[l.t].value : 0 };
        var gr = groups[h.i] || (groups[h.i] = { i: h.i, id: holderId(h.i), label: 'Holder #' + holderId(h.i), items: [], gapUsd: 0 });
        gr.items.push(it); gr.gapUsd += it.gapUsd;
      });
    });
    var out = Object.keys(groups).map(function (k) { var gr = groups[k]; gr.items.sort(function (a, b) { return b.gapUsd - a.gapUsd; }); gr.counter = counterSize(gr.gapUsd); return gr; });
    E.flagged = sortRows(out); E.count = out.length;
    return E;
  }
  function sortRows(rows) { return rows.sort(function (a, b) { return b.gapUsd - a.gapUsd || a.id - b.id; }); }
  /* "Why am I seeing this?" tip: shown once ever, the first time the Bouncer fires; the % is the ACTIVE trigger */
  function fmtPct(x) { return String(+(x * 100).toFixed(1)) + '%'; }
  function triggerText(lv) { return 'Trigger: ' + fmtPct(lv.th) + ' gap (clears under ' + fmtPct(lv.clr) + ')'; }
  function tipDue(count, seen) { return count > 0 && !seen; }
  function tipText(lv, demo) {
    return 'The red pulse means one or more of the top 10% of holders have a gap of at least ' + fmtPct(lv.th) + ' between their insured level and the stock price, held for ' + B.BOUNCER_SUSTAIN_MIN + ' minutes. Tap the button to see who and the suggested actions.' +
      (demo ? ' Demo sensitivity is on, so the trigger is lowered from ' + fmtPct(B.BOUNCER_GAP_THRESHOLD) + ' to ' + fmtPct(lv.th) + '.' : '');
  }
  var api = { fmtPct: fmtPct, triggerText: triggerText, tipDue: tipDue, tipText: tipText, holderId: holderId, topHolders: topHolders, counterSize: counterSize, levels: levels, create: create, step: step, sortRows: sortRows };
  g.PCBouncer = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  /* ---------------- UI (browser) ---------------- */
  function load(k, d) { try { var v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function store(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} }
  var crowd = g.PCConfidence && g.PCConfidence.crowd, E = create(crowd && crowd.holders ? topHolders(crowd.holders) : []);
  var demo = load('bouncerDemoSens', false) === true, tipSeen = load('bouncerTipSeen', false) === true, tipOn = false, tipShows = 0, open = false, lastMkt = null, lastInv = null;
  function money(x, d) { return (x < 0 ? '−' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var btn = document.createElement('button');
  btn.id = 'bouncer'; btn.className = 'bouncer'; btn.type = 'button'; btn.setAttribute('aria-label', 'Bouncer: no holders flagged'); btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 21.5c1-1 2.3-1.7 3.5-2.5 2-1.3 3.3-2.4 3.3-3.6s-1-2.2-2.1-2.8"/><path d="M10.8 11.4C7.6 9.8 6.2 7.8 6.8 5.6 7.4 3.6 9.6 2.5 12 2.5s4.6 1.1 5.2 3.1c.6 2.2-1.7 4.6-5.2 6.4-2 1-3.3 2.2-3.3 3.4s1 2.2 2.1 2.9"/><path d="M13.2 19.8c1 .6 1.8 1.2 2.3 1.7"/></svg><span class="bouncer-badge" hidden></span>';
  document.body.appendChild(btn);
  var toastEl = document.createElement('div'); toastEl.className = 'bouncer-toast'; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); document.body.appendChild(toastEl);
  var scrim = document.createElement('div'); scrim.className = 'bouncer-scrim'; scrim.hidden = true;
  scrim.innerHTML = '<section class="bouncer-panel" role="dialog" aria-modal="true" aria-labelledby="bouncerTitle"><div class="bouncer-grab"></div>' +
    '<header class="bouncer-head"><div><h2 id="bouncerTitle">Bouncer</h2><div class="bouncer-sub" id="bouncerSub"></div></div><button class="bouncer-close" type="button" aria-label="Close" data-bx="close">✕</button></header>' +
    '<div class="bouncer-trigger" id="bouncerTrigger"></div><label class="bouncer-sens"><input type="checkbox" id="bouncerDemoSens"> Demo sensitivity <span id="bouncerSensTxt"></span></label>' +
    '<div class="bouncer-list" id="bouncerList"></div>' +
    '<p class="bouncer-note">Demo only. Research, not legal advice: buying to support a price may raise market-manipulation questions — review with counsel.</p></section>';
  document.body.appendChild(scrim);
  var listEl = scrim.querySelector('#bouncerList'), subEl = scrim.querySelector('#bouncerSub'), sensEl = scrim.querySelector('#bouncerDemoSens'), sensTxt = scrim.querySelector('#bouncerSensTxt'), trigEl = scrim.querySelector('#bouncerTrigger');
  var tipEl = document.createElement('div'); tipEl.className = 'bouncer-tip'; tipEl.id = 'bouncerTip'; tipEl.hidden = true; tipEl.setAttribute('role', 'dialog'); tipEl.setAttribute('aria-labelledby', 'bouncerTipTitle');
  tipEl.innerHTML = '<b id="bouncerTipTitle">Why am I seeing this?</b><p id="bouncerTipText"></p><button type="button" class="bouncer-tip-ok" data-bx="tipok">Got it</button>';
  document.body.appendChild(tipEl);
  sensEl.checked = demo;

  /* position: stored as viewport px (left, top); shown clamped inside the viewport (also on resize) */
  var SIZE = 52, M = 8, pos = load('bouncerPos', null);
  function defPos() { return { x: window.innerWidth - SIZE - 16, y: window.innerHeight - SIZE - 96 }; }
  function clamp(p) { var w = document.documentElement.clientWidth || window.innerWidth, h = window.innerHeight; return { x: Math.round(Math.min(Math.max(M, p.x), Math.max(M, w - SIZE - M))), y: Math.round(Math.min(Math.max(M, p.y), Math.max(M, h - SIZE - M))) }; }
  function place(p) { var c = clamp(p); btn.style.left = c.x + 'px'; btn.style.top = c.y + 'px'; if (tipOn) placeTip(); return c; }
  function placeTip() { /* beside the button (left if there is room, else right), clamped inside the viewport; follows drags */
    var w = document.documentElement.clientWidth || window.innerWidth, h = window.innerHeight, bx = parseFloat(btn.style.left) || 0, by = parseFloat(btn.style.top) || 0;
    var tw = Math.min(290, w - 2 * M); tipEl.style.width = tw + 'px'; var th = tipEl.offsetHeight || 150, gap = 10;
    var x = bx - gap - tw >= M ? bx - gap - tw : bx + SIZE + gap + tw <= w - M ? bx + SIZE + gap : Math.min(Math.max(M, bx + SIZE / 2 - tw / 2), w - tw - M);
    var side = x + tw <= bx || x >= bx + SIZE;
    var y = side ? by + SIZE / 2 - th / 2 : (by - gap - th >= M ? by - gap - th : by + SIZE + gap);
    tipEl.style.left = Math.round(x) + 'px'; tipEl.style.top = Math.round(Math.min(Math.max(M, y), Math.max(M, h - th - M))) + 'px';
  }
  function showTip() { tipSeen = true; store('bouncerTipSeen', true); /* shown counts as seen: it appears only once, ever */
    tipEl.querySelector('#bouncerTipText').textContent = tipText(levels(demo), demo); tipEl.hidden = false; tipOn = true; tipShows++; placeTip(); }
  function hideTip() { if (!tipOn) return; tipOn = false; tipEl.hidden = true; store('bouncerTipSeen', true); }
  tipEl.addEventListener('click', function (e) { if (e.target.closest('[data-bx="tipok"]')) hideTip(); });
  place(pos || defPos());
  window.addEventListener('resize', function () { place(pos || defPos()); });
  var drag = null, suppress = false, tapAt = 0;
  btn.addEventListener('pointerdown', function (e) { if (e.button > 0) return; drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: parseFloat(btn.style.left) || 0, oy: parseFloat(btn.style.top) || 0, moving: false };
    try { btn.setPointerCapture(e.pointerId); } catch (x) {} }); // capture now so a fast first move still reaches us
  btn.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moving && Math.hypot(dx, dy) < B.BOUNCER_TAP_SLOP_PX) return;
    if (!drag.moving) { drag.moving = true; btn.classList.add('dragging'); }
    e.preventDefault(); place({ x: drag.ox + dx, y: drag.oy + dy });
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (drag.moving) { pos = clamp({ x: parseFloat(btn.style.left) || 0, y: parseFloat(btn.style.top) || 0 }); /* unscaled: the drag lift scales the button */ store('bouncerPos', pos); suppress = true; setTimeout(function () { suppress = false; }, 350); }
    else if (e && e.type === 'pointerup') { tapAt = Date.now(); toggle(!open); } /* a tap: act on pointerup (Chrome can drop the click right after a touch drag) */
    btn.classList.remove('dragging'); drag = null;
  }
  btn.addEventListener('pointerup', endDrag); btn.addEventListener('pointercancel', endDrag);
  btn.addEventListener('click', function (e) { /* pointer taps were handled on pointerup; this covers keyboard (Enter/Space) and scripted clicks */
    if (suppress || Date.now() - tapAt < 700 || e.detail > 0) { suppress = false; e.preventDefault(); return; } toggle(!open); });

  function toggle(on) {
    open = on; scrim.hidden = !on; btn.setAttribute('aria-expanded', String(on));
    if (on) { hideTip(); renderList(true); var c = scrim.querySelector('.bouncer-close'); if (c) c.focus({ preventScroll: true }); }
  }
  scrim.addEventListener('click', function (e) {
    if (e.target === scrim) return toggle(false);
    var b = e.target.closest('[data-bx]'); if (!b) return;
    if (b.dataset.bx === 'close') return toggle(false);
    if (b.dataset.bx === 'sim') simulate(b);
  });
  document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') toggle(false); });
  sensEl.addEventListener('change', function () { demo = sensEl.checked; store('bouncerDemoSens', demo); E.st = {}; E.flagged = []; E.count = 0; if (lastMkt) step(E, lastMkt, E.minute, levels(demo), lastInv); paint(); if (open) renderList(true); });

  var tT = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(tT); tT = setTimeout(function () { toastEl.classList.remove('on'); }, 2600); }
  function simulate(b) {
    var gr = E.flagged.filter(function (x) { return String(x.i) === b.dataset.h; })[0];
    var info = { demo: true, action: b.dataset.a, holder: gr ? gr.label : b.dataset.h, ticker: b.dataset.t || null, usd: b.dataset.usd ? +b.dataset.usd : null, shares: b.dataset.sh ? +b.dataset.sh : null, simMinute: E.minute };
    console.info('[Bouncer demo] Simulate (no effect, nothing traded):', info);
    var what = info.action === 'liquidate' ? 'liquidate ' + (info.shares || 0).toLocaleString() + ' sh of ' + info.ticker + ' inventory' : info.action === 'counter' ? 'buy a ' + money(info.usd || 0) + ' counter position' + (info.ticker ? ' in ' + info.ticker : '') : 'watch ' + info.holder;
    toast('Simulated (demo, no effect): ' + what);
  }

  function rowHtml(gr) {
    var lead = gr.items[0];
    var items = gr.items.map(function (it) {
      return '<div class="bx-item"><div class="bx-line"><b>' + esc(it.t) + '</b><span>K ' + money(it.K, 2) + '</span><span>now ' + money(it.S, 2) + '</span></div>' +
        '<div class="bx-line bx-gap"><span>gap <b>' + pct(it.gapPct) + '</b> · <b>' + money(it.gapUsd) + '</b></span><span>' + it.sh.toLocaleString() + ' sh covered</span><span>' + it.minutes + ' sim-min</span></div></div>';
    }).join('');
    var liq = gr.items.map(function (it) {
      return '<div class="bx-act"><span><b>a</b> Liquidate excess inventory in ' + esc(it.t) + ': ' + it.invSh.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' sh on hand (' + money(it.invValue) + ')</span>' +
        '<button type="button" data-bx="sim" data-a="liquidate" data-h="' + gr.i + '" data-t="' + esc(it.t) + '" data-sh="' + Math.round(it.invSh) + '">Simulate</button></div>';
    }).join('');
    return '<article class="bx-row" data-h="' + gr.i + '"><div class="bx-top"><b>' + esc(gr.label) + '</b><span class="bx-tot">' + money(gr.gapUsd) + ' gap</span></div>' + items +
      '<div class="bx-acts">' + liq +
      '<div class="bx-act"><span><b>b</b> Buy a counter position: ' + money(gr.counter) + ' <small>(' + Math.round(B.BOUNCER_COUNTER_PCT * 100) + '% of gap $, cap ' + money(B.BOUNCER_PER_HOLDER_CAP) + ')</small></span>' +
      '<button type="button" data-bx="sim" data-a="counter" data-h="' + gr.i + '" data-t="' + esc(lead.t) + '" data-usd="' + Math.round(gr.counter) + '">Simulate</button></div>' +
      '<div class="bx-act"><span><b>c</b> Do nothing / watch</span><button type="button" data-bx="sim" data-a="watch" data-h="' + gr.i + '">Simulate</button></div></div></article>';
  }
  var lastSig = '';
  function renderList(force) {
    var lv = levels(demo);
    trigEl.textContent = triggerText(lv) + (demo ? ' · demo sensitivity' : '');
    subEl.textContent = E.count ? E.count + ' of ' + E.holders.length + ' top-10% holders flagged · gap ≥ ' + fmtPct(lv.th) + ' for ' + B.BOUNCER_SUSTAIN_MIN + ' sim-min · sorted by gap $' : 'Watching the top 10% of holders (' + E.holders.length + ') by insured value. Nothing concerning.';
    var dl = levels(true); sensTxt.textContent = '(' + fmtPct(dl.th) + ' / ' + fmtPct(dl.clr) + ' instead of ' + fmtPct(B.BOUNCER_GAP_THRESHOLD) + ' / ' + fmtPct(B.BOUNCER_CLEAR) + '; for demos)';
    var sig = E.flagged.map(function (r) { return r.i + ':' + r.items.length; }).join(',');
    if (!force && sig === lastSig) { // same rows in the same order: patch numbers in place (keeps scroll and button presses intact)
      E.flagged.forEach(function (gr) { var el = listEl.querySelector('.bx-row[data-h="' + gr.i + '"]'); if (el) { var tmp = document.createElement('div'); tmp.innerHTML = rowHtml(gr); var a = el.querySelectorAll('.bx-item, .bx-tot, .bx-act > span'), b = tmp.querySelectorAll('.bx-item, .bx-tot, .bx-act > span'); for (var k = 0; k < a.length && k < b.length; k++) if (a[k].innerHTML !== b[k].innerHTML) a[k].innerHTML = b[k].innerHTML; } });
      return;
    }
    lastSig = sig; var st = listEl.scrollTop;
    listEl.innerHTML = E.flagged.length ? E.flagged.map(rowHtml).join('') : '<div class="bx-empty">No holder is past the trigger right now.' + (demo ? ' Try Demo → Crash.' : ' A Demo → Crash rarely opens a ' + fmtPct(lv.th) + ' gap; turn on Demo sensitivity to see it fire.') + '</div>';
    listEl.scrollTop = st;
  }
  function paint() {
    var n = E.count, badge = btn.querySelector('.bouncer-badge');
    if (tipDue(n, tipSeen)) showTip();
    btn.classList.toggle('alert', n > 0);
    badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
    btn.setAttribute('aria-label', n ? 'Bouncer: ' + n + ' holder' + (n === 1 ? '' : 's') + ' flagged, open details' : 'Bouncer: no holders flagged');
    if (open) renderList(false);
  }
  /** called by app.js once per sim tick with the crowd snapshot (confidence.js compute) and the running book */
  api.tick = function (cr, book) {
    if (!cr || !cr.legs) return;
    var mkt = {}; cr.legs.forEach(function (l) { mkt[l.d.t] = { K: l.K, S: l.S }; });
    var inv = {}; if (book && book.inv) Object.keys(book.inv).forEach(function (t) { var I = book.inv[t]; inv[t] = { sh: I.sh, value: I.sh * (I.px || 0) }; });
    lastMkt = mkt; lastInv = inv;
    step(E, mkt, book ? book.minutes : E.minute + 1, levels(demo), inv); paint();
  };
  api.reset = function () { E = create(E.holders); paint(); };
  api.state = function () { return { count: E.count, flagged: E.flagged, minute: E.minute, demo: demo, levels: levels(demo), tipShown: tipOn, tipSeen: tipSeen, tipShows: tipShows, holders: E.holders.length, open: open }; };
})(typeof window !== 'undefined' ? window : globalThis);
