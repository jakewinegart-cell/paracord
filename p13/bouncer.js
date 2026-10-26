/* Paracord — the Bouncer (DEMO ops alert). Watches the top 10% of individual crowd holders by insured value and flags any
 * holder-stock whose price sits far below the holder's insured level K: gap = (K - price) / K. A holder-stock is concerning once
 * the gap has held >= threshold for 15 sim-minutes; it clears under the clear level (hysteresis). The panel shows ONE warning
 * card per stock (bouncer2): the card is created when the first holder in that stock crosses, its numbers update in place every
 * tick (more holders crossing or the price falling further never adds a new warning), and it is removed when no holder in the
 * stock is still past the clear level. Badge = flagged stocks. Recommended actions are display-only: "Simulate" logs to the
 * console and shows a toast; nothing changes. Constants: PCNudge.BOUNCER (nudge.js). */
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
  function create(holders) { return { holders: holders || [], st: {}, stk: {}, minute: 0, flagged: [], count: 0, holderCount: 0 }; }
  /**
   * One sim minute. mkt: { t: { K, S } } (K = insured level for that name, S = price now), minute = book minute,
   * lv = { th, clr }, inv: { t: { sh, value } } Paracord-owned inventory (optional).
   */
  function step(E, mkt, minute, lv, inv) {
    E.minute = minute; inv = inv || {}; var stk = E.stk || (E.stk = {});
    var by = {}, hs = {};
    E.holders.forEach(function (h) {
      h.legs.forEach(function (l) {
        var m = mkt[l.t]; if (!m) return; var K = l.K > 0 ? l.K : m.K; if (!(K > 0)) return; // per-holder K if the leg carries one, else the name's K
        var key = h.i + ':' + l.t, s = E.st[key] || (E.st[key] = { since: null, on: false, from: null });
        var gap = (K - m.S) / K, cond = gap >= lv.th;
        s.since = NU.since(s.since, cond, minute);
        if (s.on) { if (gap < lv.clr) { s.on = false; s.from = null; } }
        else if (NU.held(s.since, minute, B.BOUNCER_SUSTAIN_MIN)) { s.on = true; s.from = s.since; }
        if (!s.on) return;
        var gapUsd = Math.max(0, K - m.S) * l.sh, ctr = counterSize(gapUsd);
        var c = by[l.t] || (by[l.t] = { t: l.t, S: m.S, Kmin: Infinity, Kmax: -Infinity, holders: [], n: 0, gapUsd: 0, counter: 0, worstGapPct: 0, firstFrom: Infinity,
          invSh: inv[l.t] ? inv[l.t].sh : 0, invValue: inv[l.t] ? inv[l.t].value : 0 });
        c.holders.push({ i: h.i, id: holderId(h.i), label: 'Holder #' + holderId(h.i), K: K, gapPct: gap, gapUsd: gapUsd, sh: l.sh, counter: ctr, minutes: minute - s.from });
        c.n++; c.gapUsd += gapUsd; c.counter += ctr; c.worstGapPct = Math.max(c.worstGapPct, gap); c.Kmin = Math.min(c.Kmin, K); c.Kmax = Math.max(c.Kmax, K); c.firstFrom = Math.min(c.firstFrom, s.from);
        hs[h.i] = 1;
      });
    });
    for (var t in stk) if (!by[t]) delete stk[t]; // cleared: no holder in it is still past the clear level
    var out = Object.keys(by).map(function (t) {
      var c = by[t];
      if (!stk[t]) stk[t] = { from: c.firstFrom }; // fixed when the stock is first flagged; holders joining later don't reset it
      c.from = stk[t].from; c.minutes = minute - c.from;
      c.gapPct = (c.Kmax - c.S) / c.Kmax; c.gapPerSh = Math.max(0, c.Kmax - c.S); c.gapPctLo = (c.Kmin - c.S) / c.Kmin; c.gapPerShLo = Math.max(0, c.Kmin - c.S);
      c.holders.sort(function (a, b) { return b.gapUsd - a.gapUsd || a.id - b.id; }); delete c.firstFrom;
      return c;
    });
    E.flagged = sortRows(out); E.count = out.length; E.holderCount = Object.keys(hs).length;
    return E;
  }
  function sortRows(rows) { return rows.sort(function (a, b) { return b.gapUsd - a.gapUsd || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0); }); }
  /* "Why am I seeing this?" tip: shown once ever, the first time the Bouncer fires; the % is the ACTIVE trigger */
  function fmtPct(x) { return String(+(x * 100).toFixed(1)) + '%'; }
  function triggerText(lv) { return 'Trigger: ' + fmtPct(lv.th) + ' gap (clears under ' + fmtPct(lv.clr) + ')'; }
  function tipDue(count, seen) { return count > 0 && !seen; }
  function tipText(lv, demo) {
    return 'The red pulse means one or more of the top 10% of holders have a gap of at least ' + fmtPct(lv.th) + ' between their insured level and the stock price, held for ' + B.BOUNCER_SUSTAIN_MIN + ' minutes. Tap the button to see which stocks, how many holders, and the suggested actions.' +
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
  btn.id = 'bouncer'; btn.className = 'bouncer'; btn.type = 'button'; btn.setAttribute('aria-label', 'Bouncer: no stocks flagged'); btn.setAttribute('aria-haspopup', 'dialog');
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
  /* default spot (bouncer2): beside the app column when there is room for it (desktop); otherwise bottom-LEFT just above the
     tab bar (phone), over the rows' name column, clear of the toggle / Sell action column on the right and of the tab bar */
  function defPos() {
    var w = document.documentElement.clientWidth || window.innerWidth, h = window.innerHeight, app = document.getElementById('app'), tabs = document.querySelector('.tabs');
    var ar = app ? app.getBoundingClientRect() : null, tt = tabs ? tabs.getBoundingClientRect().top : 0, bottom = tt > h / 2 && tt < h ? tt : h;
    if (ar && w - ar.right >= SIZE + 32) return { x: w - SIZE - 16, y: h - SIZE - 96 };
    return { x: M + 4, y: bottom - SIZE - 14 };
  }
  function clamp(p) { var w = document.documentElement.clientWidth || window.innerWidth, h = window.innerHeight; return { x: Math.round(Math.min(Math.max(M, p.x), Math.max(M, w - SIZE - M))), y: Math.round(Math.min(Math.max(M, p.y), Math.max(M, h - SIZE - M))) }; }
  function place(p) { var c = clamp(p); btn.style.left = c.x + 'px'; btn.style.top = c.y + 'px'; if (tipOn) placeTip(); return c; }
  function placeTip() { /* bouncer2: ABOVE the button (else below / beside), kept clear of the tab bar so it never blocks tab taps; follows drags */
    var w = document.documentElement.clientWidth || window.innerWidth, h = window.innerHeight, bx = parseFloat(btn.style.left) || 0, by = parseFloat(btn.style.top) || 0;
    var tabs = document.querySelector('.tabs'), tt = tabs ? tabs.getBoundingClientRect().top : h, floor = (tt > h / 2 && tt < h ? tt : h) - M;
    var tw = Math.min(290, w - 2 * M); tipEl.style.width = tw + 'px'; var th = tipEl.offsetHeight || 150, gap = 10, x, y;
    var cx = Math.min(Math.max(M, bx + SIZE / 2 - tw / 2), w - tw - M);
    if (by - gap - th >= M) { x = cx; y = by - gap - th; }                                  // above
    else if (by + SIZE + gap + th <= floor) { x = cx; y = by + SIZE + gap; }                 // below, still above the tab bar
    else { x = bx - gap - tw >= M ? bx - gap - tw : bx + SIZE + gap + tw <= w - M ? bx + SIZE + gap : cx; y = Math.min(by + SIZE / 2 - th / 2, floor - th); } // beside
    tipEl.style.left = Math.round(x) + 'px'; tipEl.style.top = Math.round(Math.max(M, y)) + 'px';
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
  sensEl.addEventListener('change', function () { demo = sensEl.checked; store('bouncerDemoSens', demo); E.st = {}; E.stk = {}; E.flagged = []; E.count = 0; E.holderCount = 0; if (lastMkt) step(E, lastMkt, E.minute, levels(demo), lastInv); paint(); if (open) renderList(true); });

  var tT = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(tT); tT = setTimeout(function () { toastEl.classList.remove('on'); }, 2600); }
  function simulate(b) {
    var c = E.flagged.filter(function (x) { return x.t === b.dataset.t; })[0];
    var info = { demo: true, action: b.dataset.a, ticker: b.dataset.t || null, holders: c ? c.n : null, usd: b.dataset.usd ? +b.dataset.usd : null, shares: b.dataset.sh ? +b.dataset.sh : null, simMinute: E.minute };
    console.info('[Bouncer demo] Simulate (no effect, nothing traded):', info);
    var what = info.action === 'liquidate' ? 'liquidate ' + (info.shares || 0).toLocaleString() + ' sh of ' + info.ticker + ' inventory' : info.action === 'counter' ? 'buy a ' + money(info.usd || 0) + ' counter position in ' + info.ticker : 'watch ' + info.ticker;
    toast('Simulated (demo, no effect): ' + what);
  }

  /* one card per flagged stock; [data-f] fields are patched in place every tick (no re-render, no new warning) */
  function kTxt(c) { return c.Kmin === c.Kmax ? 'K ' + money(c.Kmax, 2) : 'K ' + money(c.Kmin, 2) + ' to ' + money(c.Kmax, 2); }
  function dropTxt(c) { return c.Kmin === c.Kmax ? 'gap <b>' + pct(c.gapPct) + '</b> · <b>' + money(c.gapPerSh, 2) + '</b>/sh below K'
    : 'gap <b>' + pct(c.gapPctLo) + '–' + pct(c.gapPct) + '</b> · <b>' + money(c.gapPerShLo, 2) + '–' + money(c.gapPerSh, 2) + '</b>/sh below K'; }
  function fields(c) {
    return {
      now: 'now ' + money(c.S, 2), tot: money(c.gapUsd) + ' total gap', k: kTxt(c), drop: dropTxt(c),
      n: '<b>' + c.n + '</b> top-10% holder' + (c.n === 1 ? '' : 's') + ' past the trigger', worst: 'worst holder gap <b>' + pct(c.worstGapPct) + '</b>', min: 'flagged ' + c.minutes + ' sim-min',
      sum: 'Holders (' + c.n + ')',
      liq: '<b>a</b> Liquidate excess inventory in ' + esc(c.t) + ': ' + c.invSh.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' sh on hand (' + money(c.invValue) + ')',
      ctr: '<b>b</b> Counter position: ' + money(c.counter) + ' <small>(sum over ' + c.n + ' holder' + (c.n === 1 ? '' : 's') + ' of ' + Math.round(B.BOUNCER_COUNTER_PCT * 100) + '% of each gap $, cap ' + money(B.BOUNCER_PER_HOLDER_CAP) + ' per holder)</small>'
    };
  }
  function holdersHtml(c) {
    return c.holders.map(function (h) { return '<div class="bx-h"><span>' + esc(h.label) + '</span><span>K ' + money(h.K, 2) + '</span><span>gap ' + pct(h.gapPct) + ' · ' + money(h.gapUsd) + '</span><span>' + h.sh.toLocaleString() + ' sh</span><span>' + h.minutes + ' sim-min</span></div>'; }).join('');
  }
  function cardHtml(c) {
    var f = fields(c);
    return '<article class="bx-row bx-stock" data-t="' + esc(c.t) + '"><div class="bx-top"><b class="bx-tk">' + esc(c.t) + '</b><span class="bx-now" data-f="now">' + f.now + '</span><span class="bx-tot" data-f="tot">' + f.tot + '</span></div>' +
      '<div class="bx-line"><span data-f="k">' + f.k + '</span><span class="bx-drop" data-f="drop">' + f.drop + '</span></div>' +
      '<div class="bx-line bx-gap"><span data-f="n">' + f.n + '</span><span data-f="worst">' + f.worst + '</span><span data-f="min">' + f.min + '</span></div>' +
      '<details class="bx-holders"><summary data-f="sum">' + f.sum + '</summary><div class="bx-hlist"></div></details>' +
      '<div class="bx-acts"><div class="bx-act"><span data-f="liq">' + f.liq + '</span><button type="button" data-bx="sim" data-a="liquidate" data-t="' + esc(c.t) + '" data-sh="' + Math.round(c.invSh) + '">Simulate</button></div>' +
      '<div class="bx-act"><span data-f="ctr">' + f.ctr + '</span><button type="button" data-bx="sim" data-a="counter" data-t="' + esc(c.t) + '" data-usd="' + Math.round(c.counter) + '">Simulate</button></div>' +
      '<div class="bx-act"><span><b>c</b> Do nothing / watch</span><button type="button" data-bx="sim" data-a="watch" data-t="' + esc(c.t) + '">Simulate</button></div></div></article>';
  }
  function patchCard(el, c) {
    var f = fields(c);
    el.querySelectorAll('[data-f]').forEach(function (x) { var v = f[x.dataset.f]; if (v != null && x.innerHTML !== v) x.innerHTML = v; });
    var bl = el.querySelector('[data-a="liquidate"]'), bc = el.querySelector('[data-a="counter"]');
    if (bl) bl.dataset.sh = Math.round(c.invSh); if (bc) bc.dataset.usd = Math.round(c.counter);
    var d = el.querySelector('.bx-holders'); if (d && d.open) { var hl = d.querySelector('.bx-hlist'), hh = holdersHtml(c); if (hl.innerHTML !== hh) hl.innerHTML = hh; }
  }
  var cardsMade = 0; // diagnostics: how many cards were ever created (one per stock flag-up)
  function renderList(force) {
    var lv = levels(demo);
    trigEl.textContent = triggerText(lv) + (demo ? ' · demo sensitivity' : '');
    subEl.textContent = E.count ? E.count + ' stock' + (E.count === 1 ? '' : 's') + ' flagged · ' + E.holderCount + ' of ' + E.holders.length + ' top-10% holders · gap ≥ ' + fmtPct(lv.th) + ' for ' + B.BOUNCER_SUSTAIN_MIN + ' sim-min · sorted by total gap $'
      : 'Watching the top 10% of holders (' + E.holders.length + ') by insured value. Nothing concerning.';
    var dl = levels(true); sensTxt.textContent = '(' + fmtPct(dl.th) + ' / ' + fmtPct(dl.clr) + ' instead of ' + fmtPct(B.BOUNCER_GAP_THRESHOLD) + ' / ' + fmtPct(B.BOUNCER_CLEAR) + '; for demos)';
    var empty = listEl.querySelector('.bx-empty');
    if (!E.flagged.length) {
      listEl.querySelectorAll('.bx-stock').forEach(function (el) { el.remove(); });
      if (!empty) listEl.innerHTML = '<div class="bx-empty">No stock has a holder past the trigger right now.' + (demo ? ' Try Demo → Crash.' : ' A Demo → Crash rarely opens a ' + fmtPct(lv.th) + ' gap; turn on Demo sensitivity to see it fire.') + '</div>';
      return;
    }
    if (empty) empty.remove();
    var have = {}; listEl.querySelectorAll('.bx-stock').forEach(function (el) { have[el.dataset.t] = el; });
    var want = {}; E.flagged.forEach(function (c) { want[c.t] = 1; });
    for (var t in have) if (!want[t]) { have[t].remove(); delete have[t]; } // stock cleared: its card goes
    var st = listEl.scrollTop, prev = null;
    E.flagged.forEach(function (c) {
      var el = have[c.t];
      if (!el) { var tmp = document.createElement('div'); tmp.innerHTML = cardHtml(c); el = tmp.firstChild; cardsMade++; }
      else patchCard(el, c);
      var next = prev ? prev.nextSibling : listEl.firstChild;
      if (el !== next) listEl.insertBefore(el, next); // keep sorted by total gap $ (moves the node; open holder lists stay open)
      prev = el;
    });
    listEl.scrollTop = st;
  }
  listEl.addEventListener('toggle', function (e) { var d = e.target; if (!d.classList || !d.classList.contains('bx-holders') || !d.open) return; var el = d.closest('.bx-stock'), c = E.flagged.filter(function (x) { return x.t === el.dataset.t; })[0]; if (c) d.querySelector('.bx-hlist').innerHTML = holdersHtml(c); }, true);
  function paint() {
    var n = E.count, badge = btn.querySelector('.bouncer-badge');
    if (tipDue(n, tipSeen)) showTip();
    btn.classList.toggle('alert', n > 0);
    badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
    btn.setAttribute('aria-label', n ? 'Bouncer: ' + n + ' stock' + (n === 1 ? '' : 's') + ' flagged, open details' : 'Bouncer: no stocks flagged');
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
  api.state = function () { return { count: E.count, holderCount: E.holderCount, cardsMade: cardsMade, flagged: E.flagged, minute: E.minute, demo: demo, levels: levels(demo), tipShown: tipOn, tipSeen: tipSeen, tipShows: tipShows, holders: E.holders.length, open: open }; };
})(typeof window !== 'undefined' ? window : globalThis);
