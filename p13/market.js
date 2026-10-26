/* Paracord — US equity market calendar + session clock (bouncerfix1). Pure, DOM-free, no dependencies: runs in the browser,
 * in Node (tests, the real-price replay) and in a Cloudflare Worker (Intl time zones are available there).
 * - Session times are America/New_York wall-clock times (9:30-16:00, 13:00 on early-close days); DST is handled by Intl, so the
 *   UTC instant of the open moves by an hour across the March / November switches.
 * - Weekends and NYSE full holidays are closed; NYSE 1:00 PM early closes give a 210-minute session.
 * - Calendar covers 2026-2027 (source: nyse.com/trade/hours-calendars). Outside it only weekends are closed and status().covered
 *   is false, so callers can tell.
 * - Session minutes: minute m = 0..len-1 of a session is the bar 9:30+m .. 9:31+m. ordinal(ms) counts session minutes elapsed
 *   since the calendar epoch (closed time adds nothing), so "held N minutes" in session minutes is ord - since >= N. */
(function (g) {
  'use strict';
  var TZ = 'America/New_York', MIN = 60000, DAYMS = 86400000;
  var OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60, EARLY_CLOSE_MIN = 13 * 60;
  var HOLIDAYS = {
    '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday", '2026-04-03': 'Good Friday',
    '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day (observed)', '2026-09-07': 'Labor Day',
    '2026-11-26': 'Thanksgiving Day', '2026-12-25': 'Christmas Day',
    '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Washington's Birthday", '2027-03-26': 'Good Friday',
    '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)', '2027-07-05': 'Independence Day (observed)', '2027-09-06': 'Labor Day',
    '2027-11-25': 'Thanksgiving Day', '2027-12-24': 'Christmas Day (observed)'
  };
  var EARLY = { '2026-11-27': 'Day after Thanksgiving', '2026-12-24': 'Christmas Eve', '2027-11-26': 'Day after Thanksgiving' };
  var FROM = '2026-01-01', TO = '2027-12-31', EPOCH = '2026-01-01';
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var fmt = null;
  function F() { return fmt || (fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** wall-clock parts in New York for a UTC instant */
  function et(ms) {
    var p = {}; F().formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var y = +p.year, mo = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute, s = +p.second;
    var date = y + '-' + pad(mo) + '-' + pad(d);
    return { y: y, mo: mo, d: d, h: h, mi: mi, s: s, date: date, min: h * 60 + mi, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(),
      offsetMin: Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000) / MIN) };
  }
  function ymd(date) { var a = date.split('-'); return [+a[0], +a[1], +a[2]]; }
  /** UTC instant of a New York wall-clock time (minute of day) on a calendar date */
  function etToMs(date, minOfDay) {
    var a = ymd(date), naive = Date.UTC(a[0], a[1] - 1, a[2], 0, minOfDay);
    var ms = naive - et(naive + 5 * 3600000).offsetMin * MIN; // first guess with the offset a few hours later (-4h or -5h)
    var off = et(ms).offsetMin; return naive - off * MIN;
  }
  function addDays(date, n) { var a = ymd(date), t = new Date(Date.UTC(a[0], a[1] - 1, a[2] + n)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
  function dowOf(date) { var a = ymd(date); return new Date(Date.UTC(a[0], a[1] - 1, a[2])).getUTCDay(); }
  var dayCache = {};
  /** one calendar date: trading or not, why not, session length, open / close instants */
  function day(date) {
    if (dayCache[date]) return dayCache[date];
    var dow = dowOf(date), wk = dow === 0 || dow === 6, hol = HOLIDAYS[date] || null, early = !wk && !hol && !!EARLY[date];
    var r = { date: date, dow: dow, trading: !wk && !hol, reason: wk ? 'Weekend' : hol, early: early, earlyName: early ? EARLY[date] : null,
      covered: date >= FROM && date <= TO, openMin: OPEN_MIN, closeMin: early ? EARLY_CLOSE_MIN : CLOSE_MIN, len: 0, openMs: null, closeMs: null };
    if (r.trading) { r.len = r.closeMin - r.openMin; r.openMs = etToMs(date, r.openMin); r.closeMs = etToMs(date, r.closeMin); }
    return (dayCache[date] = r);
  }
  function isTradingDay(date) { return day(date).trading; }
  function nextTradingDay(date) { var d = addDays(date, 1); for (var i = 0; i < 15 && !day(d).trading; i++) d = addDays(d, 1); return d; }
  function prevTradingDay(date) { var d = addDays(date, -1); for (var i = 0; i < 15 && !day(d).trading; i++) d = addDays(d, -1); return d; }
  function addTradingDays(date, n) { var d = date; for (var i = 0; i < Math.abs(n); i++) d = n > 0 ? nextTradingDay(d) : prevTradingDay(d); return d; }
  /**
   * Market status at a UTC instant. state: 'open' | 'pre' (trading day, before 9:30) | 'after' (trading day, at/after the close)
   * | 'closed' (weekend / holiday). m = session minute (0..len-1) while open. nextOpenMs = the next session's open (now's if pre).
   */
  function status(ms) {
    var e = et(ms), D = day(e.date), st, m = null, next;
    if (D.trading && ms >= D.openMs && ms < D.closeMs) { st = 'open'; m = Math.floor((ms - D.openMs) / MIN); }
    else if (D.trading && ms < D.openMs) st = 'pre';
    else if (D.trading) st = 'after';
    else st = 'closed';
    next = st === 'pre' ? D : day(nextTradingDay(e.date));
    return { state: st, open: st === 'open', date: e.date, et: e, m: m, len: D.len, early: D.early, earlyName: D.earlyName, reason: D.reason, covered: D.covered,
      day: D, openMs: D.openMs, closeMs: D.closeMs, next: next, nextOpenMs: next.openMs, session: st === 'open' ? e.date : null };
  }
  function isOpen(ms) { return status(ms).open; }
  /** session minute of an instant (0..len-1) or null when the market is closed */
  function sessionMinute(ms) { return status(ms).m; }
  var cum = {}; // date -> session minutes in all sessions strictly before that date (since EPOCH)
  function minutesBefore(date) {
    if (cum[date] != null) return cum[date];
    if (date <= EPOCH) return 0;
    var keys = Object.keys(cum).filter(function (k) { return k < date; }).sort(), d = keys.length ? keys[keys.length - 1] : EPOCH, n = keys.length ? cum[d] : 0;
    while (d < date) { cum[d] = n; n += day(d).len; d = addDays(d, 1); }
    return (cum[date] = n);
  }
  /** session minutes elapsed from the calendar epoch to this instant (monotonic; constant while the market is closed) */
  function ordinal(ms) {
    var S = status(ms), n = minutesBefore(S.date);
    if (S.state === 'open') return n + S.m;
    if (S.state === 'after') return n + S.len;
    return n;
  }
  /** sim clock step: +1 session minute while open; reaching the close shows the close (16:00 / 13:00) once; from a closed
   *  instant the next step jumps to the next session's open (weekends, holidays and nights are skipped) */
  function stepClock(ms) {
    var S = status(ms);
    if (S.open) return Math.min(ms - (ms % MIN) + MIN, S.closeMs);
    return S.nextOpenMs;
  }
  function hm(min) { var h = Math.floor(min / 60), m = min % 60; return (h % 12 || 12) + ':' + pad(m) + ' ' + (h >= 12 ? 'PM' : 'AM'); }
  function dateLabel(date) { var a = ymd(date); return DOW[dowOf(date)] + ' ' + MON[a[1] - 1] + ' ' + a[2]; }
  /** one-line status for UIs: "Open · Mon Oct 26 · 10:57 AM ET · closes 4:00 PM" */
  function label(ms) {
    var S = status(ms), now = dateLabel(S.date) + ' · ' + hm(S.et.min) + ' ET';
    var nx = dateLabel(S.next.date) + ' ' + hm(S.next.openMin) + ' ET' + (S.next.early ? ' (early close ' + hm(S.next.closeMin) + ')' : '');
    if (S.open) return { state: 'open', title: 'Market open', text: now + ' · closes ' + hm(S.day.closeMin) + (S.early ? ' (early close)' : ''), minsLeft: S.len - S.m };
    if (S.state === 'pre') return { state: 'pre', title: 'Pre-market', text: now + ' · opens ' + hm(S.day.openMin) + (S.early ? ', early close ' + hm(S.day.closeMin) : '') };
    return { state: S.state, title: S.state === 'after' ? 'Market closed' : 'Market closed' + (S.reason ? ' (' + S.reason + ')' : ''), text: now + ' · next open ' + nx };
  }
  var api = { TZ: TZ, OPEN_MIN: OPEN_MIN, CLOSE_MIN: CLOSE_MIN, EARLY_CLOSE_MIN: EARLY_CLOSE_MIN, HOLIDAYS: HOLIDAYS, EARLY: EARLY, FROM: FROM, TO: TO,
    et: et, etToMs: etToMs, addDays: addDays, day: day, isTradingDay: isTradingDay, nextTradingDay: nextTradingDay, prevTradingDay: prevTradingDay,
    addTradingDays: addTradingDays, status: status, isOpen: isOpen, sessionMinute: sessionMinute, ordinal: ordinal, minutesBefore: minutesBefore,
    stepClock: stepClock, hm: hm, dateLabel: dateLabel, label: label };
  g.PCMarket = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
