/* Paracord — the Bouncer (DEMO ops alert): panel + app adapter. The engine (per-holder K, session-minute sustain, clear
 * hysteresis, stale feed handling) lives in bouncer-core.js and the market calendar in market.js; both are DOM-free and shared
 * with the tests, the real-price replay and a future Cloudflare Worker. The panel shows ONE warning card per stock (bouncer2),
 * updated in place, removed when no holder in the stock is still past the clear level. Badge = flagged stocks.
 * ALERT-ONLY (securities-law review): the panel shows neutral risk information - the stock, its live drop, how many top holders
 * are affected, the combined gap $ (exposure), the K range, session status and stale state. It recommends no action and computes
 * no trade or position. Constants: PCBouncerCore.BOUNCER. */
(function (g) {
  'use strict';
  var req = typeof require !== 'undefined' ? require : null;
  var CORE = g.PCBouncerCore || req('./bouncer-core.js'), MK = g.PCMarket || (req ? req('./market.js') : null);
  var B = CORE.BOUNCER, PREFIX = 'p13:';
  var holderId = CORE.holderId, topHolders = CORE.topHolders, levels = CORE.levels, create = CORE.create, step = CORE.step, sortRows = CORE.sortRows;
  var K_AS_OF = '2026-10-23', K_LOCK_DAYS = 15, K_STORE = 'bouncerK', K_SALT = 'k2'; // k2: smooth lock-price spread (k1 hard-clipped, so ~22% of legs shared a capped K)
  /**
   * Seeded protected prices for the demo crowd (sim mode). The demo has no price history before the Oct 23 snapshot, so each
   * holder's lock-in price is a seeded stand-in: snapshot px x exp(daily vol x sqrt(sessions back) x z), squashed smoothly (tanh)
   * into 0.90-1.04 x px; K = lock price x strike (90/92/95/97%). Lock dates: the 15 sessions up to Oct 23. Deterministic per
   * (holder, ticker); computed once and stored (p13:bouncerK) - never from the page-load time, never reset by a new morning.
   */
  function seedDemoK(holders, defs) {
    var dates = [], d = K_AS_OF; for (var i = 0; i < K_LOCK_DAYS; i++) { dates.unshift(d); d = MK.prevTradingDay(d); }
    return CORE.seedK(holders, { lockDates: dates, salt: K_SALT, priceOn: function (t, date, r) {
      var df = defs[t]; if (!df) return null; var px = df.px || df.p0; if (!(px > 0)) return null;
      var n = dates.length - 1 - dates.indexOf(date), u = Math.max(1e-9, r()), v = r(), z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      // log-move over n sessions at the name's vol, squashed smoothly (tanh) into 0.90..1.04 x the Oct 23 price: no hard clip, so no
      // two holders share a K just because both hit a cap; K <= 1.04 x 0.97 of the price, so nobody starts past even the demo trigger
      var r0 = (df.vol || 0.3) / Math.sqrt(252) * Math.sqrt(n) * z, lo = Math.log(0.90), hi = Math.log(1.04), mid = (lo + hi) / 2, hw = (hi - lo) / 2;
      return px * Math.exp(mid + hw * Math.tanh((r0 - mid) / hw));
    } });
  }
  /* "Why am I seeing this?" tip: shown once ever, the first time the Bouncer fires; the % is the ACTIVE trigger */
  function fmtPct(x) { return String(+(x * 100).toFixed(1)) + '%'; }
  function triggerText(lv) { return 'Trigger: ' + fmtPct(lv.th) + ' gap (clears under ' + fmtPct(lv.clr) + ')'; }
  function tipDue(count, seen) { return count > 0 && !seen; }
  function tipText(lv, demo) {
    return 'This is a risk alert only. The red pulse means that, in one or more stocks, at least one of the top 10% of holders has had a gap of ' + fmtPct(lv.th) + ' or more between their protected price (K) and the stock price for ' + B.BOUNCER_SUSTAIN_MIN + ' minutes of market session. Tap the button to see the stocks, how far each has dropped, how many holders are affected and their combined gap. Each flagged stock also lists all possible actions, in the same fixed order for every stock and unranked: this is not a recommendation, and nothing places an order.' +
      (demo ? ' Demo sensitivity is on, so the trigger is lowered from ' + fmtPct(B.BOUNCER_GAP_THRESHOLD) + ' to ' + fmtPct(lv.th) + '.' : '');
  }
  /* p13f4 "Possible actions": the FULL set of options a firm could take on its own risk, from Paracord's perspective, shown on every flagged card.
   * Neutral by construction: one fixed order for every stock and state (never sorted or filtered by the stock's situation), equal styling, no default,
   * no ranking, no sizes or amounts, nothing executes (tapping an item only expands its one-line description). Static: built once, no stock data. */
  var POSSIBLE_ACTIONS = Object.freeze([
    Object.freeze({ id: 'hold', label: 'Hold / take no action', what: 'Keeps current positions and coverage as they are.', tradeoff: 'Exposure to this stock stays where it is.' }),
    Object.freeze({ id: 'monitor', label: 'Monitor more closely (set a price alert)', what: 'Watches this stock more often through a price alert.', tradeoff: 'Adds attention; exposure stays where it is.' }),
    Object.freeze({ id: 'buy', label: 'Buy shares', what: 'Adds shares of this stock to the firm\'s own book.', tradeoff: 'Raises the firm\'s exposure to further moves.' }),
    Object.freeze({ id: 'sell', label: 'Sell or reduce existing inventory', what: 'Lowers the firm\'s existing holding in this stock.', tradeoff: 'Cuts exposure; may realize a gain or a loss.' }),
    Object.freeze({ id: 'hedge', label: 'Hedge with listed puts', what: 'Buys exchange-listed put options on this stock.', tradeoff: 'Offsets part of a further drop; costs a premium.' }),
    Object.freeze({ id: 'pause', label: 'Pause new coverage on this stock', what: 'Stops writing new coverage on this stock for a time.', tradeoff: 'Limits new exposure and new premium income.' }),
    Object.freeze({ id: 'review', label: 'Review with counsel or risk', what: 'Refers this stock to legal or risk review.', tradeoff: 'Adds an outside view; takes time to complete.' })
  ]);
  var OPTS_DISCLAIMER = 'All possible actions, listed in the same order for every stock. Not a recommendation. Nothing here places an order.';
  function optsHtml() {
    return '<section class="bx-opts" aria-label="Possible actions"><div class="bx-opts-h">Possible actions</div><p class="bx-opts-note">' + OPTS_DISCLAIMER + '</p><ul class="bx-opts-list">' +
      POSSIBLE_ACTIONS.map(function (o) { return '<li class="bx-opt"><details><summary>' + o.label + '</summary><p>' + o.what + ' Tradeoff: ' + o.tradeoff + '</p></details></li>'; }).join('') + '</ul></section>';
  }
  var OPTS_HTML = optsHtml();
  var api = { fmtPct: fmtPct, triggerText: triggerText, tipDue: tipDue, tipText: tipText, holderId: holderId, topHolders: topHolders, levels: levels, create: create, step: step, sortRows: sortRows, seedDemoK: seedDemoK, K_AS_OF: K_AS_OF, core: CORE, POSSIBLE_ACTIONS: POSSIBLE_ACTIONS, OPTS_DISCLAIMER: OPTS_DISCLAIMER, optsHtml: optsHtml };
  g.PCBouncer = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  /* ---------------- UI (browser) ---------------- */
  function load(k, d) { try { var v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function store(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} }
  var crowd = g.PCConfidence && g.PCConfidence.crowd, TOP = crowd && crowd.holders ? topHolders(crowd.holders).map(function (h) { return { i: h.i, insured: h.insured, legs: h.legs.map(function (l) { return { t: l.t, sh: l.sh }; }) }; }) : [];
  // bouncerfix1: one fixed K per holder-leg, set at that holder's lock date, persisted with the demo state
  var kStore = load(K_STORE, null), KMAP;
  if (kStore && kStore.v === 1 && kStore.salt === K_SALT && kStore.k) KMAP = kStore.k;
  else { KMAP = seedDemoK(TOP, g.PC_UNIVERSE_BY_T || {}); store(K_STORE, { v: 1, salt: K_SALT, asOf: K_AS_OF, seededAt: 'deterministic (holder, ticker); not time-based', k: KMAP }); }
  CORE.applyK(TOP, KMAP, MK.nextTradingDay);
  var E = create(TOP), lastClk = null, feedDrop = {};
  // feed mode: 'sim' (default) prices every name incl. the fictional MOON; '?feed=real' previews a real market-data feed, which has
  // no row for fictional tickers, so the Bouncer gets no MOON price and lists it under "No price data" (prices of real names stay
  // simulated in this preview; the real-price run of this same engine is the offline replay)
  var FEED = typeof location !== 'undefined' && /[?&]feed=real(&|$)/.test(location.search) ? 'real' : 'sim';
  if (FEED === 'real') Object.keys(g.PC_UNIVERSE_BY_T || {}).forEach(function (t) { if (g.PC_UNIVERSE_BY_T[t].fictional) feedDrop[t] = 1; });
  // bouncerfix2 (p13f2): demo sensitivity is SESSION-ONLY - always off on load, never saved. Earlier builds saved it under
  // 'p13:bouncerDemoSens', so a returning visitor silently kept the 2% demo trigger; that old key is removed here.
  try { localStorage.removeItem(PREFIX + 'bouncerDemoSens'); } catch (e) {}
  var demo = false, tipSeen = load('bouncerTipSeen', false) === true, tipOn = false, tipShows = 0, open = false, lastMkt = null;
  function money(x, d) { return (x < 0 ? '−' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var btn = document.createElement('button');
  btn.id = 'bouncer'; btn.className = 'bouncer'; btn.type = 'button'; btn.setAttribute('aria-label', 'Bouncer: no stocks flagged'); btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 21.5c1-1 2.3-1.7 3.5-2.5 2-1.3 3.3-2.4 3.3-3.6s-1-2.2-2.1-2.8"/><path d="M10.8 11.4C7.6 9.8 6.2 7.8 6.8 5.6 7.4 3.6 9.6 2.5 12 2.5s4.6 1.1 5.2 3.1c.6 2.2-1.7 4.6-5.2 6.4-2 1-3.3 2.2-3.3 3.4s1 2.2 2.1 2.9"/><path d="M13.2 19.8c1 .6 1.8 1.2 2.3 1.7"/></svg><span class="bouncer-demotag" hidden>DEMO</span><span class="bouncer-badge" hidden></span>';
  document.body.appendChild(btn);
  var scrim = document.createElement('div'); scrim.className = 'bouncer-scrim'; scrim.hidden = true;
  scrim.innerHTML = '<section class="bouncer-panel" role="dialog" aria-modal="true" aria-labelledby="bouncerTitle"><div class="bouncer-grab"></div>' +
    '<header class="bouncer-head"><div><h2 id="bouncerTitle">Bouncer</h2><div class="bouncer-sub" id="bouncerSub"></div><div class="bouncer-session" id="bouncerSession" data-state=""></div></div><button class="bouncer-close" type="button" aria-label="Close" data-bx="close">✕</button></header>' +
    '<div class="bouncer-trigger" id="bouncerTrigger"></div><div class="bouncer-demobar" id="bouncerDemoBar" hidden></div><label class="bouncer-sens"><input type="checkbox" id="bouncerDemoSens"> Demo sensitivity <span id="bouncerSensTxt"></span></label>' +
    '<div class="bouncer-list" id="bouncerList"></div>' +
    '<p class="bouncer-note">Demo only. Risk information only: not a recommendation to buy, sell or take any other action.</p></section>';
  document.body.appendChild(scrim);
  var listEl = scrim.querySelector('#bouncerList'), subEl = scrim.querySelector('#bouncerSub'), sensEl = scrim.querySelector('#bouncerDemoSens'), sensTxt = scrim.querySelector('#bouncerSensTxt'), trigEl = scrim.querySelector('#bouncerTrigger'), demoBar = scrim.querySelector('#bouncerDemoBar'), sessEl = scrim.querySelector('#bouncerSession');
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
  });
  document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') toggle(false); });
  function setDemo(on) { demo = !!on; sensEl.checked = demo; E.st = {}; E.stk = {}; E.flagged = []; E.count = 0; E.holderCount = 0; if (lastMkt) step(E, lastMkt, E.minute, levels(demo), lastClk); paint(); if (open) renderList(true); }
  sensEl.addEventListener('change', function () { setDemo(sensEl.checked); }); // session-only: not stored

  /* one card per flagged stock; [data-f] fields are patched in place every tick (no re-render, no new warning) */
  function kTxt(c) { return c.Kmin === c.Kmax ? 'K ' + money(c.Kmax, 2) : 'K ' + money(c.Kmin, 2) + ' to ' + money(c.Kmax, 2); }
  function dropTxt(c) { return c.Kmin === c.Kmax ? 'gap <b>' + pct(c.gapPct) + '</b> · <b>' + money(c.gapPerSh, 2) + '</b>/sh below K'
    : 'gap <b>' + pct(c.gapPctLo) + '–' + pct(c.gapPct) + '</b> · <b>' + money(c.gapPerShLo, 2) + '–' + money(c.gapPerSh, 2) + '</b>/sh below K'; }
  function staleTxt(c) { return c.stale ? '<span class="bx-stale">Price stale · no update for ' + c.staleMin + ' session-min</span>' : ''; }
  /** live drop: today's move vs the previous session's close (app.js supplies prevCloseOf; factual, no direction implied) */
  function chgTxt(c) { var f = api.prevCloseOf || (g.__paracord && g.__paracord.prevCloseOf), pc = f ? f(c.t) : null; if (!(pc > 0)) return ''; var x = c.S / pc - 1;
    return '<span class="' + (x < 0 ? 'bx-down' : 'bx-up') + '">' + (x < 0 ? 'down ' : 'up ') + pct(Math.abs(x)) + '</span> vs prev close'; }
  function lockTxt(h) { return h.lockedOn ? ' <small>locked ' + MK.dateLabel(h.lockedOn).slice(4) + '</small>' : ''; }
  function fields(c) {
    return {
      now: 'now ' + money(c.S, 2), chg: chgTxt(c), tot: money(c.gapUsd) + ' combined gap', k: kTxt(c), drop: dropTxt(c),
      n: '<b>' + c.n + '</b> top-10% holder' + (c.n === 1 ? '' : 's') + ' past the trigger', worst: 'worst holder gap <b>' + pct(c.worstGapPct) + '</b>', min: 'flagged ' + c.minutes + ' session-min', stale: staleTxt(c),
      sum: 'Holders (' + c.n + ')'
    };
  }
  function holdersHtml(c) {
    return c.holders.map(function (h) { return '<div class="bx-h"><span>' + esc(h.label) + '</span><span>K ' + money(h.K, 2) + lockTxt(h) + '</span><span>gap ' + pct(h.gapPct) + ' · ' + money(h.gapUsd) + '</span><span>' + h.sh.toLocaleString() + ' sh</span><span>' + h.minutes + ' session-min</span></div>'; }).join('');
  }
  function cardHtml(c) {
    var f = fields(c);
    return '<article class="bx-row bx-stock" data-t="' + esc(c.t) + '"><div class="bx-top"><b class="bx-tk">' + esc(c.t) + '</b><span class="bx-now" data-f="now">' + f.now + '</span><span class="bx-chg" data-f="chg">' + f.chg + '</span><span class="bx-tot" data-f="tot">' + f.tot + '</span></div>' +
      '<div class="bx-stale-line" data-f="stale">' + f.stale + '</div>' +
      '<div class="bx-line"><span data-f="k">' + f.k + '</span><span class="bx-drop" data-f="drop">' + f.drop + '</span></div>' +
      '<div class="bx-line bx-gap"><span data-f="n">' + f.n + '</span><span data-f="worst">' + f.worst + '</span><span data-f="min">' + f.min + '</span></div>' +
      '<details class="bx-holders"><summary data-f="sum">' + f.sum + '</summary><div class="bx-hlist"></div></details>' + OPTS_HTML + '</article>';
  }
  function patchCard(el, c) {
    var f = fields(c);
    el.querySelectorAll('[data-f]').forEach(function (x) { var v = f[x.dataset.f]; if (v != null && x.innerHTML !== v) x.innerHTML = v; });
    var d = el.querySelector('.bx-holders'); if (d && d.open) { var hl = d.querySelector('.bx-hlist'), hh = holdersHtml(c); if (hl.innerHTML !== hh) hl.innerHTML = hh; }
  }
  var cardsMade = 0; // diagnostics: how many cards were ever created (one per stock flag-up)
  function renderList(force) {
    var lv = levels(demo);
    trigEl.textContent = triggerText(lv) + (demo ? ' · demo sensitivity' : '');
    demoBar.hidden = !demo;
    if (demo) { var dt = 'DEMO ' + fmtPct(lv.th) + ' trigger: demo sensitivity is on, so far more stocks are flagged than at the real ' + fmtPct(B.BOUNCER_GAP_THRESHOLD) + ' trigger. It turns off when you reload.'; if (demoBar.textContent !== dt) demoBar.textContent = dt; }
    subEl.textContent = E.count ? E.count + ' stock' + (E.count === 1 ? '' : 's') + ' flagged · ' + E.holderCount + ' of ' + E.holders.length + ' top-10% holders · gap ≥ ' + fmtPct(lv.th) + ' for ' + B.BOUNCER_SUSTAIN_MIN + ' session-min · sorted by combined gap $'
      : 'Watching the top 10% of holders (' + E.holders.length + ') by insured value. Nothing concerning.';
    var dl = levels(true); sensTxt.textContent = '(' + fmtPct(dl.th) + ' / ' + fmtPct(dl.clr) + ' instead of ' + fmtPct(B.BOUNCER_GAP_THRESHOLD) + ' / ' + fmtPct(B.BOUNCER_CLEAR) + '; for demos)';
    sessionLine();
    var np = notesHtml(), nEl = listEl.querySelector('.bx-notes');
    var empty = listEl.querySelector('.bx-empty');
    if (!E.flagged.length) {
      listEl.querySelectorAll('.bx-stock').forEach(function (el) { el.remove(); });
      var et = 'No stock has a holder past the trigger right now.' + (demo ? ' Try Demo → Crash.' : ' A Demo → Crash rarely opens a ' + fmtPct(lv.th) + ' gap; turn on Demo sensitivity to see it fire.');
      if (!empty) listEl.innerHTML = '<div class="bx-empty">' + et + '</div>'; else if (empty.textContent !== et) empty.textContent = et; // p13f2: follows the demo switch
      setNotes(np); return;
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
      if (el !== next) listEl.insertBefore(el, next); // keep sorted by combined gap $ (moves the node; open holder lists stay open)
      prev = el;
    });
    setNotes(np); listEl.scrollTop = st;
  }
  function notesHtml() {
    var a = [];
    if (E.noPrice && E.noPrice.length) a.push('<div class="bx-note bx-noprice">No price data: ' + E.noPrice.map(function (x) { return '<b>' + esc(x.t) + '</b> (' + x.legs + ' top-holder position' + (x.legs === 1 ? '' : 's') + ')'; }).join(', ') + ' - not watched until a price arrives.</div>');
    var st = (E.stale || []).filter(function (x) { return !E.flagged.some(function (c) { return c.t === x.t; }); });
    if (st.length) a.push('<div class="bx-note bx-stalenote">Stale prices (no update for more than ' + B.BOUNCER_STALE_HOLD_MIN + ' session-min): ' + st.slice(0, 8).map(function (x) { return esc(x.t); }).join(', ') + (st.length > 8 ? ' +' + (st.length - 8) + ' more' : '') + '.</div>');
    return a.join('');
  }
  function setNotes(h) {
    var el = listEl.querySelector('.bx-notes');
    if (!h) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'bx-notes'; }
    if (el.innerHTML !== h) el.innerHTML = h;
    if (el !== listEl.lastChild) listEl.appendChild(el);
  }
  function sessionLine() {
    if (!sessEl) return;
    var L = lastClk && lastClk.at != null && MK ? MK.label(lastClk.at) : null;
    if (!L) { sessEl.textContent = ''; return; }
    var h = '<i class="bx-dot"></i><b>' + esc(L.title) + '</b> · ' + esc(L.text) + (L.state === 'open' ? ' · ' + L.minsLeft + ' min left' : '') +
      '<div class="bx-sess-note">' + (FEED === 'real' ? 'Feed: real-data mode (preview). ' : '') + (L.state === 'open' ? 'Sustain counts session minutes; timers reset at the close.' : 'Alerts stay up while closed; sustain timers restart at the next open.') + '</div>';
    if (sessEl.dataset.state !== L.state) sessEl.dataset.state = L.state;
    if (sessEl.innerHTML !== h) sessEl.innerHTML = h;
  }
  listEl.addEventListener('toggle', function (e) { var d = e.target; if (!d.classList || !d.classList.contains('bx-holders') || !d.open) return; var el = d.closest('.bx-stock'), c = E.flagged.filter(function (x) { return x.t === el.dataset.t; })[0]; if (c) d.querySelector('.bx-hlist').innerHTML = holdersHtml(c); }, true);
  function paint() {
    var n = E.count, badge = btn.querySelector('.bouncer-badge');
    if (tipDue(n, tipSeen)) showTip();
    btn.classList.toggle('alert', n > 0);
    badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
    var tag = btn.querySelector('.bouncer-demotag'), dtag = 'DEMO ' + fmtPct(levels(true).th); tag.hidden = !demo; if (tag.textContent !== dtag) tag.textContent = dtag; btn.classList.toggle('demo', demo);
    btn.setAttribute('aria-label', (n ? 'Bouncer: ' + n + ' stock' + (n === 1 ? '' : 's') + ' flagged, open details' : 'Bouncer: no stocks flagged') + (demo ? ' (demo ' + fmtPct(levels(true).th) + ' trigger on)' : ''));
    if (open) renderList(false);
  }
  /** called by app.js once per sim tick with the crowd snapshot (confidence.js compute), the running book and the market clock
   *  clk = { at: sim market instant (ms), key: session date, ord: PCMarket.ordinal, open } (bouncerfix1). Per-holder K comes
   *  from the stored seed, not from the crowd snapshot; the snapshot only supplies prices. */
  api.tick = function (cr, book, clk) {
    var mkt = {};
    if (cr && cr.legs) cr.legs.forEach(function (l) { if (!feedDrop[l.d.t]) mkt[l.d.t] = { K: l.K, S: l.S }; });
    else if (!(clk && clk.open === false)) return;
    lastMkt = mkt; lastClk = clk || null;
    step(E, mkt, book ? book.minutes : E.minute + 1, levels(demo), clk || null); paint();
    if (open) sessionLine();
  };
  /** test / demo hook: leave these tickers out of the feed (simulates a dropped or missing real-data feed row) */
  api.feedDrop = function (list) { feedDrop = {}; if (FEED === 'real') Object.keys(g.PC_UNIVERSE_BY_T || {}).forEach(function (t) { if (g.PC_UNIVERSE_BY_T[t].fictional) feedDrop[t] = 1; }); (list || []).forEach(function (t) { feedDrop[t] = 1; }); };
  api.kmap = function () { return KMAP; };
  api.reset = function () { E = create(E.holders); paint(); };
  api.reseedK = function () { KMAP = seedDemoK(TOP, g.PC_UNIVERSE_BY_T || {}); store(K_STORE, { v: 1, salt: K_SALT, asOf: K_AS_OF, seededAt: 'deterministic (holder, ticker); not time-based', k: KMAP }); CORE.applyK(TOP, KMAP, MK.nextTradingDay); E = create(TOP); paint(); };
  api.setDemo = function (on) { setDemo(on); }; // session-only switch (tests / demos); never persisted
  api.state = function () { return { count: E.count, holderCount: E.holderCount, cardsMade: cardsMade, flagged: E.flagged, minute: E.minute, session: E.key, feed: FEED, marketOpen: E.open, noPrice: E.noPrice, stale: E.stale, clk: lastClk, demo: demo, levels: levels(demo), tipShown: tipOn, tipSeen: tipSeen, tipShows: tipShows, holders: E.holders.length, open: open }; };
})(typeof window !== 'undefined' ? window : globalThis);
