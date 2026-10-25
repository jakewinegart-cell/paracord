/* Paracord — User Confidence Index (DEMO). A 0–100 score of how confident demo Paracord users feel,
 * computed from simulated crowd behavior (insurance turned on, cash-ins at the cushion, waiting line / surge),
 * the simulated market move and news shock. Next to it: a resilience check of today's demo book using the
 * v4 pieces (rate.js: rate locked at start, duration taper, 1.15x put floor, per-person caps; projections.js capacity fill
 * + surge multiplier; surge-uplift reserve; annual membership cash, non-refundable).
 * Nothing here is real data or a forecast. */
(function (g) {
  'use strict';
  var STOCKS = g.PC_STOCKS, PJ = g.PCProjections;
  var CFG = {
    users: 100000,      // demo user base; each holds `shares` of every demo stock
    shares: 100,
    cushion: 0.05,      // K = open × (1 − 5%)
    surgePct: 0.5,      // over-capacity users who pay surge (rest wait)
    session: 390, cashInMin: 195, // cash-ins assumed at mid-session: they pay 195 min, holders pay 390
    panicSigma: 3, euphoriaSigma: 1.5, // scenario market move at mood −1 / +1, in daily σ of each stock
    fee: (g.PARACORD_RATE_CONSTANTS || {}).MEMBERSHIP_FEE || 99 // annual membership, paid up front, non-refundable
  };
  var RC = g.PARACORD_RATE_CONSTANTS;
  var BANDS = [[0, 20, 'Extreme fear'], [20, 40, 'Fear'], [40, 60, 'Neutral'], [60, 80, 'Confident'], [80, 101, 'Euphoric']];
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
  function Gz(z) { var phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); return phi - z * (1 - Phi(z)); }
  function Phi(z) { var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x); var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
  function shortfall(N, S, K, sd) { if (sd <= 0) return Math.max(0, K - S) * N; return N * S * sd * Gz((S - K) / (S * sd)); }
  function band(v) { for (var i = 0; i < BANDS.length; i++) if (v < BANDS[i][1]) return BANDS[i][2]; return 'Euphoric'; }

  /**
   * ctx: { price(t), open(t), sigma1(t), news(t), mood (−1..1, eased), noise (small, per tick) }
   * Returns the index, its inputs, and the resilience book.
   */
  function compute(ctx) {
    var mood = clamp(ctx.mood, -1, 1);
    var overlay = mood < 0 ? mood * CFG.panicSigma : mood * CFG.euphoriaSigma; // scenario market move, σ units
    var legs = STOCKS.map(function (d) {
      var S0 = ctx.open(d.t), sd = d.vol / Math.sqrt(252);
      var x = Math.log(ctx.price(d.t) / S0) + overlay * sd;
      return { d: d, S0: S0, sd: sd, x: x, S: S0 * Math.exp(x), H: ctx.news(d.t), sigma1: ctx.sigma1(d.t) };
    });
    var mkt = legs.reduce(function (a, l) { return a + l.x / l.sd; }, 0) / legs.length;  // avg move in daily σ
    var H = legs.reduce(function (a, l) { return a + l.H; }, 0) / legs.length;
    // share of users turning insurance on (panic lock-ins push it up; calm/greed pulls it down)
    var pIns = sigmoid(-1.0 - 0.9 * clamp(mkt, -4, 3) + 1.6 * H - 1.4 * mood + (ctx.noise || 0));
    var orders = Math.round(CFG.users * pIns);
    var T = { prem: 0, base: 0, uplift: 0, pay: 0, payCash: 0, payExp: 0, policies: 0, cashers: 0, wait: 0, surge: 0, orders: 0, target: 0, uMax: 0, uSum: 0 };
    var other = 0; // per-person $25k total cap across stocks (each user holds CFG.shares of every stock)
    legs.forEach(function (l) {
      var d = l.d, K = l.S0 * (1 - CFG.cushion);
      var sh = g.paracordCapShares(K, CFG.shares, other); other += sh * K;   // capped shares per person
      var f = PJ.fill(orders, sh, 0.01 * d.float, CFG.surgePct);
      var pol = f.normal + f.surge;
      // v4: rate locked at the open (crowd locks at the open price, its σ₁ and news at that time); a later move does
      // not reprice it. rateNow = the locked base a user would get by locking right now (new locks only).
      if (!LOCK[d.t]) LOCK[d.t] = { price: l.S0, sigma1: l.sigma1, news: l.H };
      var o = { price: l.S, shares: sh, lockIn: K, sigma1: l.sigma1, float: d.float, adv: d.adv, news: l.H };
      var base0 = g.insuranceRateBreakdown(Object.assign({}, o, { lock: LOCK[d.t] })).baseRaw;
      var rateNow = g.insuranceRateBreakdown(Object.assign({}, o, { lock: { price: l.S, sigma1: l.sigma1, news: l.H } })).baseRaw;
      var base1 = base0, half = CFG.session - CFG.cashInMin;
      var below = l.S < K, cashFrac = below ? 0.2 + 0.7 * pIns : 0;  // optional exercise: only some of those below K cash in
      var cashers = pol * cashFrac, holders = pol - cashers;
      var perPolicyHolder = base0 * CFG.session, perPolicyCasher = base0 * CFG.cashInMin;
      var basePrem = holders * perPolicyHolder + cashers * perPolicyCasher;
      var uplift = pol ? basePrem / pol * f.sumMm1 : 0;   // surge users pay Base × (M − 1) on top → reserve
      var base = base0;
      var payCash = cashers * sh * Math.max(0, K - l.S);
      var sdRest = l.sigma1 * (1 + l.H) * Math.sqrt(CFG.session - CFG.cashInMin);
      var payExp = holders * shortfall(sh, l.S, K, sdRest);
      l.sh = sh; l.lock = LOCK[d.t]; l.rateNow = rateNow; l.o = o;
      l.cashFrac = cashFrac; l.sdRest = sdRest; l.f = f; l.pol = pol; l.base = base; l.base1 = base1; l.cashers = cashers; l.prem = basePrem + uplift; l.pay = payCash + payExp; l.K = K;
      T.base += basePrem; T.uplift += uplift; T.prem += basePrem + uplift; T.payCash += payCash; T.payExp += payExp; T.pay += payCash + payExp;
      T.policies += pol; T.cashers += cashers; T.wait += f.wait; T.surge += f.surge; T.orders += orders;
      T.target += f.Qs * Math.max(0, K - l.S0 * 0.8); T.uMax = Math.max(T.uMax, f.u); T.uSum += f.u;
    });
    T.orders = orders;
    T.uAvg = T.uSum / legs.length;
    var cashRate = T.policies ? T.cashers / T.policies : 0;
    var lineRate = T.orders ? (T.wait + T.surge) / T.orders : 0;
    var drop = clamp(-mkt / 3, 0, 1), rally = clamp(mkt / 2, 0, 1);
    var fear = 0.40 * pIns + 0.20 * cashRate + 0.15 * lineRate + 0.15 * drop + 0.10 * H - 0.25 * rally;
    var index = clamp(100 / (1 + Math.exp(8 * (fear - 0.15))), 0, 100);
    var shortBase = T.pay - T.base, status, ok;
    if (shortBase <= 0) { status = 'Covered: premiums cover payouts'; ok = 'ok'; }
    else if (shortBase <= T.uplift) { status = 'Covered: reserve absorbs payouts'; ok = 'ok'; }
    else { status = 'Not covered: ' + Math.round(shortBase - T.uplift).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) + ' would come from general capital'; ok = 'bad'; }
    return { index: index, band: band(index), fear: fear, mood: mood, overlay: overlay, mkt: mkt, H: H, pIns: pIns, cashRate: cashRate, lineRate: lineRate, drop: drop, rally: rally,
      legs: legs, T: T, orders: orders, status: status, ok: ok, net: T.prem - T.pay, reserveUsed: Math.max(0, Math.min(T.uplift, shortBase)) };
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
   *  - membership: annual fees of every user who has turned insurance on (non-refundable: cash kept, no refund liability).
   *  - net:       net position = collected + membership − cashOut + inventory market value.
   * Scenario buttons / slider only change the rates going forward. */
  var LOCK = {}; // crowd's locked rate inputs per stock (set at the first snapshot after a new book)
  function newBook() { LOCK = {}; return { minutes: 0, collected: 0, base: 0, reserve: 0, floorPart: 0, cashOut: 0, cashedPol: 0, open: 0, openCash: 0, openPol: 0, inv: {}, invValue: 0, invCost: 0, invAcq: 0, legs: {}, members: 0, membership: 0, fee: CFG.fee }; }
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
    // every user who turns insurance on buys the annual membership once (non-refundable, kept)
    B.members = Math.max(B.members || 0, r.orders || 0); B.membership = B.members * CFG.fee;
    // v4 taper day and floor clock from the book's minutes (1 tick = 1 trading minute; 390 min = 1 trading day)
    var day = Math.floor(B.minutes / CFG.session) + 1, tau1 = B.minutes / RC.MIN_PER_YEAR * RC.w_session, tau2 = (B.minutes + dtMin) / RC.MIN_PER_YEAR * RC.w_session;
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

  g.PCConfidence = { compute: compute, newBook: newBook, accrue: accrue, addSale: addSale, CFG: CFG, BANDS: BANDS, band: band };
})(window);
