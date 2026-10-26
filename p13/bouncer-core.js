/* Paracord — Bouncer engine (bouncerfix1). Pure and DOM-free: the browser panel (bouncer.js), the Node tests, the real-price
 * replay and a future Cloudflare Worker all run this same file. Time is measured in SESSION minutes from PCMarket (market.js).
 *
 * Gap per holder-stock: (K - S) / K with the HOLDER'S OWN protected price K (fixed when that holder's coverage / lock started,
 * never reset by page loads or by a new morning, so overnight gaps and multi-day slides count against it).
 *  - fires once the gap has stayed >= trigger for BOUNCER_SUSTAIN_MIN consecutive session minutes;
 *  - clears only once the gap has stayed <= the clear level for BOUNCER_CLEAR_SUSTAIN_MIN consecutive session minutes;
 *  - both sustain timers reset at the session close (nothing carries across a close, a weekend or a holiday); an alert that is ON
 *    stays on across the close and is re-evaluated from the next open;
 *  - price feed gaps: a stock with no price for <= BOUNCER_STALE_HOLD_MIN session minutes holds its last state (no flicker);
 *    longer, it is marked stale (timers frozen, card kept and labelled); a watched stock that never had a price is listed in
 *    noPrice (e.g. the fictional MOON against a real feed).
 * One card per stock (bouncer2), sorted by combined gap $ (exposure). ALERT-ONLY: the engine reports risk (who, how far below K,
 * how much exposure); it computes no trades, positions or recommended actions. */
(function (g) {
  'use strict';
  var BOUNCER = {
    BOUNCER_GAP_THRESHOLD: 0.15,       // concerning when (K - price) / K >= 15% (Jake is considering 0.10-0.20) - unchanged
    BOUNCER_CLEAR: 0.10,               // hysteresis: clear level
    BOUNCER_CLEAR_SUSTAIN_MIN: 5,      // bouncerfix1: ...the gap must stay <= the clear level this many consecutive session minutes
    BOUNCER_SUSTAIN_MIN: 15,           // 15 session-minute sustain
    BOUNCER_STALE_HOLD_MIN: 5,         // bouncerfix1: a price gap up to this long holds the last state; longer = stale
    BOUNCER_TOP_PCT: 0.10,             // holders watched = top 10% of individual holders by insured value
    BOUNCER_TAP_SLOP_PX: 6,            // pointer movement under this is a tap (opens the panel), not a drag
    BOUNCER_DEMO_GAP_THRESHOLD: 0.02,  // ONLY with the panel's "Demo sensitivity" checkbox (off by default)
    BOUNCER_DEMO_CLEAR: 0.013          // ~ the same 2:3 clear/threshold ratio as 0.10 / 0.15
  };
  function since(prev, cond, minute) { return cond ? (prev == null ? minute : prev) : null; }
  function held(s, minute, n) { return s != null && minute - s >= n; }
  /** stable anonymized id per sampled holder: a fixed permutation of 1000-9999 (7919 is prime, coprime with 9000) */
  function holderId(i) { return 1000 + ((i * 7919 + 1237) % 9000); }
  /** top pct of holders by insured value (ties broken by sample index so the pick is stable) */
  function topHolders(list, pct) {
    var n = Math.ceil(list.length * (pct == null ? BOUNCER.BOUNCER_TOP_PCT : pct));
    return list.slice().sort(function (a, b) { return b.insured - a.insured || a.i - b.i; }).slice(0, n);
  }
  function levels(demo) { return demo ? { th: BOUNCER.BOUNCER_DEMO_GAP_THRESHOLD, clr: BOUNCER.BOUNCER_DEMO_CLEAR } : { th: BOUNCER.BOUNCER_GAP_THRESHOLD, clr: BOUNCER.BOUNCER_CLEAR }; }

  /* ---------------- per-holder protected price K ---------------- */
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  var STRIKES = [0.90, 0.92, 0.95, 0.95, 0.97]; // protected price as a share of the price at lock (5% cushion most common)
  /**
   * Deterministic K for every holder-leg, from (holder index, ticker) only - never from the clock or the page load.
   * opts.lockDates: candidate lock dates (session dates, oldest first); opts.priceOn(t, date, r): price at that lock (real close
   * or a seeded stand-in), null = no price (leg skipped); opts.bound(t, K): optional clamp. Returns { 'i:t': { K, lockedOn, strike, lockPx } }.
   * A leg is covered from the session AFTER lockedOn (the lock happens at that day's close).
   */
  function seedK(holders, opts) {
    var out = {}, D = opts.lockDates;
    holders.forEach(function (h) {
      h.legs.forEach(function (l) {
        var r = rng(hash(h.i + ':' + l.t + ':' + (opts.salt || 'k1')));
        var lockedOn = D[Math.floor(r() * D.length)], strike = STRIKES[Math.floor(r() * STRIKES.length)];
        var px = opts.priceOn(l.t, lockedOn, r); if (!(px > 0)) return;
        var K = px * strike; if (opts.bound) K = opts.bound(l.t, K);
        out[h.i + ':' + l.t] = { K: Math.round(K * 100) / 100, lockedOn: lockedOn, strike: strike, lockPx: Math.round(px * 100) / 100 };
      });
    });
    return out;
  }
  /** copy seeded / stored Ks onto the holder legs (l.K, l.from = first covered session) */
  function applyK(holders, kmap, nextSession) {
    holders.forEach(function (h) { h.legs.forEach(function (l) { var k = kmap[h.i + ':' + l.t]; if (k) { l.K = k.K; l.lockedOn = k.lockedOn; l.from = nextSession ? nextSession(k.lockedOn) : null; } }); });
    return holders;
  }

  /* ---------------- engine ---------------- */
  function create(holders) { return { holders: holders || [], st: {}, stk: {}, px: {}, minute: 0, key: null, flagged: [], count: 0, holderCount: 0, noPrice: [], stale: [], open: true }; }
  function resetTimers(E) { for (var k in E.st) { E.st[k].since = null; E.st[k].clrSince = null; } }
  /**
   * One session minute. mkt: { t: { S, K? } } (S = price now; a ticker absent or with S null has no price this minute; K = the
   * name-level fallback used only by legs that carry no K of their own). minute: legacy book minute (used when clk is absent).
   * lv: { th, clr }.
   * clk (calendar mode): { key: session date 'YYYY-MM-DD', ord: PCMarket.ordinal (session minutes), open: market open now }.
   */
  function step(E, mkt, minute, lv, clk) {
    var stk = E.stk || (E.stk = {}), PX = E.px || (E.px = {});
    var key = clk ? clk.key : '', ord = clk ? clk.ord : minute;
    E.minute = ord;
    if (clk && clk.open === false) { // market closed: nothing is evaluated; sustain timers reset at the close; alerts keep showing
      if (E.open !== false) resetTimers(E);
      E.open = false; E.key = key || E.key; return E;
    }
    if (E.key != null && key !== E.key) resetTimers(E); // new session (also covers a close we never saw)
    E.key = key; E.open = true;
    var by = {}, hs = {}, watched = {}, noPx = {}, staleNow = {};
    // per-stock feed bookkeeping
    E.holders.forEach(function (h) { h.legs.forEach(function (l) { watched[l.t] = (watched[l.t] || 0) + 1; }); });
    for (var t0 in watched) {
      var q = mkt[t0], P = PX[t0];
      if (q && q.S != null && isFinite(q.S) && q.S > 0) { PX[t0] = { S: q.S, ord: ord, K: q.K }; continue; }
      if (!P) { noPx[t0] = watched[t0]; continue; }
      if (ord - P.ord > BOUNCER.BOUNCER_STALE_HOLD_MIN) staleNow[t0] = ord - P.ord;
    }
    E.holders.forEach(function (h) {
      h.legs.forEach(function (l) {
        var P = PX[l.t]; if (!P) return;
        if (clk && l.from && key < l.from) return; // not covered yet in this session
        var K = l.K > 0 ? l.K : P.K; if (!(K > 0)) return;
        var k = h.i + ':' + l.t, s = E.st[k] || (E.st[k] = { since: null, on: false, from: null, clrSince: null });
        var S = P.S, gap = (K - S) / K, fresh = P.ord === ord;
        if (fresh) { // held / stale prices freeze the timers
          s.since = since(s.since, gap >= lv.th, ord);
          if (s.on) {
            s.clrSince = since(s.clrSince, gap <= lv.clr, ord);
            if (held(s.clrSince, ord, BOUNCER.BOUNCER_CLEAR_SUSTAIN_MIN)) { s.on = false; s.from = null; s.clrSince = null; }
          } else if (held(s.since, ord, BOUNCER.BOUNCER_SUSTAIN_MIN)) { s.on = true; s.from = s.since; s.clrSince = null; }
        }
        if (!s.on) return;
        var gapUsd = Math.max(0, K - S) * l.sh;
        var c = by[l.t] || (by[l.t] = { t: l.t, S: S, Kmin: Infinity, Kmax: -Infinity, holders: [], n: 0, gapUsd: 0, worstGapPct: 0, firstFrom: Infinity,
          stale: !!staleNow[l.t], staleMin: staleNow[l.t] || 0, priceAge: ord - P.ord });
        c.holders.push({ i: h.i, id: holderId(h.i), label: 'Holder #' + holderId(h.i), K: K, lockedOn: l.lockedOn || null, gapPct: gap, gapUsd: gapUsd, sh: l.sh, minutes: ord - s.from, clearing: s.clrSince != null ? ord - s.clrSince : null });
        c.n++; c.gapUsd += gapUsd; c.worstGapPct = Math.max(c.worstGapPct, gap); c.Kmin = Math.min(c.Kmin, K); c.Kmax = Math.max(c.Kmax, K); c.firstFrom = Math.min(c.firstFrom, s.from);
        hs[h.i] = 1;
      });
    });
    for (var t in stk) if (!by[t]) delete stk[t];
    var out = Object.keys(by).map(function (t) {
      var c = by[t];
      if (!stk[t]) stk[t] = { from: c.firstFrom };
      c.from = stk[t].from; c.minutes = ord - c.from;
      c.gapPct = (c.Kmax - c.S) / c.Kmax; c.gapPerSh = Math.max(0, c.Kmax - c.S); c.gapPctLo = (c.Kmin - c.S) / c.Kmin; c.gapPerShLo = Math.max(0, c.Kmin - c.S);
      c.holders.sort(function (a, b) { return b.gapUsd - a.gapUsd || a.id - b.id; }); delete c.firstFrom;
      return c;
    });
    E.flagged = sortRows(out); E.count = out.length; E.holderCount = Object.keys(hs).length;
    E.noPrice = Object.keys(noPx).sort().map(function (t) { return { t: t, legs: noPx[t] }; });
    E.stale = Object.keys(staleNow).sort().map(function (t) { return { t: t, min: staleNow[t] }; });
    return E;
  }
  function sortRows(rows) { return rows.sort(function (a, b) { return b.gapUsd - a.gapUsd || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0); }); }

  var api = { BOUNCER: BOUNCER, since: since, held: held, holderId: holderId, topHolders: topHolders, levels: levels,
    hash: hash, rng: rng, STRIKES: STRIKES, seedK: seedK, applyK: applyK, create: create, step: step, sortRows: sortRows, resetTimers: resetTimers };
  g.PCBouncerCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
