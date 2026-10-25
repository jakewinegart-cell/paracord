/* Paracord — Portfolio coverage nudges (DEMO): downtrend red pulse on uncovered rows, uptrend green blink on covered rows.
 * Spec: /workspace/paracord-downtrend-nudge.md (v1, 2026-10-25, starting values by App Lead; Jake may tweak the numbers).
 * Time unit = one sim trading minute = one sim tick (the trading-day clock's minute). Prices are simulated, not market data.
 * Copy avoids the word "insurance" (securities-law memo). */
(function (g) {
  'use strict';
  /* ---- all nudge numbers live here (one place) ---- */
  var NUDGE = {
    NUDGE_DROP_FROM_HIGH: 0.03,     // 3% below rolling high
    NUDGE_HIGH_WINDOW_MIN: 60,      // lookback for the high
    NUDGE_DROP_FROM_CLOSE: 0.05,    // or 5% below previous close
    NUDGE_SUSTAIN_MIN: 15,          // condition must hold this long
    NUDGE_MA_MIN: 30,               // price must be under this moving average
    NUDGE_CLEAR_FROM_HIGH: 0.015,   // hysteresis clear level
    NUDGE_CLEAR_FROM_CLOSE: 0.025,  // ... and back above the previous close -2.5% (spec "Stop / cooldown")
    NUDGE_MAX_ACTIVE: 3,

    // Uptrend (green) - mirror of the above
    NUDGE_UP_RISE_FROM_LOW: 0.03,   // 3% above rolling low
    NUDGE_UP_LOW_WINDOW_MIN: 60,    // lookback for the low
    NUDGE_UP_RISE_FROM_CLOSE: 0.05, // or 5% above previous close
    NUDGE_UP_SUSTAIN_MIN: 15,       // must hold this long
    NUDGE_UP_MA_MIN: 30,            // price must be above this moving average
    NUDGE_UP_CLEAR_FROM_LOW: 0.015, // hysteresis clear level
    NUDGE_UP_CLEAR_FROM_CLOSE: 0.025, // ... and back below the previous close +2.5%
    NUDGE_UP_MAX_ACTIVE: 3
  };
  var BUF = Math.max(NUDGE.NUDGE_HIGH_WINDOW_MIN, NUDGE.NUDGE_UP_LOW_WINDOW_MIN, NUDGE.NUDGE_MA_MIN, NUDGE.NUDGE_UP_MA_MIN);

  function create() { return { day: null, minute: 0, tk: {}, red: [], green: [] }; }

  function tkState(E, t, p, prevClose) {
    var s = E.tk[t];
    if (!s) s = E.tk[t] = { buf: [], prevClose: prevClose || p, last: p, dnSince: null, upSince: null, red: false, green: false, dismissed: null, m: null };
    return s;
  }
  function stats(buf, n, fn) { var a = buf.length > n ? buf.slice(buf.length - n) : buf, x = fn === 'max' ? -Infinity : fn === 'min' ? Infinity : 0; for (var i = 0; i < a.length; i++) x = fn === 'max' ? Math.max(x, a[i]) : fn === 'min' ? Math.min(x, a[i]) : x + a[i]; return fn === 'avg' ? x / a.length : x; }

  /**
   * One sim minute. rows: [{ t, price, covered, capped }] for every held position.
   * day: the trading-day number (new day -> previous close = last price of the old day; windows, counters, dismissals reset).
   * openPrice(t): previous-close fallback on the first day (the session's opening price).
   */
  function step(E, day, minute, rows, openPrice) {
    var N = NUDGE;
    if (E.day !== null && day !== E.day) { // new sim trading day
      for (var k in E.tk) { var o = E.tk[k]; o.prevClose = o.last; o.buf = []; o.dnSince = o.upSince = null; o.red = o.green = false; o.dismissed = null; }
    }
    E.day = day; E.minute = minute;
    var red = [], green = [], seen = {};
    rows.forEach(function (r) {
      var t = r.t, p = r.price; seen[t] = 1;
      var s = tkState(E, t, p, openPrice ? openPrice(t) : p);
      s.buf.push(p); if (s.buf.length > BUF) s.buf.shift(); s.last = p;
      var hi = stats(s.buf, N.NUDGE_HIGH_WINDOW_MIN, 'max'), lo = stats(s.buf, N.NUDGE_UP_LOW_WINDOW_MIN, 'min');
      var maD = stats(s.buf, N.NUDGE_MA_MIN, 'avg'), maU = stats(s.buf, N.NUDGE_UP_MA_MIN, 'avg');
      var dropHigh = 1 - p / hi, dropClose = 1 - p / s.prevClose, riseLow = p / lo - 1, riseClose = p / s.prevClose - 1;
      var dn = dropHigh >= N.NUDGE_DROP_FROM_HIGH || dropClose >= N.NUDGE_DROP_FROM_CLOSE;
      var up = riseLow >= N.NUDGE_UP_RISE_FROM_LOW || riseClose >= N.NUDGE_UP_RISE_FROM_CLOSE;
      s.dnSince = dn ? (s.dnSince == null ? minute : s.dnSince) : null;
      s.upSince = up ? (s.upSince == null ? minute : s.upSince) : null;
      var dnHeld = s.dnSince != null && minute - s.dnSince >= N.NUDGE_SUSTAIN_MIN;
      var upHeld = s.upSince != null && minute - s.upSince >= N.NUDGE_UP_SUSTAIN_MIN;
      var off = s.dismissed === day; // "Not now": silenced for the rest of the sim trading day
      // red: uncovered, not capped
      if (r.covered || r.capped || off) s.red = false;
      else if (s.red) { if (dropHigh < N.NUDGE_CLEAR_FROM_HIGH && dropClose < N.NUDGE_CLEAR_FROM_CLOSE) s.red = false; }
      else if (dnHeld && p < maD) s.red = true;
      // green: covered
      if (!r.covered || off) s.green = false;
      else if (s.green) { if (riseLow < N.NUDGE_UP_CLEAR_FROM_LOW && riseClose < N.NUDGE_UP_CLEAR_FROM_CLOSE) s.green = false; }
      else if (upHeld && p > maU) s.green = true;
      // copy %: the larger of the two measures (hour vs previous close)
      s.m = { dropHigh: dropHigh, dropClose: dropClose, riseLow: riseLow, riseClose: riseClose, hi: hi, lo: lo, maD: maD, maU: maU, dnHeld: dnHeld, upHeld: upHeld };
      if (s.red) red.push({ t: t, pct: Math.max(dropHigh, dropClose), basis: dropHigh >= dropClose ? 'hour' : 'close' });
      if (s.green) green.push({ t: t, pct: Math.max(riseLow, riseClose), basis: riseLow >= riseClose ? 'hour' : 'close' });
    });
    for (var x in E.tk) if (!seen[x]) { E.tk[x].red = E.tk[x].green = false; } // sold / unlinked
    red.sort(function (a, b) { return b.pct - a.pct; }); green.sort(function (a, b) { return b.pct - a.pct; });
    E.redAll = red; E.greenAll = green;
    E.red = red.slice(0, N.NUDGE_MAX_ACTIVE); E.green = green.slice(0, N.NUDGE_UP_MAX_ACTIVE); // others wait
    E.shown = {}; E.red.forEach(function (n) { n.kind = 'red'; E.shown[n.t] = n; }); E.green.forEach(function (n) { n.kind = 'green'; E.shown[n.t] = n; });
    return E;
  }
  /** "Not now": silence this stock (both colors) for the rest of the sim trading day; it stops showing at once. */
  function dismiss(E, t) {
    var s = E.tk[t]; if (!s) return;
    s.dismissed = E.day; s.red = s.green = false;
    E.red = E.red.filter(function (n) { return n.t !== t; }); E.green = E.green.filter(function (n) { return n.t !== t; });
    if (E.shown) delete E.shown[t];
  }
  /** stop at once when the user flips the switch (red needs off, green needs on) */
  function coverageChanged(E, t) { var s = E.tk[t]; if (s) { s.red = s.green = false; } if (E.shown) delete E.shown[t]; }
  function pctTxt(x) { return (Math.round(x * 1000) / 10).toFixed(1) + '%'; }
  /** Prompt copy (draft, spec). No "insurance" wording. */
  function copy(n) {
    if (n.kind === 'red') return n.basis === 'hour' ? 'Dropping ' + pctTxt(n.pct) + ' in the last hour. Want to turn coverage on?' : 'Down ' + pctTxt(n.pct) + ' since the previous close. Want to turn coverage on?';
    return n.basis === 'hour' ? 'Up ' + pctTxt(n.pct) + ' in the last hour. Coverage may not be needed.' : 'Up ' + pctTxt(n.pct) + ' since the previous close. Coverage may not be needed.';
  }
  var api = { NUDGE: NUDGE, create: create, step: step, dismiss: dismiss, coverageChanged: coverageChanged, copy: copy };
  g.PCNudge = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
