/* Paracord — customer-set price alerts (bouncerfix1; replaces the automatic coverage nudges after the securities-law review).
 * Neutral and opt-in: nothing is set by default (the demo seeds a few, flagged demo: true). Per stock the customer may set
 *   down: X  -> fires when the price is X% or more below the previous session's close
 *   up:   X  -> fires when the price is X% or more above the previous session's close
 *   level: P -> fires when the price crosses P (direction fixed when the alert is saved: price above P -> "falls to P", below -> "rises to P")
 * A hit is latched for the rest of that session (no flicker around the threshold) until the customer dismisses it; everything
 * re-arms at the next session. Copy is factual only (no call to action). DOM-free: the browser, the Node tests and a future
 * Worker share this file. Time keys are session dates (PCMarket). */
(function (g) {
  'use strict';
  var KINDS = ['down', 'up', 'level'];
  var LIMITS = { pctMin: 0.1, pctMax: 50 };
  function create() { return { v: 1, alerts: {}, hits: {}, dismissed: {}, date: null }; }
  function num(x) { if (x === '' || x == null) return null; var n = +x; return isFinite(n) ? n : NaN; }
  function r2(x) { return Math.round(x * 100) / 100; }
  /** validate a form value set; returns { ok, cfg, errors } (cfg null = remove) */
  function validate(cfg, price) {
    var e = [], c = {}, d = num(cfg.down), u = num(cfg.up), l = num(cfg.level);
    [['down', d], ['up', u]].forEach(function (p) {
      if (p[1] == null) return; if (isNaN(p[1]) || p[1] < LIMITS.pctMin || p[1] > LIMITS.pctMax) e.push(p[0] + ' must be ' + LIMITS.pctMin + '–' + LIMITS.pctMax + '%'); else c[p[0]] = r2(p[1]);
    });
    if (l != null) { if (isNaN(l) || !(l > 0)) e.push('level must be a price above $0'); else if (price > 0 && Math.abs(l - price) < 0.005) e.push('level equals the current price'); else c.level = r2(l); }
    if (e.length) return { ok: false, errors: e, cfg: null };
    return { ok: true, errors: [], cfg: Object.keys(c).length ? c : null };
  }
  /** create / update / remove (cfg with no values) the alert on t. price = current price (fixes the level direction). */
  function set(S, t, cfg, price, extra) {
    var v = validate(cfg || {}, price); if (!v.ok) return v;
    if (!v.cfg) { remove(S, t); return v; }
    var a = { t: t, down: v.cfg.down != null ? v.cfg.down : null, up: v.cfg.up != null ? v.cfg.up : null, level: v.cfg.level != null ? v.cfg.level : null };
    a.levelDir = a.level != null ? (price >= a.level ? 'below' : 'above') : null;
    if (extra) for (var k in extra) a[k] = extra[k];
    S.alerts[t] = a;
    KINDS.forEach(function (k) { delete S.hits[t + '|' + k]; delete S.dismissed[t + '|' + k]; }); // edited -> re-armed now
    return v;
  }
  function remove(S, t) { delete S.alerts[t]; KINDS.forEach(function (k) { delete S.hits[t + '|' + k]; delete S.dismissed[t + '|' + k]; }); }
  function get(S, t) { return S.alerts[t] || null; }
  function list(S) { return Object.keys(S.alerts).sort().map(function (t) { return S.alerts[t]; }); }
  /** which of t's alerts are past their condition at price (pc = previous close) */
  function conditions(a, price, pc) {
    var out = [], ch = pc > 0 ? price / pc - 1 : null;
    if (a.down != null && ch != null && ch <= -a.down / 100) out.push('down');
    if (a.up != null && ch != null && ch >= a.up / 100) out.push('up');
    if (a.level != null && (a.levelDir === 'below' ? price <= a.level : price >= a.level)) out.push('level');
    return out;
  }
  /**
   * One evaluation (call once per session minute while the market is open). date: session date; at: label of the instant
   * (e.g. '10:42 AM ET'); quotes: { t: price }; prevCloseOf(t). New session -> hits and dismissals reset (re-armed).
   * Returns the active (latched, not dismissed) hits.
   */
  function step(S, date, at, quotes, prevCloseOf) {
    if (S.date !== date) { S.hits = {}; S.dismissed = {}; S.date = date; }
    for (var t in S.alerts) {
      var p = quotes[t]; if (!(p > 0)) continue;
      var a = S.alerts[t], pc = prevCloseOf(t);
      conditions(a, p, pc).forEach(function (k) { var key = t + '|' + k; if (!S.hits[key]) S.hits[key] = { t: t, kind: k, at: at, price: p, prev: pc }; });
    }
    return active(S, quotes, prevCloseOf);
  }
  function active(S, quotes, prevCloseOf) {
    var out = [];
    for (var key in S.hits) {
      if (S.dismissed[key] === S.date) continue;
      var h = S.hits[key], a = S.alerts[h.t]; if (!a) continue;
      var p = quotes && quotes[h.t] > 0 ? quotes[h.t] : h.price, pc = prevCloseOf ? prevCloseOf(h.t) : h.prev;
      out.push({ t: h.t, kind: h.kind, at: h.at, price: p, prev: pc, change: pc > 0 ? p / pc - 1 : null, alert: a, text: copy(h.t, h.kind, a, p, pc, h.at, h) });
    }
    return out.sort(function (x, y) { return x.t < y.t ? -1 : x.t > y.t ? 1 : KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind); });
  }
  function pct(x) { return (Math.abs(x) * 100).toFixed(1) + '%'; }
  function money(x) { return '$' + x.toFixed(2); }
  function trim(x) { return String(+x); }
  /** factual copy, e.g. "AAPL is down 3.1% from the previous close (your 3% down alert)." ("previous close", not "yesterday's":
   *  on a Monday or after a holiday the reference is the last session's close) */
  function mvTxt(ch) { return Math.abs(ch) < 0.0005 ? 'unchanged' : (ch < 0 ? 'down ' : 'up ') + pct(ch); }
  function copy(t, kind, a, price, pc, at, hit) {
    var ch = pc > 0 ? price / pc - 1 : 0, mv = mvTxt(ch), when = at ? ' Triggered ' + at + '.' : '';
    // latched but no longer past the threshold: say when it hit and where it is now (still factual, no call to action)
    if (kind !== 'level' && hit && hit.prev > 0 && conditions(a, price, pc).indexOf(kind) < 0)
      return t + ' hit your ' + trim(kind === 'down' ? a.down : a.up) + '% ' + kind + ' alert' + (at ? ' at ' + at : '') + ' (' + mvTxt(hit.price / hit.prev - 1) + '); now ' + mv + ' from the previous close.';
    if (kind === 'down') return t + ' is ' + mv + ' from the previous close (your ' + trim(a.down) + '% down alert).' + when;
    if (kind === 'up') return t + ' is ' + mv + ' from the previous close (your ' + trim(a.up) + '% up alert).' + when;
    return t + (a.levelDir === 'below' ? ' fell to' : ' rose to') + ' your ' + money(a.level) + ' alert level' + (at ? ' at ' + at : '') + ' (now ' + money(price) + ').';
  }
  /** dismiss t's hits (one kind or all) for the rest of this session */
  function dismiss(S, t, kind) { (kind ? [kind] : KINDS).forEach(function (k) { if (S.hits[t + '|' + k]) S.dismissed[t + '|' + k] = S.date; }); }
  /** short summary of what is set, e.g. "↓3% · ↑5% · $180.00" */
  function summary(a) { if (!a) return ''; var s = []; if (a.down != null) s.push('↓' + trim(a.down) + '%'); if (a.up != null) s.push('↑' + trim(a.up) + '%'); if (a.level != null) s.push(money(a.level)); return s.join(' · '); }
  function fromJSON(o) { var S = create(); if (o && o.v === 1) { S.alerts = o.alerts || {}; S.hits = o.hits || {}; S.dismissed = o.dismissed || {}; S.date = o.date || null; } return S; }
  var api = { KINDS: KINDS, LIMITS: LIMITS, create: create, validate: validate, set: set, remove: remove, get: get, list: list, conditions: conditions, step: step, active: active, copy: copy, dismiss: dismiss, summary: summary, fromJSON: fromJSON };
  g.PCAlerts = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
