/* Paracord — User Confidence Index (DEMO). A 0–100 score of how confident demo Paracord users feel,
 * computed from simulated crowd behavior (insurance turned on, cash-ins at the cushion, waiting line / surge),
 * the simulated market move and news shock. Next to it: a resilience check of today's demo book using the
 * existing v3 pieces (rate.js base rate, projections.js capacity fill + surge multiplier, surge-uplift reserve).
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
    panicSigma: 3, euphoriaSigma: 1.5 // scenario market move at mood −1 / +1, in daily σ of each stock
  };
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
    legs.forEach(function (l) {
      var d = l.d, K = l.S0 * (1 - CFG.cushion);
      var f = PJ.fill(orders, CFG.shares, 0.01 * d.float, CFG.surgePct);
      var pol = f.normal + f.surge;
      // v3 base rate clamp(c·E·L·(1+3H), $0.02, $6) (no full-day discount). The live rate reprices every minute:
      // first half of the session at the lock-in price S0, second half at the moved price S.
      var rate = function (S) { return g.insuranceRateBreakdown({ price: S, shares: CFG.shares, lockIn: K, sigma1: l.sigma1, float: d.float, adv: d.adv, news: l.H }).preDiscount; };
      var base0 = rate(l.S0), base1 = rate(l.S), half = CFG.session - CFG.cashInMin;
      var below = l.S < K, cashFrac = below ? 0.2 + 0.7 * pIns : 0;  // optional exercise: only some of those below K cash in
      var cashers = pol * cashFrac, holders = pol - cashers;
      var perPolicyHolder = base0 * CFG.cashInMin + base1 * half, perPolicyCasher = base0 * CFG.cashInMin;
      var basePrem = holders * perPolicyHolder + cashers * perPolicyCasher;
      var uplift = pol ? basePrem / pol * f.sumMm1 : 0;   // surge users pay Base × (M − 1) on top → reserve
      var base = base0;
      var payCash = cashers * CFG.shares * Math.max(0, K - l.S);
      var sdRest = l.sigma1 * (1 + l.H) * Math.sqrt(CFG.session - CFG.cashInMin);
      var payExp = holders * shortfall(CFG.shares, l.S, K, sdRest);
      l.cashFrac = cashFrac; l.sdRest = sdRest; l.f = f; l.pol = pol; l.base = base; l.base1 = base1; l.cashers = cashers; l.prem = basePrem + uplift; l.pay = payCash + payExp; l.K = K;
      T.base += basePrem; T.uplift += uplift; T.prem += basePrem + uplift; T.payCash += payCash; T.payExp += payExp; T.pay += payCash + payExp;
      T.policies += pol; T.cashers += cashers; T.wait += f.wait; T.surge += f.surge; T.orders += orders;
      T.target += f.Qs * Math.max(0, K - l.S0 * 0.8); T.uMax = Math.max(T.uMax, f.u); T.uSum += f.u;
    });
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
      legs: legs, T: T, status: status, ok: ok, net: T.prem - T.pay, reserveUsed: Math.max(0, Math.min(T.uplift, shortBase)) };
  }

  /* Running book for the session (since page load / demo reset). compute() above is a what-if snapshot that is
   * recomputed every tick, so its totals move both ways; the dashboard shows this book instead:
   *  - collected: premiums actually accrued so far = Σ open policies × live base rate (+ surge uplift) × elapsed minutes. Never decreases.
   *  - reserve:   the surge-uplift part of collected (100% to the risk reserve). Never decreases.
   *  - paid:      cash-ins actually paid so far, (K − S) × 100 per cashing policy. Never decreases.
   *  - open:      open exposure = what Paracord would owe now if every still-open policy cashed in, (K − S)+ × 100 (moves up and down).
   * Scenario buttons / slider only change the rates going forward. */
  function newBook() { return { minutes: 0, collected: 0, base: 0, reserve: 0, paid: 0, cashedPol: 0, open: 0, openPol: 0, legs: {} }; }
  function accrue(B, r, dtMin) {
    if (!r || !(dtMin > 0)) return B;
    var open = 0, openPol = 0;
    r.legs.forEach(function (l) {
      var L = B.legs[l.d.t] || (B.legs[l.d.t] = { cashed: 0, collected: 0, paid: 0 });
      var pol = Math.max(0, l.pol - L.cashed);                    // insured crowd minus those who already cashed in
      var basePrem = pol * l.base1 * dtMin;                         // live per-minute base rate at the current price
      var uplift = l.pol ? basePrem * l.f.sumMm1 / l.pol : 0;      // surge users pay Base × (M − 1) on top → reserve
      var cashers = l.S < l.K ? pol * Math.min(1, l.cashFrac * dtMin / CFG.cashInMin) : 0; // optional exercise, spread over the session
      var pay = cashers * CFG.shares * Math.max(0, l.K - l.S);
      L.cashed += cashers; L.collected += basePrem + uplift; L.paid += pay;
      B.base += basePrem; B.reserve += uplift; B.collected += basePrem + uplift; B.paid += pay; B.cashedPol += cashers;
      var still = pol - cashers;
      openPol += still; open += still * CFG.shares * Math.max(0, l.K - l.S); // owed now if every open policy cashed in
    });
    B.minutes += dtMin; B.open = open; B.openPol = openPol;
    var need = B.paid + B.open, fmt = function (x) { return Math.round(x).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }); };
    if (B.base >= need) { B.ok = 'ok'; B.status = 'Covered: premiums collected cover paid + open exposure'; }
    else if (B.collected >= need) { B.ok = 'ok'; B.status = 'Covered: surge reserve absorbs the gap'; }
    else { B.ok = 'bad'; B.status = 'Not covered: ' + fmt(need - B.collected) + ' would come from general capital'; }
    B.net = B.collected - B.paid;
    return B;
  }

  g.PCConfidence = { compute: compute, newBook: newBook, accrue: accrue, CFG: CFG, BANDS: BANDS, band: band };
})(window);
