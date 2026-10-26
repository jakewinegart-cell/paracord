/* Paracord — User Confidence Index (DEMO). A 0–100 score of how confident demo Paracord users feel,
 * computed from simulated crowd behavior (insurance turned on, cash-ins at the cushion, waiting line / surge),
 * the simulated market move and news shock. Next to it: a resilience check of today's demo book using the
 * v4 pieces (rate.js: rate locked at start, duration taper, 1.15x put floor, per-person caps, annual membership)
 * and the p9 pieces (lock vol = max(recent realized, implied); firm-wide $ limits per name / sector / total with
 * book-stress surge; sampled user portfolios across the whole demo-snapshot universe).
 * Nothing here is real data or a forecast. */
(function (g) {
  'use strict';
  var DEFS = g.PC_UNIVERSE_DEFS && g.PC_UNIVERSE_DEFS.length ? g.PC_UNIVERSE_DEFS : g.PC_STOCKS;
  var DEMO = (g.PC_STOCKS || []).map(function (s) { return s.t; });
  var LIM = g.paracordLimits;
  var CFG = {
    users: 100000,      // demo user base
    samples: 4000,      // sampled portfolios; each stands for users / samples identical users
    seed: 20261025,
    demoPick: { NVDA: 0.4, WMT: 0.2, COP: 0.2, MOON: 0.2 }, // every user holds 1 demo name (35%: a 2nd) ...
    secondDemo: 0.35,
    spNames: [1, 3],    // ... plus 1–3 S&P 500 names (70% cap-weighted, 30% equal-weighted pick)
    posMedian: 4000, posSigma: 0.9, // $ position per name: lognormal (median $4,000)
    cushion: 0.05,      // K = open × (1 − 5%)
    surgePct: 0.5,      // over-capacity users who pay surge (rest wait)
    session: 390, cashInMin: 195, // cash-ins assumed at mid-session: they pay 195 min, holders pay 390
    panicSigma: 3, euphoriaSigma: 1.5, // scenario index move at mood −1 / +1, in daily σ (applied to the sim's market factor)
    fee: (g.PARACORD_RATE_CONSTANTS || {}).MEMBERSHIP_FEE || 199, // Yearly plan fee (kept for older callers)
    // p12 membership plans (rate.js): Yearly $199 paid up front; Monthly $29.99 billed each month.
    feeYearly: (g.PARACORD_RATE_CONSTANTS || {}).MEMBERSHIP_YEARLY || 199,
    feeMonthly: (g.PARACORD_RATE_CONSTANTS || {}).MEMBERSHIP_MONTHLY || 29.99,
    mixYearly: (g.PARACORD_RATE_CONSTANTS || {}).MEMBER_MIX_YEARLY != null ? g.PARACORD_RATE_CONSTANTS.MEMBER_MIX_YEARLY : 0.7, // DEMO ASSUMPTION
    churnMonthly: (g.PARACORD_RATE_CONSTANTS || {}).MEMBER_CHURN_MONTHLY != null ? g.PARACORD_RATE_CONSTANTS.MEMBER_CHURN_MONTHLY : 0.08, // DEMO ASSUMPTION, per month
    monthMin: ((g.PARACORD_RATE_CONSTANTS || {}).MONTH_TRADING_DAYS || 21) * 390 // one sim month of book minutes
  };
  var RC = g.PARACORD_RATE_CONSTANTS;
  var BANDS = [[0, 20, 'Extreme fear'], [20, 40, 'Fear'], [40, 60, 'Neutral'], [60, 80, 'Confident'], [80, 101, 'Euphoric']];
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
  function Gz(z) { var phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); return phi - z * (1 - Phi(z)); }
  function Phi(z) { var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x); var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
  function shortfall(N, S, K, sd) { if (sd <= 0) return Math.max(0, K - S) * N; return N * S * sd * Gz((S - K) / (S * sd)); }
  function band(v) { for (var i = 0; i < BANDS.length; i++) if (v < BANDS[i][1]) return BANDS[i][2]; return 'Euphoric'; }

  /* ---- sampled portfolios (seeded, built once): per name, holders and average capped shares per holder ---- */
  function rng(seed) { var a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var CROWD = (function () {
    var R = rng(CFG.seed), by = {}, sp = DEFS.filter(function (d) { return DEMO.indexOf(d.t) < 0 && !d.fictional; });
    var wsum = sp.reduce(function (a, d) { return a + (d.w || 0); }, 0), cum = [], acc = 0;
    sp.forEach(function (d) { acc += 0.7 * (wsum ? (d.w || 0) / wsum : 0) + 0.3 / sp.length; cum.push(acc); });
    function pickSp() { var u = R() * acc, lo = 0, hi = cum.length - 1; while (lo < hi) { var m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; } return sp[lo]; }
    var dk = Object.keys(CFG.demoPick).filter(function (t) { return g.PC_UNIVERSE_BY_T ? g.PC_UNIVERSE_BY_T[t] : true; });
    function pickDemo(ex) { var tot = 0; dk.forEach(function (t) { if (t !== ex) tot += CFG.demoPick[t]; }); var u = R() * tot; for (var i = 0; i < dk.length; i++) { if (dk[i] === ex) continue; u -= CFG.demoPick[dk[i]]; if (u <= 0) return dk[i]; } return dk[dk.length - 1]; }
    function gauss() { var u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    var wUser = CFG.users / CFG.samples, BYT = {}; DEFS.forEach(function (d) { BYT[d.t] = d; });
    var namesPer = 0, insuredPer = 0, list = []; // bouncer1: also keep each sampled portfolio (no extra random draws, aggregates unchanged)
    for (var s = 0; s < CFG.samples; s++) {
      var names = [pickDemo(null)]; if (R() < CFG.secondDemo) names.push(pickDemo(names[0]));
      var k = CFG.spNames[0] + Math.floor(R() * (CFG.spNames[1] - CFG.spNames[0] + 1));
      for (var j = 0; j < k; j++) { var d = pickSp(); if (names.indexOf(d.t) < 0) names.push(d.t); }
      // random order for the $25k total cap
      for (var q = names.length - 1; q > 0; q--) { var r = Math.floor(R() * (q + 1)), tmp = names[q]; names[q] = names[r]; names[r] = tmp; }
      var other = 0, mine = { i: s, legs: [], insured: 0 };
      names.forEach(function (t) {
        var dd = BYT[t]; if (!dd) return;
        var px = dd.p0, sh = Math.max(1, Math.round(CFG.posMedian * Math.exp(CFG.posSigma * gauss()) / px)), K = px * (1 - CFG.cushion);
        var c = g.paracordCapShares(K, sh, other); other += c * K;
        if (c <= 0) return;
        var a = by[t] || (by[t] = { holders: 0, shares: 0 }); a.holders += wUser; a.shares += wUser * c;
        namesPer += 1; insuredPer += c * K; mine.legs.push({ t: t, sh: c, Kf: 1 - CFG.cushion }); mine.insured += c * K;
      });
      if (mine.legs.length) list.push(mine);
    }
    Object.keys(by).forEach(function (t) { by[t].sh = by[t].shares / by[t].holders; });
    return { by: by, names: Object.keys(by), avgNames: namesPer / CFG.samples, avgInsured: insuredPer / CFG.samples, holders: list, usersPerSample: wUser };
  })();
  var BY_T = {}; DEFS.forEach(function (d) { BY_T[d.t] = d; });

  /**
   * ctx: { price(t), open(t), sigma1(t) (recent realized, per min), news(t), mood (−1..1, eased), noise, at (sim ms) }
   * Returns the index, its inputs, and the resilience book.
   */
  function compute(ctx) {
    var mood = clamp(ctx.mood, -1, 1);
    var overlay = mood < 0 ? mood * CFG.panicSigma : mood * CFG.euphoriaSigma; // scenario index move (σ), applied by the sim
    var wsum = 0, mkt = 0, H = 0, down = 0, legs = [];
    CROWD.names.forEach(function (t) {
      var d = BY_T[t], cw = CROWD.by[t]; if (!d || !ctx.has(t)) return;
      var S0 = ctx.open(t), sd = d.vol / Math.sqrt(252), S = ctx.price(t), x = Math.log(S / S0);
      var l = { d: d, S0: S0, sd: sd, x: x, S: S, H: ctx.news(t), sigma1: ctx.sigma1(t), holders: cw.holders, shPer: cw.sh };
      legs.push(l); wsum += cw.holders; mkt += cw.holders * x / sd; H += cw.holders * l.H; if (x < 0) down++;
    });
    mkt = wsum ? mkt / wsum : 0; H = wsum ? H / wsum : 0;   // holder-weighted move in daily σ and news
    // share of users turning insurance on (panic lock-ins push it up; calm/greed pulls it down)
    var pIns = sigmoid(-1.0 - 0.9 * clamp(mkt, -4, 3) + 1.6 * H - 1.4 * mood + (ctx.noise || 0));
    var orders = Math.round(CFG.users * pIns);
    // p9 firm-wide limits: demand per name in $ (K × capped shares), shared sector / firm limits, book-wide stress
    var items = legs.map(function (l) {
      var K = l.S0 * (1 - CFG.cushion); l.K = K; l.sh = Math.max(1, Math.round(l.shPer)); l.orders = Math.round(pIns * l.holders);
      return { key: l.d.t, sector: l.d.sector, demand: l.orders * l.sh * K, cap: LIM.nameLimit(l.d) };
    });
    var al = LIM.allocate(items), stress = LIM.bookStress(al.firmUtil, al.sectorUtilMax, mkt), Mnow = LIM.surgeMultiplier(stress);
    var T = { prem: 0, base: 0, uplift: 0, pay: 0, payCash: 0, payExp: 0, policies: 0, cashers: 0, wait: 0, surge: 0, orders: 0, target: 0, uMax: 0, uSum: 0, insured: 0 };
    var at = ctx.at || Date.now();
    legs.forEach(function (l, i) {
      var d = l.d, K = l.K, sh = l.sh;
      var f = LIM.fillBook(l.orders, sh * K, al.lim[d.t], CFG.surgePct, stress);
      var pol = f.normal + f.surge;
      // v4 rate lock + p9 lock vol: the crowd locks at the open price, news then, and vol = max(recent realized, implied)
      // (implied includes an earnings bump if a known report date falls in the next 28 days). Later moves don't reprice.
      var rv = l.sigma1 * Math.sqrt(RC.MIN_PER_YEAR / RC.w_session), lv = g.paracordLockVol(d, { at: at, rv: rv });
      if (!LOCK[d.t]) LOCK[d.t] = { price: l.S0, volatility: lv.used, news: l.H, lv: lv };
      var o = { price: l.S, shares: sh, lockIn: K, volatility: lv.used, float: d.float, adv: d.adv, news: l.H };
      var base0 = g.insuranceRateBreakdown(Object.assign({}, o, { lock: LOCK[d.t] })).baseRaw;
      var rateNow = g.insuranceRateBreakdown(Object.assign({}, o, { lock: { price: l.S, volatility: lv.used, news: l.H } })).baseRaw;
      var below = l.S < K, cashFrac = below ? 0.2 + 0.7 * pIns : 0;  // optional exercise: only some of those below K cash in
      var cashers = pol * cashFrac, holders = pol - cashers;
      var basePrem = holders * base0 * CFG.session + cashers * base0 * CFG.cashInMin;
      var uplift = pol ? basePrem / pol * f.sumMm1 : 0;   // surge: charge × (M − 1) on top → reserve
      var payCash = cashers * sh * Math.max(0, K - l.S);
      var sdRest = l.sigma1 * (1 + l.H) * Math.sqrt(CFG.session - CFG.cashInMin);
      var payExp = holders * shortfall(sh, l.S, K, sdRest);
      l.lock = LOCK[d.t]; l.lv = lv; l.rateNow = rateNow; l.o = o;
      l.cashFrac = cashFrac; l.sdRest = sdRest; l.f = f; l.pol = pol; l.base = base0; l.cashers = cashers; l.prem = basePrem + uplift; l.pay = payCash + payExp;
      T.base += basePrem; T.uplift += uplift; T.prem += basePrem + uplift; T.payCash += payCash; T.payExp += payExp; T.pay += payCash + payExp;
      T.policies += pol; T.cashers += cashers; T.wait += f.wait; T.surge += f.surge; T.insured += f.Qn + f.Qs;
      T.target += f.Qs / K * Math.max(0, K - l.S0 * 0.8); T.uMax = Math.max(T.uMax, Math.min(f.u, al.lim[d.t] ? (f.Qn + f.Qs) / LIM.nameLimit(d) : 0)); T.uSum += f.u;
    });
    T.orders = orders; T.legOrders = legs.reduce(function (a, l) { return a + l.orders; }, 0);
    T.uAvg = legs.length ? T.uSum / legs.length : 0;
    T.firmUtil = al.firmUtil; T.sectorUtil = al.sectorUtil; T.sectorUtilMax = al.sectorUtilMax; T.stress = stress; T.M = Mnow;
    T.firmUsed = T.insured / RC.FIRM_LIMIT;
    var cashRate = T.policies ? T.cashers / T.policies : 0;
    var lineRate = T.legOrders ? (T.wait + T.surge) / T.legOrders : 0;
    var drop = clamp(-mkt / 3, 0, 1), rally = clamp(mkt / 2, 0, 1);
    var fear = 0.40 * pIns + 0.20 * cashRate + 0.15 * lineRate + 0.15 * drop + 0.10 * H - 0.25 * rally;
    var index = clamp(100 / (1 + Math.exp(8 * (fear - 0.15))), 0, 100);
    var shortBase = T.pay - T.base, status, ok;
    if (shortBase <= 0) { status = 'Covered: premiums cover payouts'; ok = 'ok'; }
    else if (shortBase <= T.uplift) { status = 'Covered: reserve absorbs payouts'; ok = 'ok'; }
    else { status = 'Not covered: ' + Math.round(shortBase - T.uplift).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) + ' would come from general capital'; ok = 'bad'; }
    var moves = {}; legs.forEach(function (l) { if (DEMO.indexOf(l.d.t) >= 0) moves[l.d.t] = l.x; });
    return { index: index, band: band(index), fear: fear, mood: mood, overlay: overlay, mkt: mkt, H: H, pIns: pIns, cashRate: cashRate, lineRate: lineRate, drop: drop, rally: rally,
      legs: legs, T: T, orders: orders, status: status, ok: ok, net: T.prem - T.pay, reserveUsed: Math.max(0, Math.min(T.uplift, shortBase)),
      moves: moves, downShare: legs.length ? down / legs.length : 0, nNames: legs.length };
  }

  /* Running book for the session (since page load / demo reset). compute() above is a what-if snapshot that is
   * recomputed every tick, so its totals move both ways; the dashboard shows this book instead.
   * Physical settlement: on cash-in Paracord pays K × shares in cash and takes the shares into inventory.
   *  - collected: premiums actually accrued so far = Σ open policies × live base rate (+ surge uplift) × elapsed minutes. Never decreases.
   *  - reserve:   the surge-uplift part of collected (100% to the risk reserve). Never decreases.
   *  - cashOut:   cash paid for cash-in purchases, K × shares. Never decreases.
   *  - inventory: shares bought on cash-in (only ever increase; nothing auto-sells), cost basis K, value at acquisition S,
   *               marked to market every tick at the live price. Immediate economic loss at cash-in = (K − S) × shares.
   *  - open:      open exposure = economic loss if every still-open policy cashed in now, (K − S)+ × 100 (moves up and down);
   *               openCash = cash that would need to go out for those, K × 100 on in-the-money policies.
   *  - membership: p12 plan mix (DEMO ASSUMPTION 70% Yearly / 30% Monthly) of every user who has turned insurance on.
   *               Yearly: $199 arrives up front at join. Monthly: $29.99 per sim month (21 trading days = 8,190 sim-min),
   *               accrued pro rata each sim-minute on the still-active monthly members, who churn at an assumed 8%/month
   *               (also pro rata). Non-refundable for the current period: cash kept, no refund liability. Never decreases.
   *  - net:       net position = collected + membership − cashOut + inventory market value.
   * Scenario buttons / slider only change the rates going forward. */
  var LOCK = {}; // crowd's locked rate inputs per stock (set at the first snapshot after a new book)
  function newBook() { LOCK = {}; return { minutes: 0, collected: 0, base: 0, reserve: 0, floorPart: 0, cashOut: 0, cashedPol: 0, open: 0, openCash: 0, openPol: 0, inv: {}, invValue: 0, invCost: 0, invAcq: 0, legs: {}, members: 0, membership: 0, fee: CFG.fee, memYearly: 0, memMonthly: 0, mYearly: 0, mMonthlyJoined: 0, mMonthlyActive: 0 }; }
  function invAdd(B, t, sh, K, S) {
    if (!(sh > 0)) return;
    var I = B.inv[t] || (B.inv[t] = { sh: 0, cost: 0, acq: 0, px: S });
    I.sh += sh; I.cost += sh * K; I.acq += sh * S; B.cashOut += sh * K;
    if (I.px == null) I.px = S;
  }
  function mark(B) {
    var v = 0, c = 0, a = 0;
    Object.keys(B.inv).forEach(function (t) { var I = B.inv[t]; I.value = I.sh * I.px; v += I.value; c += I.cost; a += I.acq; });
    B.invValue = v; B.invCost = c; B.invAcq = a;
    B.net = B.collected + (B.membership || 0) - B.cashOut + v; // membership is non-refundable: cash kept, no refund liability
    var res = B.net - B.open, resBase = res - B.reserve, fmt = function (x) { return Math.round(x).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }); };
    if (B.minutes === 0 && !c) { B.ok = 'ok'; B.status = 'Collecting…'; }
    else if (resBase - (B.membership || 0) >= 0) { B.ok = 'ok'; B.status = 'Covered: premiums and inventory cover open exposure'; }
    else if (res - (B.membership || 0) >= 0) { B.ok = 'ok'; B.status = 'Covered: surge reserve absorbs the gap'; }
    else if (res >= 0) { B.ok = 'ok'; B.status = 'Covered: membership cash absorbs the gap'; }
    else { B.ok = 'bad'; B.status = 'Not covered: ' + fmt(-res) + ' would come from general capital'; }
    return B;
  }
  function accrue(B, r, dtMin) {
    if (!r || !(dtMin > 0)) return B;
    var open = 0, openCash = 0, openPol = 0;
    // p12: every user who turns insurance on joins once, on the assumed plan mix (non-refundable for the period, kept)
    var prevM = B.members || 0; B.members = Math.max(prevM, r.orders || 0);
    var joined = B.members - prevM, mf = dtMin / CFG.monthMin;
    if (joined > 0) {
      B.mYearly += joined * CFG.mixYearly; B.memYearly += joined * CFG.mixYearly * CFG.feeYearly;          // Yearly: up front
      B.mMonthlyJoined += joined * (1 - CFG.mixYearly); B.mMonthlyActive += joined * (1 - CFG.mixYearly);
    }
    B.memMonthly += B.mMonthlyActive * CFG.feeMonthly * mf;                                                // Monthly: pro rata per sim month
    B.mMonthlyActive *= Math.pow(1 - CFG.churnMonthly, mf);                                                // assumed churn, pro rata
    B.membership = B.memYearly + B.memMonthly;
    // v4 taper day and floor clock from the book's minutes (1 tick = 1 trading minute; 390 min = 1 trading day)
    var day = Math.floor(B.minutes / CFG.session) + 1, tau1 = B.minutes / RC.MIN_PER_YEAR * RC.var_session, tau2 = (B.minutes + dtMin) / RC.MIN_PER_YEAR * RC.var_session;
    r.legs.forEach(function (l) {
      var t = l.d.t, L = B.legs[t] || (B.legs[t] = { cashed: 0, collected: 0, pol: 0, rateSum: 0 });
      // policies: locked ones keep their rate; new ones lock at current conditions; users switching off leave pro rata
      var target = Math.max(0, l.pol - L.cashed);
      if (target > L.pol) { L.rateSum += (target - L.pol) * l.rateNow; L.pol = target; }
      else if (target < L.pol) { L.rateSum *= L.pol ? target / L.pol : 0; L.pol = target; }
      var pol = L.pol, avgRaw = pol ? L.rateSum / pol : 0;
      // per policy: min(cap, max(ops min, tapered locked base, 1.15 x put floor increment)) per minute
      var c = g.paracordChargeForInterval(Object.assign({}, l.o, { lock: l.lock, day: day }), tau1, tau2, dtMin, 1);
      var baseMin = avgRaw * g.paracordTaper(day) * dtMin;
      var perPol = Math.min(RC.R_max * dtMin, Math.max(RC.R_min * dtMin, baseMin, c.floor));
      var basePrem = pol * perPol;
      if (c.floor > baseMin) B.floorPart += pol * (c.floor - baseMin);
      var uplift = l.pol ? basePrem * l.f.sumMm1 / l.pol : 0;      // surge users pay their charge × (M − 1) on top → reserve
      var cashers = l.S < l.K ? pol * Math.min(1, l.cashFrac * dtMin / CFG.cashInMin) : 0; // optional exercise, spread over the session
      if (cashers > 0) { L.rateSum *= (pol - cashers) / pol; L.pol -= cashers; }
      L.cashed += cashers; L.collected += basePrem + uplift;
      B.base += basePrem; B.reserve += uplift; B.collected += basePrem + uplift; B.cashedPol += cashers;
      if (B.inv[t]) B.inv[t].px = l.S;
      invAdd(B, t, cashers * l.sh, l.K, l.S);                      // pay K × shares, receive the shares
      var still = pol - cashers;
      openPol += still; open += still * l.sh * Math.max(0, l.K - l.S);
      if (l.S < l.K) openCash += still * l.sh * l.K;
    });
    B.minutes += dtMin; B.open = open; B.openCash = openCash; B.openPol = openPol; B.day = day;
    return mark(B);
  }
  /** a single sale outside the crowd model (the demo user's own cash-out): shares at K, market S */
  function addSale(B, t, sh, K, S) { invAdd(B, t, sh, K, S); B.inv[t].px = S; return mark(B); }

  g.PCConfidence = { crowd: CROWD, compute: compute, newBook: newBook, accrue: accrue, addSale: addSale, CFG: CFG, BANDS: BANDS, band: band };
})(window);
