/* Paracord — DEMO app logic. Simulated prices (random walk seeded from a demo snapshot, as of Oct 23, 2026); no real accounts, trades or live market data. */
(function () {
  'use strict';
  var STOCKS = window.PC_STOCKS, BROKERS = window.PC_BROKERS;
  var BY_T = {}; STOCKS.forEach(function (s) { BY_T[s.t] = s; });
  var DEMO4 = BY_T; // the four original demo tickers (house book news input stays limited to these, unchanged)
  // tabs1: any universe name can be held / covered on the Portfolio tab, so ticker lookups cover the whole demo universe
  BY_T = Object.assign({}, window.PC_UNIVERSE_BY_T || {}, DEMO4);
  var BY_B = {}; BROKERS.forEach(function (b) { BY_B[b.id] = b; });
  var KEY = 'p13:paracord-demo-v3'; // p13 preview: namespaced so the /p13/ preview never shares saved state with the live p12 root (same origin); // p9: new state (snapshot prices, lock vol); p8 state is not migrated
  var DAY = 24 * 3600 * 1000, MIN = 60000;
  var NEWS_TAU_MIN = 20, NEWS_WINDOW_MIN = 30; // per paracord-pricing-v1.md
  var RC = window.PARACORD_RATE_CONSTANTS;
  var SIMMIN_YEARS = 1 / (1440 * 252); // v4 floor clock: one 24h sim-day of 24/7 cover = one trading day (no market calendar in the demo)

  /* ---------------- state ---------------- */
  function freshState() {
    var holdings = [];
    window.PC_DEFAULT_LINKED.forEach(function (id) { BY_B[id].demo.forEach(function (h) { holdings.push({ acct: id, t: h[0], sh: h[1] }); }); });
    return { v: 3, pf1: 1, linked: window.PC_DEFAULT_LINKED.slice(), holdings: holdings, ins: {}, news: {}, clock: { offset: 0, speed: 1 }, px: {}, open: {}, receipts: [], sold: 0, sales: [] };
  }
  var state;
  try { state = JSON.parse(localStorage.getItem(KEY)) || freshState(); } catch (e) { state = freshState(); }
  if (state.v !== 3) state = freshState();
  function save() { shCache = null; try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  var shCache = null; // tabs1: shares per ticker, rebuilt after any save (holdings / links change only through save paths)
  // tabs1: saved p12 state - add the large demo portfolio to the default accounts that are still linked (once)
  if (!state.pf1) { (window.PC_BIG_PORTFOLIO || []).forEach(function (x) { if (state.linked.indexOf(x[2]) >= 0) state.holdings.push({ acct: x[2], t: x[0], sh: x[1] }); }); state.pf1 = 1; }
  if (state.sold == null) state.sold = 0; if (!state.sales) state.sales = [];

  if (!state.conf) state.conf = { target: 0, mood: 0, open: null };
  // monotonic premium counters: gross charged per policy and in total (rebates credited separately, cash-outs don't reduce them)
  Object.keys(state.ins).forEach(function (t) { var i = state.ins[t]; if (i.gross == null) i.gross = i.cost + (i.rebates || 0); });
  if (state.paid == null) state.paid = Object.keys(state.ins).reduce(function (a, t) { return a + state.ins[t].gross; }, 0);
  if (state.rebated == null) state.rebated = Object.keys(state.ins).reduce(function (a, t) { return a + (state.ins[t].rebates || 0); }, 0);
  var netDay = null, confHist = [], confNoise = 0, confLast = null, invHist = [], confBook = window.PCConfidence ? window.PCConfidence.newBook() : null; // book resets on page load / demo reset
  // p9: the sim runs the whole demo-snapshot universe (factor model: market + sector + idiosyncratic) so the crowd book and
  // crash scenarios move together; only the four demo tickers keep a chart history and persisted prices.
  var ALL = window.PC_UNIVERSE_DEFS && window.PC_UNIVERSE_DEFS.length ? window.PC_UNIVERSE_DEFS : STOCKS;
  function newSim(px) { var s = new window.PCSim(ALL, px, { histFor: STOCKS.map(function (x) { return x.t; }) }); var o = {}; ALL.forEach(function (d) { o[d.t] = s.price(d.t); }); s.openAll = o; return s; }
  var sim = newSim(state.px);
  STOCKS.forEach(function (s) { if (!state.open[s.t]) state.open[s.t] = sim.price(s.t); });

  var lastReal = Date.now(), pfHist = {}; // tabs1: app-side price history (this session) for portfolio names without a sim chart history
  function simNow() { return Date.now() + state.clock.offset; }

  /* ---------------- derived ---------------- */
  function shMap() {
    if (shCache && shCache.st === state && shCache.n === state.holdings.length && shCache.l === state.linked.join()) return shCache.m;
    var m = {}; state.holdings.forEach(function (h) { if (state.linked.indexOf(h.acct) >= 0) m[h.t] = (m[h.t] || 0) + h.sh; });
    shCache = { st: state, n: state.holdings.length, l: state.linked.join(), m: m }; return m;
  }
  function sharesOf(t) { return shMap()[t] || 0; }
  function acctsOf(t) { var o = []; state.holdings.forEach(function (h) { if (h.t === t && h.sh > 0 && state.linked.indexOf(h.acct) >= 0 && o.indexOf(h.acct) < 0) o.push(h.acct); }); return o; }
  var nudge = window.PCNudge ? window.PCNudge.create() : null, nudgeMin = 0; // nudge1: coverage nudges (nudge.js); resets on page load / demo reset like the book
  function heldTickers() { var m = shMap(); return Object.keys(m).filter(function (t) { return m[t] > 0 && BY_T[t] && sim.has(t); }).map(function (t) { return BY_T[t]; }); }
  function openOf(t) { return state.open[t] || sim.openAll[t]; }
  function chg(t) { var o = openOf(t), p = sim.price(t); return (p - o) / o; }
  function annVol(t) { return sim.sigma1(t) * Math.sqrt(window.PCSim.TICKS_PER_YEAR); }

  /** H_t: max over the last 30 sim-min of severity x relevance x e^(-age/20 min) */
  function newsScore(t) {
    var now = simNow(), h = 0;
    (state.news[t] || []).forEach(function (e) {
      var age = (now - e.at) / MIN;
      if (age >= 0 && age <= NEWS_WINDOW_MIN) h = Math.max(h, e.sev * e.rel * Math.exp(-age / NEWS_TAU_MIN));
    });
    return Math.min(1, h);
  }
  function rateInputs(t, opt) {
    var d = BY_T[t], ins = state.ins[t];
    opt = opt || {};
    return {
      price: sim.price(t), shares: opt.shares != null ? opt.shares : (ins ? ins.shares : sharesOf(t)),
      lockIn: opt.lockIn != null ? opt.lockIn : (ins ? ins.lockIn : sim.price(t)),
      volatility: lockVolNow(t).used, float: d.float, adv: d.adv, news: newsScore(t), // p9: unlocked preview at the lock vol
      inCompletedDayBlock: false, // D_t applied as a rebate at block end (see accrue)
      elapsedMs: ins ? simNow() - ins.enabledAt : 0,
      // v4 rate lock: S, sigma_1 and H frozen at lock start; taper day n and floor clock tau from the lock's tenure
      lock: ins ? ins.lock : null, day: ins ? tenure(ins).day : 1, tau: ins ? tenure(ins).tau : 0, minuteYears: SIMMIN_YEARS
    };
  }
  /** p13 preview: earnings event on this lock's floor clock (covered trading time, years), or null */
  function earnEv(ins) { var e = ins && ins.lock && ins.lock.earn; return e && e.v > 0 && e.at > ins.enabledAt ? { tau: (e.at - ins.enabledAt) / DAY / 252, v: e.v } : null; }
  function tenure(ins, at) { var e = Math.max(0, (at == null ? simNow() : at) - ins.enabledAt); return { day: Math.floor(e / DAY) + 1, tau: e / DAY / 252, e: e }; }
  /** p9 lock vol: max(recent realized (sim EWMA, floored at the 20-day vol), options-implied incl. earnings bump) */
  // p13 preview: a lock with a known report still ahead in its window gets the one-time earnings charge, so it locks at the
  // ex-earnings vol (exEvent); every other lock is exactly as on main
  function lockVolNow(t) { return window.paracordLockVol(BY_T[t], { at: simNow(), rv: sim.recentVol(t), exEvent: true }); }
  function lockNow(t) {
    var lv = lockVolNow(t), ej = window.paracordEarningsJump ? window.paracordEarningsJump(BY_T[t], lv) : null;
    // p13 preview (earnings1): a known report after the lock start is recorded at lock; its jump is charged once, when
    // the lock is on at the report (base event lump + the put floor's jump), see accrue / earnEv
    var earn = ej && ej.at && ej.at > simNow() ? { at: ej.at, v: ej.v, J: ej.J, src: ej.src, absMove: ej.absMove, date: ej.date, timing: ej.timing } : null;
    return { earn: earn, price: sim.price(t), volatility: lv.used, lv: { used: lv.used, rv: lv.rv, iv: lv.iv, ivBase: lv.ivBase, earnInside: lv.earnInside, earnDate: lv.earnDate, bumpPts: lv.bumpPts, source: lv.source, ivSrc: lv.ivSrc, exEvent: lv.exEvent, usedWithBump: lv.usedWithBump }, news: newsScore(t), at: simNow() };
  }
  function pct0(x) { return Math.round(x * 100) + '%'; }
  function volUsedText(lv) {
    if (!lv) return '';
    return pct0(lv.used) + ' (higher of recent ' + pct0(lv.rv) + ' / options-implied ' + pct0(lv.iv) + ')' +
      (lv.exEvent ? ' · ex-earnings: the ' + new Date(lv.earnDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' report is priced as a one-time earnings charge instead' : lv.earnInside ? ' · implied includes earnings ' + new Date(lv.earnDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' (+' + (lv.bumpPts * 100).toFixed(1) + ' pts)' : '');
  }
  /* per-person caps (rate.js CAP_PER_STOCK / CAP_TOTAL): insured value = K x shares, per verified person, not per account */
  function otherInsured(t) { return Object.keys(state.ins).reduce(function (a, u) { return u === t ? a : a + state.ins[u].lockIn * state.ins[u].shares; }, 0); }
  function capFor(t, K) { return window.paracordCapShares(K, sharesOf(t), otherInsured(t)); }
  function capWhy(t, K) { return Math.min(RC.CAP_PER_STOCK, RC.CAP_TOTAL - otherInsured(t)) >= RC.CAP_PER_STOCK ? '$' + RC.CAP_PER_STOCK.toLocaleString() + ' per-stock limit' : '$' + RC.CAP_TOTAL.toLocaleString() + ' total limit'; }
  function capLine(t, K, covered) { var y = sharesOf(t); return covered < y ? covered + ' of ' + y + ' shares covered - ' + capWhy(t, K) : 'All ' + y + ' shares covered (within the $' + RC.CAP_PER_STOCK.toLocaleString() + ' per-stock limit)'; }
  function breakdown(t, opt) { return window.insuranceRateBreakdown(rateInputs(t, opt)); }
  function rateOf(t, opt) { return window.insuranceRatePerMinute(rateInputs(t, opt)); }

  /* ---------------- insurance ---------------- */
  function enableIns(t) {
    if (!sharesOf(t)) return false;
    var K = sim.price(t), n = capFor(t, K);
    if (!n) { toast('Coverage limit reached: $' + RC.CAP_TOTAL.toLocaleString() + ' insured value per person'); return false; }
    var now = simNow();
    state.ins[t] = { lockIn: K, shares: n, enabledAt: now, lastAt: now, cost: 0, gross: 0, blockStart: now, blockCost: 0, blockRebate: 0, blocksDone: 0, rebates: 0, lock: lockNow(t) };
    save(); return true;
  }
  function disableIns(t) { var c = state.ins[t] ? state.ins[t].cost : 0; delete state.ins[t]; save(); toast('Insurance off · total demo cost ' + money(c)); }

  function accrue() {
    var now = simNow();
    Object.keys(state.ins).forEach(function (t) {
      var ins = state.ins[t];
      if (!ins.lock) ins.lock = lockNow(t); // p7 state: lock at the current conditions
      if (ins.blockRebate == null) ins.blockRebate = 0;
      ins.shares = Math.min(ins.shares, sharesOf(t), capFor(t, ins.lockIn));
      if (ins.shares <= 0) { delete state.ins[t]; return; }
      // v4: bill in steps of <= 1 sim-minute. Each step = min(cap, max(ops min, locked base x taper f(n), 1.15 x put-floor increment)).
      // D_t = 1 while the 24h block is open; the 10% (base part only) is tracked per step and rebated when the block completes.
      var from = ins.lastAt, o = rateInputs(t), step = Math.max(MIN, Math.ceil((now - from) / 20000 / MIN) * MIN); // coarser steps only for very long gaps
      while (from < now) {
        var blockEnd = ins.blockStart + DAY, to = Math.min(now, blockEnd, from + step);
        var e1 = from - ins.enabledAt, e2 = to - ins.enabledAt, mins = (to - from) / MIN;
        o.day = Math.floor(e1 / DAY) + 1;
        var ev = earnEv(ins);
        var c1 = window.paracordChargeForInterval(o, e1 / DAY / 252, e2 / DAY / 252, mins, 1, ev);
        var c9 = window.paracordChargeForInterval(o, e1 / DAY / 252, e2 / DAY / 252, mins, RC.D_full_day, ev);
        var c = c1.charge;
        ins.cost += c; ins.blockCost += c; ins.blockRebate += c1.charge - c9.charge; ins.gross = (ins.gross || 0) + c; state.paid = (state.paid || 0) + c;
        if (to >= blockEnd) { // completed, unbroken 24h block -> D_t = 0.90 on that block's base part (rebate; the put floor is not discounted)
          var reb = ins.blockRebate;
          ins.cost -= reb; ins.rebates += reb; ins.blocksDone++; state.rebated = (state.rebated || 0) + reb;
          ins.blockStart = blockEnd; ins.blockCost = 0; ins.blockRebate = 0;
          if (ins.blocksDone === 1) toast('🎉 24h insured — 10% off the base earned (' + money(reb) + ' demo rebate)');
        }
        from = to;
      }
      ins.lastAt = now;
    });
  }

  /* ---------------- membership (p12: Monthly $29.99 or Yearly $199; non-refundable for the current period) ---------------- */
  var PLANS = {
    monthly: { id: 'monthly', name: 'Monthly', fee: RC.MEMBERSHIP_MONTHLY || 29.99, per: 'month', every: 'each month', days: 30 },
    yearly: { id: 'yearly', name: 'Yearly', fee: RC.MEMBERSHIP_YEARLY || RC.MEMBERSHIP_FEE || 199, per: 'year', every: 'each year', days: 365 }
  };
  function planOf(m) { return PLANS[(m && m.plan) || 'yearly'] || PLANS.yearly; }
  function feeTxt(x) { return '$' + (Math.round(x) === x ? String(x) : x.toFixed(2)); }
  var YR_SAVE = PLANS.monthly.fee * 12 - PLANS.yearly.fee, YR_SAVE_PCT = YR_SAVE / (PLANS.monthly.fee * 12); // $160.88, ≈45% (44.7%)
  // auto-renew: roll the paid period forward while renewal is on (demo, nothing charged); cancelled = ends at period end
  function memberRoll() {
    var m = state.member; if (!m) return;
    var P = planOf(m), now = simNow();
    if (!m.plan) { m.plan = 'yearly'; m.fee = P.fee; }
    while (m.autoRenew && m.until <= now) { m.periodStart = m.until; m.until += P.days * DAY; m.renewals = (m.renewals || 0) + 1; }
  }
  function isMember() { memberRoll(); return !!(state.member && state.member.until > simNow()); }
  function dateStr(ms) { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function memberBadge() {
    if (!isMember()) return '';
    var m = state.member, P = planOf(m);
    return '<div class="member-badge" data-plan="' + P.id + '"><span class="pill gold">★ ' + P.name + ' member</span> <span class="small"><b>' + feeTxt(P.fee) + '/' + P.per + '</b> · non-refundable for the current ' + P.per + ' · ' + (m.autoRenew ? 'renews ' : 'renewal cancelled · ends ') + dateStr(m.until) + '</span></div>';
  }
  var memberPick = 'yearly'; // sheet selection; default Yearly
  function planCard(P) {
    var on = memberPick === P.id;
    return '<button type="button" class="plan-opt' + (on ? ' on' : '') + '" data-act="member-plan" data-plan="' + P.id + '" role="radio" aria-checked="' + on + '">' +
      '<span class="plan-radio"></span><span class="plan-main"><b>' + P.name + '</b><span class="plan-price">' + feeTxt(P.fee) + '<span class="small muted"> / ' + P.per + '</span></span>' +
      '<span class="small muted">' + (P.id === 'yearly' ? 'Billed ' + feeTxt(P.fee) + ' up front · <span class="plan-save">save ' + feeTxt(+YR_SAVE.toFixed(2)) + ' (≈' + Math.round(YR_SAVE_PCT * 100) + '%) vs 12 × ' + feeTxt(PLANS.monthly.fee) + ' = ' + feeTxt(+(PLANS.monthly.fee * 12).toFixed(2)) + '</span>' : 'Billed ' + feeTxt(P.fee) + ' each month · ' + feeTxt(+(P.fee * 12).toFixed(2)) + ' over 12 months') + '</span></span></button>';
  }
  function memberSheetBody() {
    var P = PLANS[memberPick], until = simNow() + P.days * DAY;
    return '<div class="plan-pick" role="radiogroup" aria-label="Membership plan">' + planCard(PLANS.monthly) + planCard(PLANS.yearly) + '</div>' +
      '<div class="card" id="memberTerms" data-plan="' + P.id + '"><div style="font-weight:800;margin:0 0 8px">' + P.name + ' membership · ' + feeTxt(P.fee) + '/' + P.per + '</div>' +
      '<ul class="small member-terms">' +
      '<li><b>Price:</b> ' + feeTxt(P.fee) + ' charged today for the first ' + P.per + ' (to ' + dateStr(until) + '), on top of the per-minute insurance premiums. Membership lets you turn on Paracord insurance; premiums are billed separately.</li>' +
      '<li><b>Non-refundable for the current billing period.</b> No full or partial refund of the current ' + P.per + ' if you cancel early, stop using insurance, or close your account, except where the law requires one.</li>' +
      '<li><b>' + P.name + ' auto-renews ' + P.every + '</b> at ' + feeTxt(P.fee) + ' (next on ' + dateStr(until) + ') unless you cancel. We email a reminder before each renewal.</li>' +
      '<li><b>Cancel anytime</b> in one step (Demo menu → Membership → Cancel renewal). Cancelling takes effect at the end of the current ' + P.per + '; you keep access until then.</li>' +
      '<li><b>Coverage limits:</b> $' + RC.CAP_PER_STOCK.toLocaleString() + ' insured value per stock and $' + RC.CAP_TOTAL.toLocaleString() + ' in total (lock-in price × shares), per verified person (identity check), not per brokerage account.</li></ul>' +
      '<label class="row small member-agree" style="gap:8px;align-items:flex-start;margin-top:8px"><input type="checkbox" id="memberAgree"> <span>I agree to the ' + P.name + ' plan: ' + feeTxt(P.fee) + ' charged today, <b>non-refundable for the current ' + P.per + '</b>, auto-renewing ' + P.every + ' at ' + feeTxt(P.fee) + ' until I cancel (cancellation takes effect at the end of the current ' + P.per + ').</span></label></div>' +
      '<button class="btn" id="memberJoin" data-act="member-join" data-plan="' + P.id + '" data-t="' + (route.t || '') + '" disabled>Join ' + P.name + ' for ' + feeTxt(P.fee) + '/' + P.per + ' (demo)</button>';
  }
  function memberSheet() {
    return '<h2>Paracord membership</h2><div class="demo-tag">DEMO — nothing is charged</div>' +
      '<p class="small muted" style="margin:8px 0">Choose a plan. Both are non-refundable for the current billing period and renew automatically until you cancel.</p>' +
      '<div id="memberSheetBody">' + memberSheetBody() + '</div><button class="btn ghost" data-act="close-sheet">Not now</button>';
  }

  /* ---------------- formatting ---------------- */
  function money(n, d) { if (d == null) d = Math.abs(n) < 1 && n !== 0 ? 4 : 2; var s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); return (n < 0 ? '−$' : '$') + s; }
  function rateStr(r) { return money(r, r < 1 ? 3 : 2) + '/min'; }
  function pct(x) { return (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + '%'; }
  function signed(n) { return (n >= 0 ? '+' : '−') + money(Math.abs(n), 2); }
  function cls(x) { return x >= 0 ? 'up' : 'down'; }
  function dur(ms) { ms = Math.max(0, ms); var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + String(ss).padStart(2, '0') + 's'; }
  function big(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : n.toLocaleString(); }
  function bb(id, sm) { var b = BY_B[id]; return '<span class="bb' + (sm ? ' sm' : '') + '"><i style="background:' + b.color + '">' + b.short + '</i>' + b.name + '</span>'; }
  function tk(t) { return '<div class="tk" style="background:' + BY_T[t].color + '">' + t + '</div>'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- router (history.pushState so Android Back works) ---------------- */
  var route = { view: 'home' };
  var ROOTS = ['home', 'accounts', 'demo', 'projections']; // tabs1: Insured tab folded into Portfolio (old #/insured links open Portfolio)
  var doneFlows = {};
  function hashOf(r) { return '#/' + r.view + (r.t ? '/' + r.t : '') + (r.step ? '/' + r.step : '') + (r.sheet ? '?sheet=' + r.sheet : ''); }
  function go(r) { history.pushState(r, '', hashOf(r)); route = r; render(); }
  function replace(r) { history.replaceState(r, '', hashOf(r)); route = r; render(); }
  function openSheet(name, extra) { var r = Object.assign({}, route, { sheet: name }, extra || {}); r.sheetDepth = (route.sheet ? (route.sheetDepth || 1) : 0) + 1; go(r); }
  function tab(v) {
    if (route.view === v && !route.sheet) return;
    var r = { view: v };
    if (ROOTS.indexOf(route.view) >= 0 && route.view !== 'home' && !route.sheet) replace(r); else go(r);
  }
  window.addEventListener('popstate', function (e) { route = e.state || { view: 'home' }; render(); });

  /* ---------------- rendering ---------------- */
  var $view = document.getElementById('view'), $sheet = document.getElementById('sheetRoot');
  function render() {
    if (route.view === 'cashout' && route.step !== 'receipt' && doneFlows[route.flow]) { history.back(); return; }
    if (route.view === 'insured') { route = Object.assign({}, route, { view: 'home' }); history.replaceState(route, '', hashOf(route)); }
    var isRoot = ROOTS.indexOf(route.view) >= 0;
    document.getElementById('backBtn').hidden = isRoot;
    document.getElementById('brand').style.display = isRoot ? '' : 'none';
    var title = '';
    var html;
    switch (route.view) {
      case 'stock': html = viewStock(route.t); title = route.t + ' · ' + BY_T[route.t].name.replace(/ \(.*\)/, ''); break;
      case 'cashout': html = viewCashout(); title = route.step === 'receipt' ? 'Receipt' : route.step === 'confirm' ? 'Confirm cash-out' : 'Cash out ' + route.t; break;
      case 'accounts': html = viewAccounts(); break;
      case 'demo': html = viewDemo(); break;
      case 'projections': html = window.PCProjections ? window.PCProjections.view() : ''; break;
      default: html = viewHome();
    }
    document.getElementById('title').textContent = title;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === route.view); });
    document.getElementById('tabs').style.display = (route.view === 'cashout') ? 'none' : '';
    $view.innerHTML = html;
    $sheet.innerHTML = route.sheet ? '<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true">' + '<div class="grab"></div>' + renderSheet() + '</div></div>' : '';
    if (!render.noScroll) window.scrollTo(0, 0);
    render.noScroll = false;
    pfSetup();
    live();
  }

  function stockRow(s) {
    var t = s.t, on = !!state.ins[t];
    return '<button class="stock" data-act="open-stock" data-t="' + t + '">' + tk(t) +
      '<div style="min-width:0"><div class="nm">' + t + ' <span class="muted small" data-live="shares:' + t + '">' + sharesOf(t) + ' sh</span></div>' +
      '<div class="sub">' + esc(s.name.replace(/ \(.*\)/, '')) + ' · ' + s.tag + '</div>' +
      '<div class="badges" style="margin-top:4px">' + acctsOf(t).map(function (a) { return bb(a, true); }).join('') + '</div></div>' +
      '<svg width="76" height="32" viewBox="0 0 76 32"><polyline data-live="spark:' + t + '" fill="none" stroke-width="2" points=""/></svg>' +
      '<div class="px"><div style="font-weight:700" data-live="price:' + t + '"></div><div class="small" data-live="chg:' + t + '"></div>' +
      '<div class="small muted" data-live="value:' + t + '"></div><span class="ins ' + (on ? 'on' : 'off') + '">' + (on ? '⛨ INSURED' : 'UNINSURED') + '</span></div></button>';
  }

  /* ---------------- tabs1: consumer Portfolio tab (brokerage-style list, coverage switch + Sell per position) ----------------
   * The house / backend book moved to the Demo tab. Rows only refresh while on screen (IntersectionObserver) so the full
   * ~504-position list stays smooth on phones; off-screen rows refresh as they scroll into view. */
  function capped(t) { return !state.ins[t] && capFor(t, sim.price(t)) === 0; }
  /* nudge1: the nudge to show on a row right now (red only while uncovered and not capped, green only while covered), or null */
  function nudgeOf(t) {
    var n = nudge && nudge.shown && nudge.shown[t]; if (!n) return null;
    if (n.kind === 'red' && (state.ins[t] || capped(t))) return null;
    if (n.kind === 'green' && !state.ins[t]) return null;
    return n;
  }
  function nudgeHtml(n, t) { return n ? '<span class="pf-nudge-txt">' + esc(window.PCNudge.copy(n)) + '</span><button class="pf-nudge-x" data-act="nudge-dismiss" data-t="' + t + '">Not now</button>' : ''; }
  function nudgeCls(n) { return n ? (n.kind === 'red' ? ' nudge-red' : ' nudge-green') : ''; }
  function pfRow(t) {
    var d = BY_T[t], ins = state.ins[t], n = sharesOf(t), cp = capped(t), ng = nudgeOf(t);
    return '<div class="pf-row' + nudgeCls(ng) + '" role="button" tabindex="0" data-act="open-stock" data-t="' + t + '" data-pf="' + t + '">' +
      '<div class="pf-id"><div><b>' + t + '</b> <span class="pf-sh' + (ins && ins.shares < n ? ' part' : '') + '" data-pf-sh>' + (ins && ins.shares < n ? ins.shares + '/' : '') + n.toLocaleString() + ' sh</span></div><div class="pf-nm">' + esc(d.name.replace(/ \(.*\)/, '')) + '</div>' + (ins ? '<div class="pf-cov" data-pf-cov></div>' : '') + '</div>' +
      '<div class="pf-q"><div class="pf-v" data-pf-v></div><div class="pf-c" data-pf-c></div></div>' +
      '<button class="toggle sm' + (cp ? ' capped' : '') + '" role="switch" aria-label="Coverage ' + t + '" aria-checked="' + (!!ins) + '"' + (cp ? ' aria-disabled="true" title="Coverage limit"' : '') + ' data-act="toggle-ins" data-t="' + t + '"></button>' +
      '<button class="pf-sell" data-act="sell" data-t="' + t + '" aria-label="Sell ' + t + '">Sell</button>' +
      '<div class="pf-nudge" data-pf-nudge="' + (ng ? ng.kind : '') + '" role="status">' + nudgeHtml(ng, t) + '</div></div>';
  }
  function viewHome() {
    // order by position value, fixed for the session so rows don't jump on re-render (new holdings append; sold ones drop out)
    var held = heldTickers().map(function (d) { return d.t; }), hs = {}; held.forEach(function (t) { hs[t] = 1; });
    var order = (pfOrder || []).filter(function (t) { return hs[t]; }), seen = {}; order.forEach(function (t) { seen[t] = 1; });
    order = order.concat(held.filter(function (t) { return !seen[t]; }).sort(function (x, y) { return sharesOf(y) * sim.price(y) - sharesOf(x) * sim.price(x); }));
    pfOrder = order;
    return clockCard() + '<div class="card hero pf-hero"><div class="big" data-live="pftotal"></div><div class="small" data-live="pfday"></div><div class="small" data-live="pfcash"></div></div>' +
      '<div class="pf-strip"><div><span>⛨ Rate</span><b data-live="totalrate"></b></div><div><span>Protected</span><b data-live="protected"></b></div><div><span>Premiums</span><b data-live="totalcost"></b></div></div>' +
      '<div id="pf-list">' + order.map(pfRow).join('') + '</div>';
  }
  var pfVis = {}, pfObs = null, pfOrder = null;
  function pfUpdate(el) {
    var t = el.dataset.pf; if (!sim.has(t)) return;
    var S = sim.price(t), c = chg(t), v = el.querySelector('[data-pf-v]'), cc = el.querySelector('[data-pf-c]');
    var vt = money(sharesOf(t) * S, 2), ct = money(S, 2) + ' · ' + pct(c);
    if (v.textContent !== vt) v.textContent = vt;
    if (cc.textContent !== ct) { cc.textContent = ct; cc.className = 'pf-c ' + cls(c); }
    var cv = el.querySelector('[data-pf-cov]'), ins = state.ins[t];
    if (cv && ins) { var kt = '🔒 ' + money(ins.lockIn, 2) + ' · ' + rateStr(rateOf(t)); if (cv.textContent !== kt) cv.textContent = kt; }
    var sw = el.querySelector('.toggle'), cp = capped(t);
    if (sw.classList.contains('capped') !== cp) { sw.classList.toggle('capped', cp); if (cp) { sw.setAttribute('aria-disabled', 'true'); sw.title = 'Coverage limit'; } else { sw.removeAttribute('aria-disabled'); sw.removeAttribute('title'); } }
    var nb = el.querySelector('[data-pf-nudge]'); if (!nb) return; // nudge1
    var ng = nudgeOf(t), nk = ng ? ng.kind : '', nh = nudgeHtml(ng, t);
    if (nb.dataset.pfNudge !== nk) { nb.dataset.pfNudge = nk; el.classList.toggle('nudge-red', nk === 'red'); el.classList.toggle('nudge-green', nk === 'green'); }
    var tx = nb.querySelector('.pf-nudge-txt');
    if (!ng) { if (nb.innerHTML) nb.innerHTML = ''; } else if (!tx) nb.innerHTML = nh; else { var ct2 = window.PCNudge.copy(ng); if (tx.textContent !== ct2) tx.textContent = ct2; }
  }
  function pfSetup() {
    if (pfObs) { pfObs.disconnect(); pfObs = null; } pfVis = {};
    var list = document.getElementById('pf-list'); if (!list) return;
    if (!('IntersectionObserver' in window)) { [].forEach.call(list.children, function (el) { pfVis[el.dataset.pf] = el; }); return; }
    pfObs = new IntersectionObserver(function (es) { es.forEach(function (e) { var t = e.target.dataset.pf; if (e.isIntersecting) { pfVis[t] = e.target; pfUpdate(e.target); } else delete pfVis[t]; }); }, { rootMargin: '300px 0px' });
    [].forEach.call(list.children, function (el) { pfObs.observe(el); });
  }
  function pfLive() { for (var t in pfVis) pfUpdate(pfVis[t]); }
  function pfTotals() {
    var v = 0, o = 0;
    heldTickers().forEach(function (d) { var n = sharesOf(d.t); v += n * sim.price(d.t); o += n * openOf(d.t); });
    return { v: v, o: o, cash: (state.cash || 0) + (state.sold || 0) };
  }
  function sellPos(t) {
    accrue(); // premiums charged up to the moment of sale, then coverage ends
    var n = sharesOf(t), S = sim.price(t); if (!n) return;
    if (state.ins[t]) delete state.ins[t];
    state.holdings = state.holdings.filter(function (h) { return !(h.t === t && state.linked.indexOf(h.acct) >= 0); });
    state.sold = (state.sold || 0) + n * S; state.sales.unshift({ t: t, n: n, px: S, proceeds: n * S, at: simNow() });
    save(); render.noScroll = true; render(); toast('Sold ' + n.toLocaleString() + ' ' + t + ' · ' + money(n * S, 2) + ' (demo)');
  }

  function insuranceCard(t) {
    var ins = state.ins[t], n = sharesOf(t), S = sim.price(t);
    var covN = ins ? ins.shares : capFor(t, S);
    var head = '<div class="row between"><div><div style="font-weight:800;font-size:17px">Paracord insurance</div><div class="small muted">Lock in today\'s price for ' + (covN < n ? covN + ' of your ' + n : 'your ' + n) + ' shares</div></div>' +
      '<button class="toggle" role="switch" aria-label="Paracord insurance" aria-checked="' + (!!ins) + '" data-act="toggle-ins" data-t="' + t + '"></button></div>' +
      '<div class="capline small" data-live="capline:' + t + '"></div><div class="small muted">Limits are per verified person (identity/KYC), not per account: $' + RC.CAP_PER_STOCK.toLocaleString() + ' per stock, $' + RC.CAP_TOTAL.toLocaleString() + ' total (K × shares).</div>';
    if (!ins) {
      return '<div class="card">' + head + '<div class="ratebox"><div class="small muted">If enabled now (rate locks at the current price, volatility and news)</div>' +
        '<div class="rate" style="font-size:26px" data-live="previewrate:' + t + '"></div><div class="small muted" data-live="previewsub:' + t + '"></div></div>' +
        (isMember() ? memberBadge() : '<div class="small member-req"><b>Requires Paracord membership:</b> Monthly ' + feeTxt(PLANS.monthly.fee) + '/month or Yearly ' + feeTxt(PLANS.yearly.fee) + '/year. Non-refundable for the current billing period; auto-renews until cancelled. Full terms shown before you join.</div>') +
        '<div class="small muted">Turning this on sets your lock-in to the current simulated price and locks your rate. You can cash out insured shares to Paracord at the lock-in price any time (demo).</div></div>';
    }
    return '<div class="card">' + head +
      '<div class="grid2" style="margin-top:14px">' +
      '<div class="stat"><div class="k">Lock-in price (K)</div><div class="v" data-live="lock:' + t + '"></div></div>' +
      '<div class="stat"><div class="k">Max protected</div><div class="v" data-live="maxprot:' + t + '"></div><div class="small muted" data-live="maxprotsub:' + t + '"></div></div>' +
      '<div class="stat"><div class="k">Now vs lock-in</div><div class="v" data-live="pl:' + t + '"></div></div>' +
      '<div class="stat"><div class="k">Insured for</div><div class="v" style="font-size:15px" data-live="elapsed:' + t + '"></div></div></div>' +
      '<div style="margin-top:12px"><div class="row between small"><span class="muted">Adjust lock-in K (re-lock at today\'s conditions, K ≤ price; raising K restarts day 1)</span><b data-live="kpct:' + t + '"></b></div>' +
      '<input type="range" id="kslider" data-t="' + t + '" min="' + (S * 0.85).toFixed(2) + '" max="' + Math.max(S, ins.lockIn).toFixed(2) + '" step="0.01" value="' + ins.lockIn.toFixed(2) + '" aria-label="Lock-in price slider"></div>' +
      '<div class="ratebox" id="ratebox"><div class="row between"><span class="small muted">Your insurance rate</span><span class="pill lockpill">🔒 Rate locked at start</span></div>' +
      '<div class="rate" data-live="rate:' + t + '"></div>' +
      '<div class="small" data-live="ratetenure:' + t + '"></div>' +
      '<div class="small muted" data-live="ratesub:' + t + '"></div>' +
      '<div class="row between" style="margin-top:10px"><span class="small muted">Premiums charged since enabled</span><b class="num" style="font-size:18px" data-live="cost:' + t + '"></b></div></div>' +
      '<button class="btn ' + (newsScore(t) > 0.01 ? 'ghost' : 'warn') + '" data-act="news" data-t="' + t + '" data-live-btn="news:' + t + '">' + (newsScore(t) > 0.01 ? 'Clear demo news shock' : '⚡ Demo news shock (H → 1)') + '</button>' +
      '<div class="small muted" style="margin-top:4px">News and surge change the rate for new locks and re-locks only; your locked rate does not move with the price.</div>' +
      '</div>' + discountCard(t) + breakdownCard(t) +
      '<button class="btn mint" data-act="cashout" data-t="' + t + '">Cash out at lock-in price</button>';
  }

  function discountCard(t) {
    return '<div class="card"><h3>Full-day discount</h3><div class="row" style="gap:14px">' +
      '<svg class="ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="34" fill="none" style="stroke:var(--line)" stroke-width="9"/>' +
      '<circle data-live="ring:' + t + '" cx="42" cy="42" r="34" fill="none" style="stroke:var(--accent)" stroke-width="9" stroke-linecap="round" transform="rotate(-90 42 42)" stroke-dasharray="213.6" stroke-dashoffset="213.6"/>' +
      '<text data-live="ringpct:' + t + '" x="42" y="47" text-anchor="middle" style="fill:var(--text)" font-size="15" font-weight="800"></text></svg>' +
      '<div style="flex:1"><div data-live="discount:' + t + '"></div><div class="small muted" style="margin-top:4px">Keep insurance on for a full, unbroken 24h to get 10% off that day\'s base charges (D<sub>t</sub> = 0.90; the put-value floor is not discounted).</div>' +
      '<div class="row" style="margin-top:8px;gap:6px"><button class="btn sm ghost" data-act="skip" data-ms="3600000">⏩ +1h</button><button class="btn sm ghost" data-act="skip" data-ms="' + DAY + '">⏩ +24h</button></div></div></div></div>';
  }

  function breakdownCard(t) {
    return '<div class="card breakdown"><details class="how" open><summary>How this rate is computed</summary>' +
      '<div class="formula">R = min($6, max($0.002, c·E·L·(1+3H)·f(n)·D, 1.15·N·ΔP<sub>BS</sub>))\nc = 0.0029/min · h = 390 min · f(n) = max(√n − √(n−1), 0.05)\nS, σ₁, H locked at start · n = day of the lock</div>' +
      '<div data-live="breakdown:' + t + '"></div>' +
      '<div class="small muted" style="margin-top:8px">Draft pricing v4 with the p9 volatility lock (placeholder, rate.js → insuranceRatePerMinute; paracord-pricing-v4.md). Prices, implied vol, F (shares outstanding) and ADV come from a demo snapshot, as of Oct 23, 2026 (not live; some values estimated); MOON is fictional. Demo clock: one 24h sim-day counts as one trading day.</div></details></div>';
  }

  function viewStock(t) {
    var d = BY_T[t], n = sharesOf(t);
    return '<div class="row between"><div><div class="big" data-live="price:' + t + '"></div><div data-live="chg:' + t + '"></div></div>' +
      '<div style="text-align:right"><span class="pill vol">' + (d.tag || d.sector) + '</span><div class="small muted" style="margin-top:6px" data-live="vol:' + t + '"></div></div></div>' +
      '<div class="small muted" style="margin:4px 0 10px">Simulated price · updates every second</div>' +
      '<canvas class="chart" id="chart" data-t="' + t + '"></canvas>' +
      '<div class="row small muted" style="margin:6px 2px 12px;gap:14px"><span><span style="color:var(--ink)">━</span> price (sim)</span>' + (state.ins[t] ? '<span><span style="color:var(--accent)">╍</span> lock-in</span>' : '') + '</div>' +
      '<div class="card"><h3>Your holding</h3><div class="grid2"><div class="stat"><div class="k">Shares</div><div class="v">' + n + '</div></div>' +
      '<div class="stat"><div class="k">Value</div><div class="v" data-live="value:' + t + '"></div></div></div>' +
      '<div class="badges" style="margin-top:10px">' + state.holdings.filter(function (h) { return h.t === t && h.sh > 0 && state.linked.indexOf(h.acct) >= 0; }).map(function (h) { return bb(h.acct) + '<span class="small muted" style="align-self:center">' + h.sh + ' sh</span>'; }).join('') + '</div></div>' +
      (n ? insuranceCard(t) : '<div class="card muted">No shares held in linked demo accounts.</div>') +
      '<div class="footer-note">Demo — simulated prices, no real trades.</div>';
  }

  // tabs1: viewInsured removed - its totals (rate, protected, premiums) and per-row lock-in + rate now live on the Portfolio tab

  function viewAccounts() {
    return '<div class="card"><h3>Linked brokerages (demo)</h3>' + BROKERS.map(function (b) {
      var on = state.linked.indexOf(b.id) >= 0;
      return '<div class="broker"><div class="lg" style="background:' + b.color + '">' + b.short + '</div><div><b>' + b.name + '</b><div class="small muted">' +
        (on ? (function (hs) { return hs.slice(0, 6).map(function (h) { return h.sh + ' ' + h.t; }).join(' · ') + (hs.length > 6 ? ' · +' + (hs.length - 6) + ' more' : ''); })(state.holdings.filter(function (h) { return h.acct === b.id && h.sh > 0; })) || 'No demo holdings' : 'Not linked') + '</div></div>' +
        (on ? '<button class="btn sm ghost" style="margin-left:auto" data-act="unlink" data-b="' + b.id + '">Unlink</button>' : '<button class="btn sm" style="margin-left:auto" data-act="link-direct" data-b="' + b.id + '">Link</button>') + '</div>';
    }).join('') + '</div><div class="small muted center">Links are simulated. Paracord never asks for your brokerage password.</div>';
  }

  function demoControls() {
    var sp = state.clock.speed;
    return '<div class="card"><h3>Demo clock</h3><div class="small muted">Sim time: <b data-live="simclock"></b></div>' +
      '<div class="seg" style="margin:10px 0">' + [1, 60, 600].map(function (x) { return '<button class="' + (sp === x ? 'on' : '') + '" data-act="speed" data-x="' + x + '">×' + x + '</button>'; }).join('') + '</div>' +
      '<div class="grid2"><button class="btn ghost" data-act="skip" data-ms="3600000">⏩ Skip 1 hour</button><button class="btn ghost" data-act="skip" data-ms="' + DAY + '">⏩ Skip 24 hours</button></div>' +
      '<div class="small muted" style="margin-top:8px">Fast-forward accrues insurance cost at the current rate and advances the 24h discount progress.</div></div>' +
      '<div class="card" id="member-settings"><h3>Membership</h3>' + (isMember() ? memberBadge() + '<div class="small muted" style="margin:6px 0" id="member-renew-note">' + planOf(state.member).name + ' plan · renewal is ' + (state.member.autoRenew ? 'on: renews ' + planOf(state.member).every + ' at ' + feeTxt(planOf(state.member).fee) : 'cancelled') + '. Cancelling takes effect at the end of the current ' + planOf(state.member).per + '; the current ' + planOf(state.member).per + ' is non-refundable and stays active until ' + dateStr(state.member.until) + '.</div>' +
        '<button class="btn sm ghost" id="memberCancel" data-act="member-autorenew">' + (state.member.autoRenew ? 'Cancel renewal' : 'Resume renewal') + '</button> <span class="small muted">(demo only)</span>' : '<div class="small muted">Not a member. Monthly ' + feeTxt(PLANS.monthly.fee) + '/month or Yearly ' + feeTxt(PLANS.yearly.fee) + '/year, non-refundable for the current billing period; shown with full terms when you first turn on insurance.</div>') + '</div>' +
      '<div class="card"><h3>Reset</h3><button class="btn danger" data-act="reset">Reset demo</button><div class="small muted" style="margin-top:8px">Clears insured flags, lock-ins, timestamps, membership, linked accounts and receipts from this browser.</div></div>';
  }
  function viewDemo() {
    // tabs1: the house / backend book (User Confidence Index + scenario controls, resilience: cash in, cash out, stock inventory,
    // membership fees, open exposure, net position, net today range; Paracord-owned stock) moved here from the Portfolio tab, unchanged.
    return '<div class="demo-tag">DEMO MENU</div><p class="muted small">Everything in Paracord is simulated: prices are a random walk, accounts and holdings are fake, and no trade ever happens.</p>' +
      '<h3 class="muted small" style="margin:16px 4px 8px;text-transform:uppercase;letter-spacing:.6px">Paracord house book · demo crowd (simulated)</h3>' +
      confCard() + invCard() + demoControls() +
      '<div class="card small"><h3>Demo stocks</h3><div class="small muted" style="margin-bottom:6px">Reference data: <b>' + (window.PC_SNAPSHOT_LABEL || 'demo snapshot') + '</b>, not live. Prices then move as a simulated random walk. Engine universe: ' + ALL.length + ' names.</div>' + STOCKS.map(function (s) { return '<div class="kv"><span class="k">' + s.t + ' · ' + s.tag + (s.fictional ? ' (fictional)' : '') + '</span><span class="v">' + money(s.p0, 2) + ' · implied ' + pct0(s.iv) + (s.iv_src === 'assumed' ? ' (assumed)' : s.iv_src === 'chain' ? '' : ' (est.)') + ' · realized 20d ' + pct0(s.vol20) + (s.earn ? ' · earnings ' + s.earn.slice(5) : '') + ' · shares ' + big(s.float) + ' · ADV ' + big(s.adv) + '</span></div>'; }).join('') + '</div>';
  }

  /* ---------- sheets ---------- */
  function renderSheet() {
    if (route.sheet === 'member') return memberSheet();
    if (route.sheet === 'demo') return '<h2>Demo menu</h2>' + demoControls() + '<button class="btn ghost" data-act="close-sheet">Close</button>';
    if (route.sheet === 'link-pick') {
      return '<h2>Link a brokerage</h2><div class="demo-tag">DEMO — simulated link, no password</div><p class="small muted">Pick a brokerage. You\'ll approve a simulated read-only link — no credentials are ever requested.</p>' +
        BROKERS.map(function (b) {
          var on = state.linked.indexOf(b.id) >= 0;
          return '<button class="broker" data-act="pick-broker" data-b="' + b.id + '"' + (on ? ' disabled style="opacity:.6"' : '') + '><div class="lg" style="background:' + b.color + '">' + b.short + '</div><b>' + b.name + '</b><span class="st' + (on ? ' linked' : '') + '">' + (on ? '✓ Linked' : 'Link ›') + '</span></button>';
        }).join('') + '<button class="btn ghost" data-act="close-sheet">Cancel</button>';
    }
    if (route.sheet === 'link-approve') {
      var b = BY_B[route.b];
      return '<div class="oauth"><div class="url">🔒 demo-auth.' + b.id + '.example/authorize (simulated)</div><div class="body">' +
        '<div class="pair"><div class="lg" style="background:' + b.color + '">' + b.short + '</div><span style="font-size:22px">⇄</span><div class="lg" style="background:var(--chip)">⟆</div></div>' +
        '<h2 class="center" style="color:var(--text)">Paracord (Demo) wants to connect to your ' + b.name + ' demo account</h2>' +
        '<div class="small" style="color:var(--muted)">Signed in as <b>Demo User</b> (simulated)</div>' +
        '<ul class="small"><li>View holdings &amp; share counts (read-only, simulated)</li><li>No trading, no transfers, no money movement</li></ul>' +
        '<div class="note"><b>DEMO:</b> No password or credentials are requested. This screen imitates an OAuth approval — nothing connects to ' + b.name + '.</div>' +
        '<button class="btn" data-act="approve" data-b="' + b.id + '">Approve demo link</button><button class="btn ghost" data-act="close-sheet">Deny</button></div></div>';
    }
    if (route.sheet === 'link-done') {
      var b2 = BY_B[route.b];
      return '<div class="check">✓</div><h2 class="center">' + b2.name + ' linked (demo)</h2><p class="center muted small">Demo holdings imported:</p>' +
        '<div class="card" style="max-height:40vh;overflow:auto">' + b2.demo.map(function (h) { return '<div class="kv"><span class="k">' + h[0] + ' · ' + BY_T[h[0]].name.replace(/ \(.*\)/, '') + '</span><span class="v">' + h[1] + ' sh</span></div>'; }).join('') + '</div>' +
        '<div class="badges" style="justify-content:center;margin-bottom:12px">' + state.linked.map(function (a) { return bb(a); }).join('') + '</div>' +
        '<button class="btn" data-act="link-finish">Done</button>';
    }
    return '';
  }

  /* ---------- cash-out ---------- */
  function coCalc(t, n) {
    var ins = state.ins[t], S = sim.price(t);
    var costPart = ins ? ins.cost * n / ins.shares : 0;
    return { S: S, K: ins.lockIn, n: n, payout: n * ins.lockIn, market: n * S, cost: costPart, net: n * ins.lockIn - costPart };
  }
  function viewCashout() {
    var t = route.t;
    if (route.step === 'receipt') {
      var r = state.receipts.filter(function (x) { return x.ref === route.ref; })[0];
      if (!r) return '<div class="card">Receipt not found.</div>';
      return '<div class="demo-tag" style="display:block;text-align:center">DEMO — no real trade</div><div class="check">✓</div><h2 class="center" style="margin:0">Sold to Paracord at ' + money(r.K, 2) + ' (demo)</h2>' +
        '<p class="center muted small">Ref <b class="num" style="color:var(--text)">' + r.ref + '</b><br>' + new Date(r.at).toLocaleString() + ' (sim clock)</p>' +
        '<div class="card">' + kv('Stock', r.t + ' · ' + BY_T[r.t].name.replace(/ \(.*\)/, '')) + kv('Shares sold to Paracord', r.n) + kv('Lock-in price', money(r.K, 2)) + kv('Market price at execution', money(r.S, 2)) +
        kv('Payout', money(r.payout, 2)) + kv('Insurance cost settled', '−' + money(r.cost)) + kv('Net', money(r.net, 2), 'total') + kv('vs selling at market', '<span class="' + cls(r.payout - r.market) + '">' + signed(r.payout - r.market) + '</span>') + '</div>' +
        '<div class="small muted center" style="margin-bottom:12px">' + r.n + ' ' + r.t + ' shares left your demo holdings and ' + money(r.net, 2) + ' was added to your demo cash. Paracord now holds these shares. Simulated receipt: no shares moved and no money was paid.</div><button class="btn" data-act="receipt-done">Done</button>';
    }
    var ins = state.ins[t];
    if (!ins) return '<div class="card">This holding is not insured.</div>';
    var n = Math.min(route.n || ins.shares, ins.shares);
    if (route.step === 'confirm') {
      return '<div class="demo-tag" style="display:block;text-align:center">DEMO — no real trade</div>' +
        '<div class="card center" style="margin-top:12px"><div class="small muted">You\'re selling to Paracord</div><div class="big">' + n + ' ' + t + '</div><div class="muted">at lock-in <b style="color:var(--text)">' + money(ins.lockIn, 2) + '</b> / share</div></div>' +
        '<div class="card" id="cosum">' + coRows(t, n) + '</div>' +
        '<div class="card small muted">By confirming, the demo will reduce your simulated ' + t + ' holding by ' + n + ' shares and settle the pro-rated insurance cost. Nothing is sent to any brokerage.</div>' +
        '<button class="btn mint" data-act="co-confirm">Confirm demo cash-out</button><button class="btn ghost" data-act="back">Cancel</button>';
    }
    return '<div class="demo-tag" style="display:block;text-align:center">DEMO — no real trade</div>' +
      '<div class="card" style="margin-top:12px"><h3>Shares to sell at lock-in</h3><div class="stepper"><button data-act="co-n" data-d="-1" aria-label="Fewer">−</button>' +
      '<input id="coN" type="number" inputmode="numeric" min="1" max="' + ins.shares + '" value="' + n + '" aria-label="Share count"><button data-act="co-n" data-d="1" aria-label="More">+</button></div>' +
      '<input type="range" id="coR" min="1" max="' + ins.shares + '" value="' + n + '" aria-label="Share count slider">' +
      '<div class="row between small muted"><span>1</span><button class="btn sm ghost" data-act="co-max">Max (' + ins.shares + ')</button><span>' + ins.shares + ' insured</span></div></div>' +
      '<div class="card" id="cosum">' + coRows(t, n) + '</div>' +
      '<button class="btn" data-act="co-review">Review cash-out</button>';
  }
  function kv(k, v, c) { return '<div class="kv' + (c ? ' ' + c : '') + '"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
  function coRows(t, n) {
    var c = coCalc(t, n);
    return kv('Lock-in price', money(c.K, 2)) + kv('Current market price (sim)', money(c.S, 2)) + kv('Payout (' + n + ' × lock-in)', money(c.payout, 2)) +
      kv('Market value of these shares', money(c.market, 2)) + kv('Protection benefit', '<span class="' + cls(c.payout - c.market) + '">' + signed(c.payout - c.market) + '</span>') +
      kv('Insurance cost so far (pro-rated)', '−' + money(c.cost)) + kv('Net to you', money(c.net, 2), 'total');
  }
  function doCashout() {
    var t = route.t, ins = state.ins[t]; if (!ins) return;
    var n = Math.min(route.n || ins.shares, ins.shares), c = coCalc(t, n);
    var ref = 'PCD-DEMO-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    state.receipts.unshift({ ref: ref, t: t, n: n, K: c.K, S: c.S, payout: c.payout, market: c.market, cost: c.cost, net: c.net, at: simNow() });
    var left = n;
    state.holdings.forEach(function (h) { if (h.t === t && left > 0 && state.linked.indexOf(h.acct) >= 0) { var x = Math.min(h.sh, left); h.sh -= x; left -= x; } });
    ins.cost -= c.cost; ins.shares -= n;
    state.cash = (state.cash || 0) + c.net; // sold to Paracord at K: shares leave holdings, cash (net of settled premium) added
    if (confBook && window.PCConfidence.addSale) window.PCConfidence.addSale(confBook, t, n, c.K, c.S);
    if (ins.shares <= 0) delete state.ins[t];
    doneFlows[route.flow] = true; save();
    replace({ view: 'cashout', t: t, step: 'receipt', ref: ref, flow: route.flow });
  }

  /* ---------------- Paracord-owned stock (demo inventory from cash-ins) ---------------- */
  function invCard() {
    return '<div class="card inv" id="inv-card"><div class="row between"><h3 style="margin:0">Paracord-owned stock (from cash-ins)</h3><span class="demo-tag">DEMO DATA</span></div><div id="inv-body"></div>' +
      '<div class="row between" style="margin-top:10px"><span class="small muted">Selling inventory isn\'t built in the demo; nothing auto-sells.</span><button class="btn sm ghost" disabled title="Coming soon">Sell · coming soon</button></div>' +
      '<details class="how small"><summary>How it\'s computed</summary><div class="muted">When a user cashes in, Paracord pays them their cash-in line price K for each share and receives the shares (physical settlement). ' +
      'The immediate economic loss at cash-in is (K − S) per share, where S is the market price then; the shares are booked at cost K (value at purchase S). After that the inventory rides the market: ' +
      'it is marked to market every tick at the live demo price (including the scenario move), so its value goes up and down while the share count only grows. Unrealized P/L = market value − cost paid; change today = market value − value at purchase. Resets on page load. Demo data, not a forecast.</div></details></div>';
  }
  function invBody() {
    var B = confBook; if (!B) return '';
    function m(x) { return '$' + Math.round(x).toLocaleString(); }
    function sg(x) { return (x >= 0 ? '+' : '−') + m(Math.abs(x)); }
    var tks = Object.keys(B.inv).filter(function (t) { return B.inv[t].sh > 0; });
    var pl = B.invValue - B.invCost, today = B.invValue - B.invAcq;
    var h = invHist.length > 1 ? invHist : [B.invValue, B.invValue], mn = Math.min.apply(null, h), mx = Math.max.apply(null, h), rg = mx - mn || 1;
    var pts = h.map(function (x, i) { return (i * 120 / (h.length - 1)).toFixed(1) + ',' + (34 - (x - mn) / rg * 30).toFixed(1); }).join(' ');
    var top = '<div class="conf-top"><div><div class="small muted">Market value now</div><div class="big inv-num" id="inv-value">' + m(B.invValue) + '</div>' +
      '<div class="small">Cost paid ' + m(B.invCost) + ' · <span class="' + (pl >= 0 ? 'up' : 'down') + '" id="inv-pl">' + sg(pl) + ' unrealized</span> · <span class="' + (today >= 0 ? 'up' : 'down') + '">' + sg(today) + ' today</span></div></div>' +
      '<svg class="conf-spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-label="Inventory value this session"><polyline points="' + pts + '" fill="none" style="stroke:var(--ink)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg></div>';
    if (!tks.length) {
      var near = confLast ? confLast.legs.filter(function (l) { return l.S < l.K * 1.01; }).length : 0;
      return top + '<div class="small muted" style="margin-top:10px" id="inv-empty">No cash-ins yet this session. Users may only cash in once a stock is 5% below the open (their cash-in line K): on a Normal day only about 10–15 of the ' + (confLast ? confLast.nNames : 503) + ' names get there, mostly after the first sim hour; Panic day and Crash bring the first ones within about 5–20 sim-min. ' +
        (near ? near + ' name' + (near === 1 ? ' is' : 's are') + ' within 1% of the line now.' : 'No name is within 1% of the line yet.') + '</div>';
    }
    function cm(x) { var v = Math.abs(x), s = v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(0) + 'K' : Math.round(v).toLocaleString(); return '$' + s; }
    function cs(x) { return (x >= 0 ? '+' : '−') + cm(x); }
    function csh(x) { return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e4 ? (x / 1e3).toFixed(0) + 'K' : Math.round(x).toLocaleString(); }
    var sorted = tks.sort(function (x, y) { return B.inv[y].value - B.inv[x].value; }), more = sorted.length - 10;
    var rows = sorted.slice(0, 10).map(function (t) {
      var I = B.inv[t], p = I.value - I.cost, w = B.invValue ? I.value / B.invValue : 0;
      return '<tr data-inv="' + t + '"><td><b>' + t + '</b></td><td class="r" data-inv-sh="' + I.sh + '">' + Math.round(I.sh).toLocaleString() + '</td><td class="r">$' + (I.cost / I.sh).toFixed(2) + '</td><td class="r">$' + I.px.toFixed(2) + '</td>' +
        '<td class="r">' + cm(I.value) + '</td><td class="r ' + (p >= 0 ? 'up' : 'down') + '">' + cs(p) + '</td>' +
        '<td class="r"><span class="inv-bar"><i style="width:' + (w * 100).toFixed(1) + '%"></i></span>' + Math.round(w * 100) + '%</td></tr>';
    }).join('');
    return top + '<div class="inv-scroll"><table class="inv-tbl"><thead><tr><th>Stock</th><th class="r">Shares</th><th class="r">Avg cost</th><th class="r">Price</th><th class="r">Value</th><th class="r">P/L</th><th class="r">% inv.</th></tr></thead><tbody>' + rows + '</tbody></table>' + (more > 0 ? '<div class="small muted" style="margin-top:6px">+ ' + more + ' more names (' + tks.length + ' in total)</div>' : '') + '</div>';
  }
  function invLive() { var el = document.getElementById('inv-body'); if (el) el.innerHTML = invBody(); }

  /* ---------------- p10: intraday net range (peak / low over the simulated trading day) ----------------
   * Net today = premiums collected today − cash paid for cash-ins today + market value now of the shares taken in today.
   * That is the resilience card's Net position without membership fees: membership (p12: Yearly up front + Monthly pro rata) jumps
   * by millions whenever a scenario brings new users in, so it would hide the intraday shape. Second line: net today − open
   * exposure (what would be left if every still-open policy cashed in now) - the line a crash pushes down.
   * The book's trading day is 390 sim-minutes (1 tick = 1 trading minute; confidence.js B.day = floor(minutes / 390) + 1), so the
   * range resets when the book rolls into a new day and on page load / demo reset (new book). Times are the book's trading clock,
   * 9:30 + minute of the day. */
  var NET_SESSION = (window.PCConfidence && window.PCConfidence.CFG.session) || 390;
  function netSnap(B) { var sh = {}; Object.keys(B.inv || {}).forEach(function (t) { sh[t] = B.inv[t].sh; }); return { col: B.collected || 0, cash: B.cashOut || 0, sh: sh }; }
  var netLast = null; // book totals at the end of the previous tick = baseline when a new sim day opens
  function netDayNew(day, S, m) {
    return { day: day, col0: S.col, cash0: S.cash, sh0: S.sh, hist: [], m: m,
      net: { cur: 0, hi: -Infinity, hiM: m, lo: Infinity, loM: m }, aft: { cur: 0, hi: -Infinity, hiM: m, lo: Infinity, loM: m } };
  }
  function netRec(r, v, m) { r.cur = v; if (v > r.hi) { r.hi = v; r.hiM = m; } if (v < r.lo) { r.lo = v; r.loM = m; } }
  function netTrack(B) {
    if (!B) return;
    var day = Math.floor(Math.max(0, B.minutes - 1e-9) / NET_SESSION) + 1, m = B.minutes - (day - 1) * NET_SESSION;
    if (!netDay || netDay.day !== day) netDay = netDayNew(day, day === 1 || !netLast ? { col: 0, cash: 0, sh: {} } : netLast, m);
    var N = netDay, mv = 0;
    Object.keys(B.inv).forEach(function (t) { mv += (B.inv[t].sh - (N.sh0[t] || 0)) * B.inv[t].px; });
    var net = (B.collected - N.col0) - (B.cashOut - N.cash0) + mv, aft = net - (B.open || 0);
    netRec(N.net, net, m); netRec(N.aft, aft, m); N.m = m;
    N.colT = B.collected - N.col0; N.cashT = B.cashOut - N.cash0; N.mvT = mv; // p11: today's parts, shown under the panel title
    N.hist.push([m, net, aft]); if (N.hist.length > NET_SESSION + 2) N.hist.shift();
    netLast = netSnap(B);
  }
  function tradeClock(m) { var t = 9 * 60 + 30 + Math.round(m), h = Math.floor(t / 60), mm = t % 60; return (h > 12 ? h - 12 : h) + ':' + String(mm).padStart(2, '0') + (h >= 12 ? ' pm' : ' am'); }
  /* ---------------- p12: trading-day clock (the book's clock, same as Net today) ----------------
   * Book minutes since page load / reset; 1 tick = 1 trading minute; 390 sim-min per day (9:30 am–4:00 pm), then the next
   * tick opens the next sim day at 9:31 (the crowd book has no overnight, so there is no After-hours state).
   * minutes = 0: Pre-market (book not started) · 0 < m < 390: Open · m = 390: Closed (4:00 pm bell; rolls to day + 1 next tick). */
  function tcParts(minutes) {
    var day = Math.floor(Math.max(0, minutes - 1e-9) / NET_SESSION) + 1, m = Math.max(0, minutes - (day - 1) * NET_SESSION);
    var st = minutes <= 0 ? 'Pre-market' : m >= NET_SESSION - 1e-9 ? 'Closed' : 'Open';
    var t = 9 * 60 + 30 + Math.floor(m + 1e-9), h = Math.floor(t / 60), mm = t % 60;
    return { day: day, m: m, pct: Math.min(1, m / NET_SESSION), status: st, time: (h > 12 ? h - 12 : h) + ':' + String(mm).padStart(2, '0'), ap: h >= 12 ? 'PM' : 'AM' };
  }
  function clockHtml() {
    var B = confBook, P = tcParts(B ? B.minutes : 0);
    function at(mm) { return (mm / NET_SESSION * 100).toFixed(2) + '%'; }
    var ticks = [30, 150, 270].map(function (mm) { return '<i class="tc-tick" style="left:' + at(mm) + '"></i>'; }).join('');
    var mk = '', leg = '';
    if (netDay && netDay.day === P.day && netDay.hist.length && P.status !== 'Pre-market') {
      mk = '<i class="tc-mk hi" data-tc="peak" style="left:' + at(netDay.net.hiM) + '" title="Net today peak ' + tradeClock(netDay.net.hiM) + '"></i>' +
        '<i class="tc-mk lo" data-tc="low" style="left:' + at(netDay.net.loM) + '" title="Net today low ' + tradeClock(netDay.net.loM) + '"></i>';
      leg = '<div class="small muted tc-leg"><i class="tc-k hi"></i>Net today peak ' + tradeClock(netDay.net.hiM) + ' · <i class="tc-k lo"></i>low ' + tradeClock(netDay.net.loM) + '</div>';
    }
    return '<div class="tc-top"><div><div class="small muted">Trading day clock · sim day <b id="tc-day">' + P.day + '</b></div>' +
      '<div class="tc-time" id="tc-time" data-m="' + P.m.toFixed(2) + '">' + P.time + '<small>' + P.ap + '</small></div></div>' +
      '<div style="text-align:right"><span class="tc-status ' + P.status.toLowerCase().replace(/[^a-z]/g, '') + '" id="tc-status">' + P.status + '</span>' +
      '<div class="small muted" style="margin-top:4px"><b id="tc-pct">' + Math.round(P.pct * 100) + '%</b> of session · ' + Math.round(NET_SESSION - P.m) + ' min left</div></div></div>' +
      '<div class="tc-hours"><span style="left:' + at(30) + '">10</span><span style="left:' + at(150) + '">12</span><span style="left:' + at(270) + '">2</span></div>' +
      '<div class="tc-bar" role="progressbar" aria-label="Trading session elapsed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(P.pct * 100) + '">' +
      '<div class="tc-fill" style="width:' + (P.pct * 100).toFixed(2) + '%"></div>' + ticks + mk + '<i class="tc-now" style="left:' + (P.pct * 100).toFixed(2) + '%"></i></div>' +
      '<div class="tc-axis"><span>9:30 AM open</span><span>4:00 PM close</span></div>' + leg;
  }
  function clockCard() { return '<div class="card tclock" id="tclock" aria-live="off">' + clockHtml() + '</div>'; }
  function clockLive() { var el = document.getElementById('tclock'); if (el) el.innerHTML = clockHtml(); }

  function netRangeHtml(sg) {
    var N = netDay;
    if (!N || !N.hist.length) return '<div class="net-range" id="net-range"><div class="small"><b>Net today</b> <span class="muted">· collecting…</span></div></div>';
    var h = N.hist.length > 1 ? N.hist : [N.hist[0], N.hist[0]];
    var lo = Math.min(N.net.lo, N.aft.lo), hi = Math.max(N.net.hi, N.aft.hi), rg = hi - lo || 1, W = 120, H = 40;
    function X(mm) { return (mm / NET_SESSION * W).toFixed(1); }
    function Y(x) { return (36 - (x - lo) / rg * 32).toFixed(1); }
    function dot(x, y, c, k) { return '<path class="net-dot-' + k + '" d="M' + x + ' ' + y + 'h0" style="stroke:' + c + '" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'; } // stays round when stretched
    function line(ix, c, dash) { return '<polyline points="' + h.map(function (p) { return X(p[0]) + ',' + Y(p[ix]); }).join(' ') + '" fill="none" style="stroke:' + c + '" stroke-width="1.5"' + (dash ? ' stroke-dasharray="3 2"' : '') + ' vector-effect="non-scaling-stroke"/>'; }
    var zero = lo < 0 && hi > 0 ? '<line x1="0" x2="' + W + '" y1="' + Y(0) + '" y2="' + Y(0) + '" style="stroke:var(--line)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>' : '';
    var spark = '<svg class="net-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Net today with peak and low">' + zero +
      line(2, 'var(--accent)', true) + line(1, 'var(--ink)') +
      dot(X(N.net.hiM), Y(N.net.hi), 'var(--ink)', 'peak') + dot(X(N.net.loM), Y(N.net.lo), 'var(--ink)', 'low') +
      dot(X(N.aft.hiM), Y(N.aft.hi), 'var(--accent)', 'aftpeak') + dot(X(N.aft.loM), Y(N.aft.lo), 'var(--accent)', 'aftlow') + '</svg>';
    function row(id, label, sub, R) {
      return '<div class="net-line" id="' + id + '" data-cur="' + R.cur + '" data-hi="' + R.hi + '" data-lo="' + R.lo + '"><div class="net-lbl"><b>' + label + '</b><div class="small muted">' + sub + '</div></div>' +
        '<div class="net-cell"><div class="k">Peak</div><div class="v ' + (R.hi >= 0 ? 'up' : 'down') + '">' + sg(R.hi) + '</div><div class="t">' + tradeClock(R.hiM) + '</div></div>' +
        '<div class="net-cell"><div class="k">Now</div><div class="v ' + (R.cur >= 0 ? 'up' : 'down') + '">' + sg(R.cur) + '</div><div class="t">' + tradeClock(N.m) + '</div></div>' +
        '<div class="net-cell"><div class="k">Low</div><div class="v ' + (R.lo >= 0 ? 'up' : 'down') + '">' + sg(R.lo) + '</div><div class="t">' + tradeClock(R.loM) + '</div></div></div>';
    }
    return '<div class="net-range" id="net-range" data-day="' + N.day + '">' +
      '<div class="small"><b>Net today</b> <span class="muted">· sim day ' + N.day + ' · ' + tradeClock(0) + '–' + tradeClock(NET_SESSION) + '</span></div>' +
      '<div class="small muted" id="net-parts" data-cash="' + (N.cashT || 0) + '">today: premiums ' + sg(N.colT || 0) + ' · cash paid for cash-ins ' + sg(-(N.cashT || 0)) + ' · shares taken in, at market ' + sg(N.mvT || 0) + '</div>' +
      '<div class="net-row"><div class="net-lines">' +
      row('net-today', 'Net', 'premiums − cash paid + shares at market', N.net) +
      row('net-after', 'After open exposure', 'if every open policy cashed in now', N.aft) +
      '</div>' + spark + '<div class="net-key small muted"><i class="k1"></i>net <i class="k2"></i>after open exposure · dots = peak &amp; low</div></div></div>';
  }

  /* ---------------- User Confidence Index (demo) ---------------- */
  function confCtx() {
    return { mood: state.conf.mood, noise: confNoise, price: function (t) { return sim.price(t); }, open: function (t) { return state.open[t] || sim.openAll[t]; },
      sigma1: function (t) { return sim.sigma1(t); }, news: function (t) { return DEMO4[t] ? newsScore(t) : 0; }, has: function (t) { return sim.has(t); }, at: simNow() };
  }
  function confCompute() { if (!window.PCConfidence) return null; confLast = window.PCConfidence.compute(confCtx()); if (state.conf.open == null) { state.conf.open = confLast.index; } return confLast; }
  function confCard() {
    var tg = state.conf.target;
    function b(v, l) { return '<button class="' + (Math.abs(tg - v) < 0.001 ? 'on' : '') + '" data-act="conf" data-v="' + v + '">' + l + '</button>'; }
    return '<div class="card conf" id="conf-card"><div class="row between"><h3 style="margin:0">User Confidence Index</h3><span class="demo-tag">DEMO DATA</span></div>' +
      '<div id="conf-body"></div>' +
      '<div class="conf-ctl"><div class="small muted" style="margin:10px 0 6px">Demo scenario</div><div class="seg" id="conf-seg">' + b(-1, 'Crash') + b(-0.5, 'Panic day') + b(0, 'Normal') + b(1, 'Euphoria') + '</div>' +
      '<label class="small muted conf-sl" for="confSlider">Crowd mood &amp; market move <b id="conf-sl-v"></b></label>' +
      '<input type="range" id="confSlider" min="-100" max="100" step="5" value="' + Math.round(tg * 100) + '" aria-label="Crowd mood and market move"></div>' +
      '<details class="how small"><summary>How it\'s computed</summary><div class="muted">' +
      'Demo crowd of 100,000 Paracord users with sampled portfolios: each holds one or two of the demo stocks plus one to three S&amp;P 500 names (picked mostly by market cap), about $4,000 per name, cushion 5% below the open' + (window.PCConfidence.crowd ? ' (' + window.PCConfidence.crowd.names.length + ' names held, ' + window.PCConfidence.crowd.avgNames.toFixed(1) + ' per user)' : '') + '; covered shares are capped per verified person at $' + RC.CAP_PER_STOCK.toLocaleString() + ' per stock and $' + RC.CAP_TOTAL.toLocaleString() + ' in total (K × shares). ' +
      'Share of users turning insurance on = logistic(−1 − 0.9·move<sub>σ</sub> + 1.6·H − 1.4·mood + noise). ' +
      'Fear = 0.40·insured share + 0.20·cash-in rate + 0.15·waiting-line/surge share + 0.15·drop + 0.10·news H − 0.25·rally; Index = 100 / (1 + e<sup>8·(fear − 0.15)</sup>). ' +
      'Resilience is a running book for this session: every sim-minute, premiums accrue = open policies × their v4 rate, locked when they turned insurance on (users who join later lock at the conditions then), × the duration taper, never below 1.15 × the put-value floor (plus surge uplift, which goes to the reserve), within firm-wide limits on insured value: per name min(10% of the $' + (RC.FIRM_LIMIT / 1e6) + 'M firm limit, 10% of its daily $ volume), 25% per sector, and the firm total (demo values). Half of over-capacity users surge, the rest wait; the surge multiplier follows book-wide stress (firm/sector use + index drop), so a crash raises prices on all names together. ' +
      'Rates lock at max(recent realized, options-implied) volatility. Scenarios move the simulated market factor: every name moves by its fitted market loading, so a crash hits all stocks together (some more than others). ' +
      'Every user who turns insurance on becomes a member. Plan mix is a <b>demo assumption</b>: ' + Math.round(window.PCConfidence.CFG.mixYearly * 100) + '% Yearly (' + feeTxt(window.PCConfidence.CFG.feeYearly) + ', arrives up front at join) / ' + Math.round((1 - window.PCConfidence.CFG.mixYearly) * 100) + '% Monthly (' + feeTxt(window.PCConfidence.CFG.feeMonthly) + ' per sim month of 21 trading days, accrued pro rata each sim-minute), with an <b>assumed</b> ' + Math.round(window.PCConfidence.CFG.churnMonthly * 100) + '%/month churn of Monthly members (pro rata). Fees are non-refundable for the current period, so they are counted as cash kept with no refund liability. Membership is shown separately from premiums. ' +
      'Cash-ins are optional and physically settled: below the cushion some users cash in each minute; Paracord pays them K × shares and takes the shares into its inventory (see the next card). Open exposure = the loss if every open policy cashed in now, (K − S) per share. Premiums in, cash out and inventory shares only grow; the index, inventory value and open exposure move freely. Not a forecast.</div></details></div>';
  }
  function confBody(r) {
    var C = window.PCConfidence, T = r.T, v = r.index, d = v - state.conf.open;
    // p11: small cash-in rates (one or two of 503 names below K) used to round to "0%"
    function pctTxt(x) { var p = x * 100; return p > 0 && p < 10 ? (p < 0.1 ? '<0.1' : p.toFixed(1)) + '%' : Math.round(p) + '%'; }
    var belowN = r.legs.filter(function (l) { return l.S < l.K; }).length;
    var gauge = '<div class="conf-gauge">' + C.BANDS.map(function (bd) { return '<span class="' + (r.band === bd[2] ? 'on' : '') + '" style="width:20%">' + bd[2] + '</span>'; }).join('') +
      '<i style="left:' + Math.min(99, Math.max(1, v)) + '%"></i></div>';
    var h = confHist.length > 1 ? confHist : [v, v], n = h.length;
    var pts = h.map(function (x, i) { return (i * 120 / (n - 1)).toFixed(1) + ',' + (34 - x / 100 * 32).toFixed(1); }).join(' ');
    var spark = '<svg class="conf-spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-label="Index this session"><line x1="0" x2="120" y1="18" y2="18" style="stroke:var(--line)" stroke-dasharray="2 3"/><polyline points="' + pts + '" fill="none" style="stroke:var(--ink)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
    function m(x) { return '$' + Math.round(x).toLocaleString(); }
    var B = confBook || { minutes: 0, collected: 0, reserve: 0, paid: 0, open: 0, openPol: 0, cashedPol: 0, net: 0, ok: 'ok', status: 'Collecting…' };
    if (!B.status) { B.ok = 'ok'; B.status = 'Collecting…'; B.net = 0; }
    var B = confBook || window.PCConfidence.newBook();
    if (!B.status) { B.ok = 'ok'; B.status = 'Collecting…'; B.net = 0; }
    // p11: the crowd book counts expected (fractional) policies; a first cash-in below 1 policy is shown as "<1", not "0"
    function polTxt(x) { return x > 0 && x < 1 ? '<1' : Math.round(x).toLocaleString(); }
    var tksN = Object.keys(B.inv || {}).filter(function (t) { return B.inv[t].sh > 0; }).length;
    function sg(x) { return (x >= 0 ? '+' : '−') + m(Math.abs(x)); }
    var res = '<div class="conf-res"><div class="row between"><b>Paracord resilience · this session</b><span class="small muted">demo book · ' + Math.round(B.minutes) + ' sim-min</span></div>' +
      '<div class="conf-status ' + B.ok + '">' + (B.ok === 'ok' ? '✓ ' : '✕ ') + B.status + '</div>' +
      '<div class="grid2" style="margin-top:8px">' +
      '<div class="stat"><div class="k">Cash in · premiums</div><div class="v" id="conf-prem">' + m(B.collected) + '</div><div class="small muted">collected so far · incl. ' + m(B.reserve) + ' surge reserve</div></div>' +
      '<div class="stat"><div class="k">Cash out · cash-in purchases</div><div class="v" id="conf-paid">' + m(B.cashOut) + '</div><div class="small muted">paid K × shares · ' + polTxt(B.cashedPol) + ' policies · ' + tksN + ' name' + (tksN === 1 ? '' : 's') + '</div></div>' +
      '<div class="stat"><div class="k">Stock inventory</div><div class="v" id="conf-inv">' + m(B.invValue) + '</div><div class="small muted">market value now · cost ' + m(B.invCost) + '</div></div>' +
      '<div class="stat"><div class="k">Membership fees · non-refundable</div><div class="v" id="conf-memb">' + m(B.membership || 0) + '</div><div class="small muted" id="conf-memb-sub">Yearly ' + m(B.memYearly || 0) + ' up front (' + Math.round(B.mYearly || 0).toLocaleString() + ' × ' + feeTxt(PLANS.yearly.fee) + ') · Monthly ' + m(B.memMonthly || 0) + ' accrued (' + Math.round(B.mMonthlyActive || 0).toLocaleString() + ' active × ' + feeTxt(PLANS.monthly.fee) + '/mo, pro rata) · assumed mix ' + Math.round(window.PCConfidence.CFG.mixYearly * 100) + '/' + Math.round((1 - window.PCConfidence.CFG.mixYearly) * 100) + ', churn ' + Math.round(window.PCConfidence.CFG.churnMonthly * 100) + '%/mo</div></div>' +
      '<div class="stat"><div class="k">Open exposure</div><div class="v" id="conf-open">' + m(B.open) + '</div><div class="small muted">loss if all ' + Math.round(B.openPol).toLocaleString() + ' open policies cashed in now (cash needed ' + m(B.openCash) + ')</div></div>' +
      '</div><div class="row between" style="margin-top:8px"><b>Net position</b><b class="' + (B.net >= 0 ? 'up' : 'down') + '" id="conf-net">' + sg(B.net) + '</b></div>' + netRangeHtml(sg) +
      '<div class="small muted" style="margin-top:4px">Net position = premiums + membership fees − cash paid + inventory at market · net today = premiums − cash paid + market value of shares taken in, all for today (membership fees left out: shown separately, Yearly up front + Monthly pro rata), with its peak and low over the simulated trading day (390 sim-min, 9:30–4:00; resets each new sim day and on page load); after open exposure = net today − open exposure · rates locked at start (v4) · status: net position vs open exposure (surge reserve ' + m(B.reserve) + ', target ' + m(T.target) + ') · firm limit use ' + Math.round((T.firmUtil || 0) * 100) + '%, worst sector ' + Math.round((T.sectorUtilMax || 0) * 100) + '%, book stress ' + (T.stress || 0).toFixed(2) + (T.M > 1 ? ' → surge ×' + T.M.toFixed(2) + ' on new locks' : '') + ', ' + Math.round(T.wait).toLocaleString() + ' waiting · resets on page load · scenarios change rates going forward, not past collections · nothing auto-sells</div></div>';
    return '<div class="conf-top"><div><div class="big conf-num">' + v.toFixed(0) + '</div>' +
      '<div class="small"><b>' + r.band + '</b> · <span class="' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' vs open</span></div></div>' + spark + '</div>' + gauge +
      '<div class="small muted conf-drv">Insured ' + Math.round(r.pIns * 100) + '% of users · cash-ins ' + pctTxt(r.cashRate) + ' (' + belowN + ' name' + (belowN === 1 ? '' : 's') + ' below K) · waiting/surge ' + Math.round(r.lineRate * 100) + '% · market ' + (r.mkt >= 0 ? '+' : '−') + Math.abs(r.mkt).toFixed(1) + 'σ · news H ' + r.H.toFixed(2) + '</div>' + movesHtml(r) + res;
  }
  function movesHtml(r) {
    if (!r.moves) return '';
    var ks = STOCKS.map(function (s) { return s.t; }).filter(function (t) { return r.moves[t] != null; });
    return '<div class="conf-moves small" id="conf-moves"><span class="muted">Moves vs open (correlated sim):</span> ' + ks.map(function (t) { var x = Math.exp(r.moves[t]) - 1; return '<b>' + t + '</b> <span class="' + (x >= 0 ? 'up' : 'down') + '">' + (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%</span>'; }).join(' · ') +
      ' · <span class="muted">' + Math.round(r.downShare * 100) + '% of ' + r.nNames + ' names down</span></div>';
  }
  function confSliderLabel(v) { var mv = v < 0 ? v * 3 : v * 1.5; return (v < -0.6 ? 'Extreme panic' : v < -0.2 ? 'Panic' : v > 0.6 ? 'Euphoria' : v > 0.2 ? 'Upbeat' : 'Normal') + ' · market ' + (mv >= 0 ? '+' : '−') + Math.abs(mv).toFixed(1) + 'σ'; }
  function confLive() {
    var body = document.getElementById('conf-body'); if (!body) return;
    var r = confLast || confCompute(); if (!r) return;
    body.innerHTML = confBody(r); invLive();
    var lv = document.getElementById('conf-sl-v'); if (lv) lv.textContent = confSliderLabel(state.conf.target);
  }
  function confSet(v, withNews) {
    state.conf.target = Math.max(-1, Math.min(1, v));
    if (withNews != null) STOCKS.forEach(function (s) { state.news[s.t] = withNews ? [{ at: simNow(), sev: 1, rel: 1 }] : []; });
    document.querySelectorAll('#conf-seg button').forEach(function (b) { b.classList.toggle('on', Math.abs(+b.dataset.v - state.conf.target) < 0.001); });
    var sl = document.getElementById('confSlider'); if (sl && document.activeElement !== sl) sl.value = Math.round(state.conf.target * 100);
    save(); confCompute(); confLive();
  }

  /* ---------------- live updates ---------------- */
  function sparkPts(t) {
    var h = sim.hist(t).slice(-40), mn = Math.min.apply(null, h), mx = Math.max.apply(null, h), r = mx - mn || 1;
    return h.map(function (p, i) { return (i * 76 / (h.length - 1)).toFixed(1) + ',' + (29 - (p - mn) / r * 26).toFixed(1); }).join(' ');
  }
  function totals() {
    var v = 0, p = 0, r = 0, c = 0;
    heldTickers().forEach(function (s) { v += sharesOf(s.t) * sim.price(s.t); });
    Object.keys(state.ins).forEach(function (t) { var i = state.ins[t]; p += i.shares * i.lockIn; r += rateOf(t); c += i.cost; });
    return { v: v, p: p, r: r, c: c };
  }
  /** p13 preview: earnings line in the rate breakdown (one-off charge if the lock is on at the report) */
  function earnTerm(t, ins, term) {
    var e = ins && ins.lock ? ins.lock.earn : null, d = BY_T[t];
    if (!e && !ins && window.paracordEarningsJump) { var ej = window.paracordEarningsJump(d, lockVolNow(t)); if (ej.at && ej.at > simNow()) e = ej; }
    if (!e || !(e.v > 0)) return '';
    var o = rateInputs(t), lump = window.paracordEventLump(o, e.v), nl = window.paracordNightLump(o, 1);
    var when = new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (e.timing === 'BMO' ? ' (before the open)' : ' (after the close)');
    return term('J', 'Earnings report ' + when, '+' + money(lump, 2), 'If your lock is on when the report comes out, a one-time earnings charge of about ' + money(lump, 2) + ' is added (no tenure discount on it; ' +
      '≈ ×' + ((nl + lump) / (nl || 1)).toFixed(1) + ' a normal night at this lock-in price). It prices a typical earnings move of ±' + (e.absMove * 100).toFixed(1) + '% (' +
      (e.src === 'implied' ? 'options-implied, demo assumption' : e.src === 'historical' ? 'historical average' : 'fallback: 3 × a normal day\'s move') + '). The put-value floor includes the same jump, so the price stays above a put that spans the report.');
  }
  function bdHtml(t) {
    var b = breakdown(t), d = BY_T[t], ins = state.ins[t];
    var blocks = ins ? ins.blocksDone : 0, lk = ins && ins.lock;
    function term(sym, name, val, ex) { return '<div class="term"><span class="sym">' + sym + '</span><div><b>' + name + '</b><div class="ex">' + ex + '</div></div><span class="val">' + val + '</span></div>'; }
    var lvb = lk && lk.lv ? lk.lv : lockVolNow(t);
    return term('σ', 'Volatility used (at lock)', pct0(b.sigAnn), 'Volatility used: ' + volUsedText(lvb) + '. The same σ sets the base rate and the put-value floor, so the price stays above the comparable put even in a calm week. Implied vol: ' + (d.iv_src === 'chain' ? 'backed out of listed Nov-20 put prices' : d.iv_src === 'assumed' ? 'assumed (fictional stock)' : 'estimated') + ', ' + (window.PC_SNAPSHOT_LABEL || 'demo snapshot') + '.') +
      term('E', 'Expected shortfall (at lock)', money(b.E, 2), 'N·S·σ<sub>h</sub>·G(z) = ' + (ins ? ins.shares : 0) + ' × ' + money(b.S_rate, 2) + ' × ' + (b.sigma_h * 100).toFixed(2) + '% × ' + b.G.toFixed(4) + '<br>S = max(price at lock, K) · σ₁ ' + (b.sigma1 * 100).toFixed(3) + '%/min at lock · z = ' + b.z.toFixed(2)) +
      term('L', 'Liquidity factor', '×' + b.L.toFixed(3), 'max(1,(1B/F)^0.1)·(1+10·N/ADV) = ' + b.Lfloat.toFixed(3) + ' × ' + b.Lsize.toFixed(4) + '<br>F ' + big(d.float) + ' (shares outstanding) · ADV ' + big(d.adv) + (d.fictional ? ' (fictional)' : ' (demo snapshot)')) +
      term('H', 'News score (at lock)', b.H.toFixed(2) + ' → ×' + b.newsFactor.toFixed(2), '1 + 3·H, frozen at lock. A new shock changes new locks and re-locks only.') +
      term('f', 'Duration taper', '×' + b.taper.toFixed(3), 'day ' + b.day + ' of the lock: f(n) = max(√n − √(n−1), 0.05). Day 1 = 1.00, day 2 = 0.41, day 20 = 0.11. Total cost grows like √days, like a put. Turning coverage off resets to day 1.') +
      term('P', 'Put-value floor', money(b.floor, 4) + '/min', '1.15 × N × [P(τ+1 min) − P(τ)], Black-Scholes put at S, K, σ from the lock; τ = ' + (b.tau * 252).toFixed(2) + ' trading days covered. A minimum, not a target: the price never drops below the comparable put (cumulative ≥ 1.15 × the put).' + (b.clampedTo === 'putfloor' ? ' <b>Binds now.</b>' : '')) +
      earnTerm(t, ins, term) +
      term('D', 'Full-day discount', blocks ? '0.90 ✓' : '1.00', blocks ? blocks + ' completed 24h block' + (blocks > 1 ? 's' : '') + ' billed at 0.90 on the base part (' + money(ins.rebates, 2) + ' rebated); current block at 1.00 until it completes' : 'Becomes 0.90 on the base part for a completed unbroken 24h block (applied as a rebate)') +
      term('R', 'Rate now', rateStr(b.rate), 'base₁ ' + money(b.baseRaw, 4) + '/min × f ' + b.taper.toFixed(3) + ' = ' + money(b.base, 4) + '/min' + (b.clampedTo === 'putfloor' ? ' → put floor' : b.clampedTo === 'cap' ? ' → cap $6.00' : b.clampedTo === 'opsmin' ? ' → $0.002 minimum' : ''));
  }
  function liveVal(kind, t, el) {
    var ins = t && state.ins[t];
    switch (kind) {
      case 'price': return money(sim.price(t), 2);
      case 'chg': el.className = (el.className.replace(/\b(up|down)\b/g, '') + ' ' + cls(chg(t))).trim(); return pct(chg(t)) + ' today';
      case 'value': return money(sharesOf(t) * sim.price(t), 2);
      case 'shares': return sharesOf(t) + ' sh';
      case 'vol': var lvv = lockVolNow(t); return 'Vol used ' + pct0(lvv.used) + ' · recent ' + pct0(lvv.rv) + ' / implied ' + pct0(lvv.iv);
      case 'total': return money(totals().v, 2);
      case 'pftotal': var pt = pfTotals(); return money(pt.v + pt.cash, 2);
      case 'pfday': var pd = pfTotals(), dd = pd.v - pd.o; el.className = 'small ' + cls(dd); return signed(dd) + ' (' + pct(pd.o ? dd / pd.o : 0) + ')';
      case 'pfcash': var pc = pfTotals().cash; return pc > 0 ? 'Cash ' + money(pc, 2) : '';
      case 'protected': return money(totals().p, 2);
      case 'totalrate': return rateStr(totals().r);
      case 'totalcost': return money(state.paid || 0) + (state.rebated > 0 ? ' (−' + money(state.rebated) + ' rebates)' : '');
      case 'previewrate': var pn = capFor(t, sim.price(t)); return pn ? rateStr(rateOf(t, { shares: pn, lockIn: sim.price(t) })) : '—';
      case 'previewsub': var pn2 = capFor(t, sim.price(t)), pb = breakdown(t, { shares: pn2, lockIn: sim.price(t) });
        return 'First minute of a new lock' + (pb.clampedTo === 'putfloor' ? ' (put-value floor)' : pb.clampedTo === 'cap' ? ' ($6 cap)' : '') + '; then day 1 base ' + rateStr(pb.baseRaw) + ', day 2 ×0.41, day 20 ×0.11. Live preview moves with volatility & news until you lock.';
      case 'capline': var cn = ins ? ins.shares : capFor(t, sim.price(t)); return capLine(t, ins ? ins.lockIn : sim.price(t), cn);
      case 'simclock': return new Date(simNow()).toLocaleString() + ' · ×' + state.clock.speed;
    }
    if (!ins) return '';
    var S = sim.price(t);
    switch (kind) {
      case 'lock': return money(ins.lockIn, 2);
      case 'kpct': return money(ins.lockIn, 2) + ' (' + ((ins.lockIn / S - 1) * 100).toFixed(1) + '% vs price)';
      case 'maxprot': return money(ins.shares * ins.lockIn, 2);
      case 'maxprotsub': return ins.shares + ' sh × lock-in' + (ins.shares < sharesOf(t) ? ' (of ' + sharesOf(t) + ' held)' : '');
      case 'pl': var d = (S - ins.lockIn) * ins.shares; el.className = 'v ' + cls(d); return signed(d) + '<div class="small">' + pct(S / ins.lockIn - 1) + '</div>';
      case 'rate': return rateStr(rateOf(t));
      case 'ratetenure': var bt = breakdown(t); return '<b>Day ' + bt.day + ' of your lock</b> · tenure discount ' + (bt.taper < 1 ? '−' + Math.round((1 - bt.taper) * 100) + '%' : 'starts day 2 (−59%)') + ' (taper ×' + bt.taper.toFixed(3) + ')' + (bt.clampedTo === 'putfloor' ? ' · put-value floor applies' : bt.clampedTo === 'cap' ? ' · at $6/min cap' : '');
      case 'ratesub': var b = breakdown(t), lk = ins.lock || {};
        return 'Rate locked at start: S ' + money(b.S_rate, 2) + ' · σ ' + (lk.lv ? volUsedText(lk.lv) : Math.round(b.sigAnn * 100) + '%') + ' · news H ' + (lk.news || 0).toFixed(2) + ' (' + new Date(lk.at || ins.enabledAt).toLocaleString() + ', sim). Price moves don\'t change it. ≈ ' + money(b.rate / 60, 5) + '/sec';
      case 'cost': return money(ins.gross != null ? ins.gross : ins.cost) + (ins.rebates > 0 ? ' (−' + money(ins.rebates) + ' rebate)' : '');
      case 'elapsed': return dur(simNow() - ins.enabledAt);
      case 'newspill': var h = newsScore(t); return h > 0.01 ? '<span class="pill news">⚡ News H ' + h.toFixed(2) + '</span>' : '';
      case 'breakdown': return bdHtml(t);
      case 'discount': return ins.blocksDone ? '<span class="pill gold">★ 10% off</span><div class="small muted" style="margin-top:6px">' + money(ins.rebates, 2) + ' rebated · next day ' + Math.floor(prog(ins) * 100) + '%</div>' : '<b>' + dur(DAY - (simNow() - ins.blockStart)) + '</b><div class="small muted">to 10% off</div>';
      case 'discountmini': return ins.blocksDone ? '<span class="pill gold" style="padding:2px 8px;font-size:11px">★ 10% off</span>' : '<span class="muted">' + Math.floor(prog(ins) * 100) + '% to 10% off</span>';
      case 'ringpct': return ins.blocksDone ? '10%' : Math.floor(prog(ins) * 100) + '%';
    }
    return '';
  }
  function prog(ins) { return Math.min(1, (simNow() - ins.blockStart) / DAY); }

  function live() {
    document.querySelectorAll('[data-live]').forEach(function (el) {
      var k = el.getAttribute('data-live').split(':'), kind = k[0], t = k[1];
      if (kind === 'spark') { el.setAttribute('points', sparkPts(t)); el.style.stroke = chg(t) >= 0 ? 'var(--ink)' : 'var(--accent)'; return; }
      if (kind === 'ring') { var ins = state.ins[t]; if (ins) el.setAttribute('stroke-dashoffset', (213.6 * (1 - (ins.blocksDone ? 1 : prog(ins)))).toFixed(1)); if (ins && ins.blocksDone) el.style.stroke = 'var(--ink)'; return; }
      var v = liveVal(kind, t, el);
      if (el.innerHTML !== v) el.innerHTML = v;
    });
    var nb = document.querySelector('[data-live-btn]');
    if (nb) { var on = newsScore(nb.dataset.t) > 0.01; nb.textContent = on ? 'Clear demo news shock' : '⚡ Demo news shock (H → 1)'; nb.className = 'btn ' + (on ? 'ghost' : 'warn'); }
    var ks = document.getElementById('kslider');
    if (ks && document.activeElement !== ks && state.ins[ks.dataset.t]) { var S = sim.price(ks.dataset.t), K = state.ins[ks.dataset.t].lockIn; ks.max = Math.max(S, K).toFixed(2); ks.min = (Math.min(S, K) * 0.85).toFixed(2); ks.value = K.toFixed(2); }
    var cs = document.getElementById('cosum');
    if (cs && route.view === 'cashout' && state.ins[route.t]) cs.innerHTML = coRows(route.t, Math.min(route.n || state.ins[route.t].shares, state.ins[route.t].shares));
    drawChart();
    pfLive();
    confLive();
    clockLive();
  }

  function drawChart() {
    var c = document.getElementById('chart'); if (!c) return;
    var t = c.dataset.t, dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var data = sim.hist(t).length > 1 ? sim.hist(t) : (pfHist[t] && pfHist[t].length > 1 ? pfHist[t] : [sim.price(t), sim.price(t)]), ins = state.ins[t];
    var mn = Math.min.apply(null, data), mx = Math.max.apply(null, data);
    if (ins) { mn = Math.min(mn, ins.lockIn); mx = Math.max(mx, ins.lockIn); }
    var pad = (mx - mn) * 0.1 || 1; mn -= pad; mx += pad;
    var L = 8, R = 58, T = 10, B = 14;
    function X(i) { return L + i * (w - L - R) / (data.length - 1); }
    function Y(p) { return T + (mx - p) / (mx - mn) * (h - T - B); }
    var cv = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }; // theme1: canvas reads the live theme colours
    g.strokeStyle = cv('--grid'); g.lineWidth = 1; g.fillStyle = cv('--muted'); g.font = '11px sans-serif';
    for (var k = 0; k <= 3; k++) { var p = mn + (mx - mn) * k / 3, y = Y(p); g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); g.fillText(p.toFixed(2), w - R + 6, y + 4); }
    if (ins) { var ly = Y(ins.lockIn); g.fillStyle = cv('--lock-fill'); g.fillRect(L, ly, w - L - R, h - B - ly); }
    var col = cv('--ink') || BY_T[t].color, grad = g.createLinearGradient(0, T, 0, h);
    grad.addColorStop(0, col + '55'); grad.addColorStop(1, col + '00');
    g.beginPath(); data.forEach(function (p, i) { i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p)); });
    g.lineTo(X(data.length - 1), h - B); g.lineTo(X(0), h - B); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); data.forEach(function (p, i) { i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p)); }); g.strokeStyle = col; g.lineWidth = 2; g.stroke();
    var lx = X(data.length - 1), lyy = Y(data[data.length - 1]); g.fillStyle = col; g.beginPath(); g.arc(lx, lyy, 4, 0, 7); g.fill();
    if (ins) {
      var y2 = Y(ins.lockIn); g.setLineDash([6, 5]); g.strokeStyle = cv('--accent'); g.lineWidth = 2; g.beginPath(); g.moveTo(L, y2); g.lineTo(w - R, y2); g.stroke(); g.setLineDash([]);
      g.fillStyle = cv('--accent'); g.fillRect(w - R + 2, y2 - 9, R - 4, 18); g.fillStyle = cv('--accent-ink'); g.font = 'bold 11px sans-serif'; g.fillText('K ' + ins.lockIn.toFixed(2), w - R + 5, y2 + 4);
    }
  }

  var toastT;
  function toast(msg) { var el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove('show'); }, 2600); }

  /* ---------------- events ---------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    if (el.classList.contains('scrim') && e.target !== el) return; // clicks inside the sheet don't close it
    var a = el.dataset.act, t = el.dataset.t;
    switch (a) {
      case 'open-stock': go({ view: 'stock', t: t }); break;
      case 'tab': tab(el.dataset.tab); break;
      case 'back': history.back(); break;
      case 'close-sheet': history.go(-(route.sheetDepth || 1)); break;
      case 'link': openSheet('link-pick'); break;
      case 'link-direct': openSheet('link-approve', { b: el.dataset.b }); break;
      case 'pick-broker': openSheet('link-approve', { b: el.dataset.b }); break;
      case 'approve':
        var b = el.dataset.b;
        if (state.linked.indexOf(b) < 0) { state.linked.push(b); BY_B[b].demo.forEach(function (h) { state.holdings.push({ acct: b, t: h[0], sh: h[1] }); }); save(); }
        replace(Object.assign({}, route, { sheet: 'link-done' })); break;
      case 'link-finish': history.go(-(route.sheetDepth || 1)); break;
      case 'unlink':
        state.linked = state.linked.filter(function (x) { return x !== el.dataset.b; });
        state.holdings = state.holdings.filter(function (h) { return h.acct !== el.dataset.b; });
        accrue(); save(); render.noScroll = true; render(); toast(BY_B[el.dataset.b].name + ' unlinked (demo)'); break;
      case 'sell':
        if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Sell?'; el.classList.add('armed'); setTimeout(function () { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Sell'; el.classList.remove('armed'); } }, 3000); break; }
        sellPos(t); break;
      case 'nudge-dismiss': if (nudge) window.PCNudge.dismiss(nudge, t); pfLive(); break; // "Not now": silenced for the rest of the sim trading day
      case 'toggle-ins':
        if (nudge) window.PCNudge.coverageChanged(nudge, t); // nudge1: a flip stops that row's nudge at once
        if (!state.ins[t] && el.getAttribute('aria-disabled') === 'true') { enableIns(t); break; } // tabs1: at a per-person cap, stays off
        if (state.ins[t]) disableIns(t);
        else if (!isMember()) { memberPick = 'yearly'; openSheet('member', { t: t }); break; }
        else if (enableIns(t)) toast('⛨ Insured ' + state.ins[t].shares + ' sh at ' + money(sim.price(t), 2) + ' · rate locked (demo)');
        render.noScroll = true; render(); break;
      case 'member-join':
        var ag = document.getElementById('memberAgree'); if (!ag || !ag.checked) break;
        var jp = PLANS[el.dataset.plan] || PLANS.yearly;
        state.member = { plan: jp.id, joinedAt: simNow(), periodStart: simNow(), until: simNow() + jp.days * DAY, fee: jp.fee, autoRenew: true, nonRefundable: true, renewals: 0 };
        save(); var mt = el.dataset.t;
        if (mt && BY_T[mt] && !state.ins[mt]) enableIns(mt);
        history.go(-(route.sheetDepth || 1));
        toast('★ ' + jp.name + ' member · ' + feeTxt(jp.fee) + '/' + jp.per + ', non-refundable for the current ' + jp.per + ' (demo, nothing charged)' + (mt && state.ins[mt] ? ' · ' + mt + ' insured' : '')); break;
      case 'member-plan':
        memberPick = PLANS[el.dataset.plan] ? el.dataset.plan : 'yearly';
        var msb = document.getElementById('memberSheetBody'); if (msb) msb.innerHTML = memberSheetBody(); // consent resets to unticked on plan change
        break;
      case 'member-autorenew':
        if (state.member) { state.member.autoRenew = !state.member.autoRenew; save(); render.noScroll = true; render(); toast(state.member.autoRenew ? 'Renewal resumed · ' + planOf(state.member).name + ' renews ' + dateStr(state.member.until) : 'Renewal cancelled · ' + planOf(state.member).name + ' membership stays active until ' + dateStr(state.member.until) + ' (no refund for the current ' + planOf(state.member).per + ')'); } break;
      case 'news':
        if (newsScore(t) > 0.01) state.news[t] = []; else { state.news[t] = [{ at: simNow(), sev: 1, rel: 1 }]; toast('⚡ Demo news shock on ' + t + ' — H = 1, decays over ~20 sim-min'); }
        save(); live(); break;
      case 'skip': accrue(); state.clock.offset += +el.dataset.ms; accrue(); save(); live(); toast('⏩ Skipped ' + (+el.dataset.ms === DAY ? '24 hours' : '1 hour') + ' (demo clock)'); break;
      case 'speed': state.clock.speed = +el.dataset.x; save(); render.noScroll = true; render(); break;
      case 'reset':
        if (el.dataset.armed) { localStorage.removeItem(KEY); state = freshState(); state.conf = { target: 0, mood: 0, open: null }; confHist = []; confLast = null; confBook = window.PCConfidence ? window.PCConfidence.newBook() : null; netDay = null; netLast = null; state.paid = 0; state.rebated = 0; state.cash = 0; invHist = []; pfHist = {}; pfOrder = null; nudge = window.PCNudge ? window.PCNudge.create() : null; nudgeMin = 0; if (window.PCBouncer && window.PCBouncer.reset) window.PCBouncer.reset(); sim = newSim({}); window.__paracord.sim = sim; STOCKS.forEach(function (s) { state.open[s.t] = sim.price(s.t); }); save(); replace({ view: 'home' }); toast('Demo reset'); }
        else { el.dataset.armed = '1'; el.textContent = 'Tap again to reset everything'; }
        break;
      case 'cashout': go({ view: 'cashout', t: t, step: 'summary', n: state.ins[t].shares, flow: Date.now().toString(36) }); break;
      case 'co-n': setN((route.n || 1) + (+el.dataset.d)); break;
      case 'co-max': setN(state.ins[route.t].shares); break;
      case 'co-review': go(Object.assign({}, route, { step: 'confirm' })); break;
      case 'co-confirm': doCashout(); break;
      case 'receipt-done': history.go(-2); break;
      case 'conf': var cv = +el.dataset.v; confSet(cv, cv < 0 ? true : false);
        toast(cv < 0 ? '⚡ Demo panic day: market −1.5σ, news shock on all four' : cv > 0 ? 'Demo euphoria: market +1.5σ, news cleared' : 'Demo normal day: news cleared'); break;
    }
  });
  function setN(n) {
    var ins = state.ins[route.t]; if (!ins) return;
    n = Math.max(1, Math.min(ins.shares, Math.round(n) || 1));
    route = Object.assign({}, route, { n: n }); history.replaceState(route, '', hashOf(route));
    var i = document.getElementById('coN'), r = document.getElementById('coR');
    if (i && +i.value !== n) i.value = n; if (r) r.value = n;
    document.getElementById('cosum').innerHTML = coRows(route.t, n);
  }
  document.addEventListener('input', function (e) {
    if (e.target.id === 'coN' || e.target.id === 'coR') setN(+e.target.value);
    if (e.target.id === 'confSlider') confSet(+e.target.value / 100);
    if (e.target.id === 'memberAgree') { var jb = document.getElementById('memberJoin'); if (jb) jb.disabled = !e.target.checked; }
    if (e.target.id === 'kslider') {
      var t = e.target.dataset.t, ins = state.ins[t]; if (!ins) return;
      accrue();
      var oldK = ins.lockIn, newK = Math.min(+e.target.value, sim.price(t));
      // v4: changing K is a re-lock at today's conditions; tenure (taper day, floor clock) is kept only when K is lowered
      ins.lockIn = newK; ins.lock = lockNow(t);
      if (newK > oldK + 1e-9) { var nw = simNow(); ins.enabledAt = nw; ins.blockStart = nw; ins.blockCost = 0; ins.blockRebate = 0; }
      ins.shares = capFor(t, newK);
      save(); live();
    }
  });
  document.getElementById('backBtn').onclick = function () { history.back(); };
  document.getElementById('demoChip').onclick = function () { if (route.sheet !== 'demo') openSheet('demo'); };
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.dataset.tab); }; });

  /* ---------------- loop ---------------- */
  function tick() {
    var nowR = Date.now();
    state.clock.offset += (nowR - lastReal) * (state.clock.speed - 1);
    lastReal = nowR;
    sim.step();
    STOCKS.forEach(function (s) { state.px[s.t] = sim.price(s.t); });
    Object.keys(state.ins).forEach(function (t) { if (sim.has(t)) state.px[t] = sim.price(t); }); // tabs1: covered portfolio names keep their price across reloads
    heldTickers().forEach(function (d) { if (sim.hist(d.t).length > 1) return; var a = pfHist[d.t] || (pfHist[d.t] = []); a.push(sim.price(d.t)); if (a.length > 180) a.shift(); });
    // confidence index: ease the crowd mood toward the chosen scenario, small AR(1) noise, then record the session sparkline
    state.conf.mood += (state.conf.target - state.conf.mood) * 0.25;
    sim.setScenario(state.conf.mood < 0 ? state.conf.mood * 3 : state.conf.mood * 1.5); // p9: scenario drives the sim's market factor
    confNoise = 0.92 * confNoise + 0.12 * (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    var cr = confCompute(); if (cr) { confHist.push(cr.index); if (confHist.length > 240) confHist.shift(); if (confBook) { window.PCConfidence.accrue(confBook, cr, 1); netTrack(confBook); invHist.push(confBook.invValue); if (invHist.length > 240) invHist.shift(); } } // 1 tick = 1 sim trading minute
    nudgeStep();
    if (window.PCBouncer && window.PCBouncer.tick) window.PCBouncer.tick(cr, confBook); // bouncer1: ops alert, once per sim minute
    accrue(); save(); live();
  }
  /* nudge1: one nudge evaluation per sim trading minute over every held position (not only rows on screen) */
  function nudgeStep() {
    if (!nudge) return;
    nudgeMin += 1;
    var mins = confBook ? confBook.minutes : nudgeMin, day = tcParts(mins).day;
    var rows = heldTickers().map(function (d) { return { t: d.t, price: sim.price(d.t), covered: !!state.ins[d.t], capped: capped(d.t) }; });
    window.PCNudge.step(nudge, day, mins, rows, openOf); // previous close on day 1 = the session's opening price (no prior close in the sim)
  }

  // initial route (supports deep links like #/stock/COP)
  var m = location.hash.match(/^#\/(\w+)(?:\/(\w+))?/);
  history.replaceState({ view: 'home' }, '', '#/home');
  accrue();
  if (m && m[1] === 'stock' && BY_T[m[2]]) go({ view: 'stock', t: m[2] });
  else if (m && ROOTS.indexOf(m[1]) > 0) go({ view: m[1] });
  else render();
  setInterval(tick, 1000);

  // test/demo hook (read-only helpers)
  window.__paracord = { state: function () { return state; }, rate: rateOf, breakdown: breakdown, capFor: capFor, isMember: isMember, sim: sim, news: newsScore, confidence: function () { return confLast; }, book: function () { return confBook; }, netDay: function () { return netDay; }, nudge: function () { return nudge; } };
})();
