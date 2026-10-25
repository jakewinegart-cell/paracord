/*
 * Paracord — per-minute insurance rate, pricing v4 (DEMO)
 * ------------------------------------------------------------------
 * Implements /workspace/paracord-pricing-v4.md (supersedes v3). DRAFT / PLACEHOLDER formula,
 * not a filed or approved rate. Demo inputs only.
 *
 * v3 core (unchanged):  Base_raw = c * E * L * (1 + 3H)
 *   E = N * S * sigma_h * G(z), sigma_h = sigma_1 * sqrt(390), z = (S - K)/(S * sigma_h)
 *   G(z) = phi(z) - z(1 - Phi(z)),  L = max(1,(F_ref/F)^0.1) * (1 + 10 N/ADV)
 *
 * v4 changes (plus a variance split: sigma_1 is session-only vol; 24/7 = session + night = one trading day):
 *  1. Duration taper.  Day n of an unbroken lock (n = 1 on the first trading day; turning coverage
 *     off resets n to 1) is billed at Base_raw * f(n), f(n) = max(sqrt(n) - sqrt(n-1), f_min).
 *     f(1) = 1 (day 1 unchanged); sum_{1..n} f = sqrt(n), the way a fixed-strike put scales.
 *  2. Put-value floor.  Cumulative charge for covered time tau (in years of trading time) never falls
 *     below floor_mult (1.15) x N x BSput(S_lock, K, sigma_lock, tau). Applied per interval as
 *     1.15 N [P(tau2) - P(tau1)], replacing the flat $0.02/min floor (a $0.002/min operational
 *     minimum remains). Cap: R_max $6/min still applies to the base (before surge), floor included.
 *  3. Rate lock.  S, sigma_1 and H are taken at lock start (S_eff = max(S_lock, K)); later price
 *     moves, vol moves and news do NOT reprice an existing lock. What still changes: the taper day n,
 *     the deterministic floor schedule, the 10% full-day discount (base part only), and anything the
 *     user changes (shares, K = a re-lock). Surge M is fixed at purchase (as in v3).
 *  Per-person caps (config): $5,000 insured value per stock and $25,000 total, insured value = K x shares,
 *  per verified person (identity/KYC), not per brokerage account.
 */
(function (g) {
  var C = {
    version: 4,
    h: 390,            // look-ahead horizon, minutes
    c: 0.0029,         // per min: ~1.12 x (1/390), fair rate + 12% load
    beta: 3,           // full-severity news ~quadruples the rate (at lock)
    F_ref: 1e9, alpha: 0.1, gamma: 10,
    R_min: 0.002,      // $/min operational minimum (v3's $0.02 flat floor is replaced by the put floor)
    R_max: 6.00,       // $/min cap on the base (before surge)
    D_full_day: 0.90,  // 10% off the base part for a completed 24h block
    taper_min: 0.05,   // f(n) never below 0.05 (reached at n ~ 100 trading days)
    floor_mult: 1.15,  // cumulative charge >= 1.15 x matching put value
    w_session: 0.75,   // share of a trading day's close-to-close variance in the 6.5h session (floor clock)
    w_night: 0.25,     // share in the overnight gap; 24/7 coverage = 1.00 trading day of variance per day
    night_cap: 6.00 * 60 * 17.5, // overnight lump cap before surge ($360/h x 17.5h, v3 sec. 6)
    MIN_PER_YEAR: 252 * 390,
    CAP_PER_STOCK: 5000,   // $ insured value (K x shares) per person per stock
    CAP_TOTAL: 25000,      // $ insured value per person across all stocks
    MEMBERSHIP_FEE: 99     // $/yr annual membership, paid up front, non-refundable (draft)
  };

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function phi(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
  function Phi(z) {
    var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  function G(z) { return phi(z) - z * (1 - Phi(z)); }
  /** f(n): taper factor for trading day n (1-based) of an unbroken lock */
  function taper(n) { n = Math.max(1, Math.floor(n)); return Math.max(C.taper_min, Math.sqrt(n) - Math.sqrt(n - 1)); }
  /** Black-Scholes put per share, r = 0, T in years */
  function bsPut(S, K, sig, T) {
    if (!(T > 0) || !(sig > 0)) return Math.max(K - S, 0);
    var v = sig * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * v * v) / v;
    return K * Phi(-(d1 - v)) - S * Phi(-d1);
  }
  /** model put floor for covered trading time tau1 -> tau2 (years): 1.15 * N * [P(tau2) - P(tau1)] */
  function floorCharge(N, S, K, sigAnn, tau1, tau2) { return C.floor_mult * N * Math.max(0, bsPut(S, K, sigAnn, tau2) - bsPut(S, K, sigAnn, tau1)); }

  /**
   * o: price, shares, lockIn (K), sigma1 | volatility, float, adv, news, inCompletedDayBlock,
   *    lock: { price, sigma1, news }  (v4 rate lock; omitted = "if locked now"),
   *    day: taper day n (default 1), tau: covered trading time so far, years (default 0),
   *    minuteYears: trading-time length of one billed minute (default 1/(252*390)).
   * Returns the per-minute rate for the next minute plus all terms.
   */
  function insuranceRateBreakdown(o) {
    var lk = o.lock || null;
    var Snow = +o.price, N = +o.shares, K = +(o.lockIn || o.price);
    // sigma_1 is intraday (session) per-minute vol. From an annual close-to-close vol (IV or realized) it is
    // vol * sqrt(w_session / (252*390)): the session carries ~75% of daily variance, the night gap the rest.
    function s1of(src) { return src.sigma1 != null ? +src.sigma1 : (src.volatility != null ? +src.volatility * Math.sqrt(C.w_session / C.MIN_PER_YEAR) : null); }
    var sigma1Now = s1of(o); if (sigma1Now == null) sigma1Now = 0.2 * Math.sqrt(C.w_session / C.MIN_PER_YEAR);
    var S = lk ? Math.max(+lk.price, K) : Snow;
    var sigma1 = lk && s1of(lk) != null ? s1of(lk) : sigma1Now;
    var F = +o.float || C.F_ref, ADV = +o.adv || 1e7;
    var H = clamp(lk && lk.news != null ? +lk.news : (+o.news || 0), 0, 1);
    var D = o.inCompletedDayBlock ? C.D_full_day : 1;
    var n = Math.max(1, Math.floor(o.day || 1)), f = taper(n);
    var tau = Math.max(0, +o.tau || 0), dt = +o.minuteYears || 1 / C.MIN_PER_YEAR;
    if (!(S > 0) || !(N > 0)) {
      return { rate: 0, raw: 0, preDiscount: 0, baseRaw: 0, base: 0, floor: 0, E: 0, L: 1, H: H, D: D, G: 0, z: 0, sigma1: sigma1, sigma_h: 0, newsFactor: 1 + C.beta * H, clampedTo: null, day: n, taper: f, locked: !!lk, S_rate: S, constants: C };
    }
    var sigma_h = sigma1 * Math.sqrt(C.h);
    var z = (S - K) / (S * sigma_h), Gz = G(z);
    var E = N * S * sigma_h * Gz;
    var Lfloat = Math.max(1, Math.pow(C.F_ref / F, C.alpha)), Lsize = 1 + C.gamma * N / ADV, L = Lfloat * Lsize;
    var newsFactor = 1 + C.beta * H;
    var baseRaw = C.c * E * L * newsFactor;          // v3 raw rate (day 1)
    var base = baseRaw * f;                           // tapered
    var sigAnn = sigma1 * Math.sqrt(C.MIN_PER_YEAR / C.w_session); // close-to-close annual vol for the floor
    var floor = floorCharge(N, S, K, sigAnn, tau, tau + dt); // $ for the next minute
    var pre = Math.min(C.R_max, Math.max(C.R_min, base * D, floor));
    var src = pre >= C.R_max && Math.max(base * D, floor) > C.R_max ? 'cap' : floor > base * D && floor >= C.R_min ? 'putfloor' : base * D < C.R_min ? 'opsmin' : null;
    return {
      rate: pre, raw: baseRaw, baseRaw: baseRaw, base: base, preDiscount: Math.min(C.R_max, Math.max(C.R_min, base, floor)), floor: floor,
      clampedTo: src, day: n, taper: f, tau: tau, locked: !!lk, S_rate: S, sigAnn: sigAnn,
      E: E, G: Gz, z: z, sigma1: sigma1, sigma_h: sigma_h, L: L, Lfloat: Lfloat, Lsize: Lsize,
      H: H, newsFactor: newsFactor, D: D, constants: C
    };
  }

  /**
   * Charge for covered trading time tau1 -> tau2 (years), billed as `minutes` minutes on taper day `day`:
   * min(R_max * minutes, max(R_min * minutes, base * D * minutes, 1.15 N [P(tau2) - P(tau1)])).
   * Returns { charge, base, floor, floorBinds, capBinds } (base = discountable part).
   */
  function chargeForInterval(o, tau1, tau2, minutes, D) {
    D = D == null ? 1 : D;
    var b = insuranceRateBreakdown(Object.assign({}, o, { tau: tau1 }));
    var sigAnn = b.sigAnn || 0, N = +o.shares, K = +(o.lockIn || o.price);
    var baseC = b.base * minutes * D;
    var fl = N > 0 ? floorCharge(N, b.S_rate, K, sigAnn, tau1, tau2) : 0;
    var raw = Math.max(C.R_min * minutes, baseC, fl), cap = C.R_max * minutes;
    return { charge: Math.min(cap, raw), base: baseC, floor: fl, floorBinds: fl > baseC, capBinds: raw > cap, b: b };
  }

  /**
   * Charge for taper day n of a lock, at trading-day granularity (used by Projections, the confidence book and
   * the put comparison). sessMin = covered session minutes that day (390 = full session); nightBase = the
   * untapered v3 overnight lump for that night (0 = no overnight coverage); D = full-day discount on the base part.
   * Floor clock: covered variance per day w = w_session * sessMin/390 + w_night * [night covered]; the floor for day n is
   * 1.15 N [P(n w / 252) - P((n-1) w / 252)], so the cumulative floor through day n is 1.15 N P(n w / 252).
   */
  function dayCharge(o, n, sessMin, nightBase, D, opt) {
    D = D == null ? 1 : D; nightBase = nightBase || 0; opt = opt || {};
    var b = insuranceRateBreakdown(Object.assign({}, o, { day: n, tau: 0 }));
    var N = +o.shares, K = +(o.lockIn || o.price);
    // covered variance time for this day, in years: an average 24/7 day = 1/252; opt.wYears overrides (e.g. calendar
    // time cal_days/365 when matching a dated put across a weekend)
    var wY = opt.wYears != null ? opt.wYears : (C.w_session * sessMin / 390 + (nightBase > 0 ? C.w_night : 0)) / 252;
    var t1 = opt.tauStart != null ? opt.tauStart : (n - 1) * wY;
    var fl = N > 0 && wY > 0 ? floorCharge(N, b.S_rate, K, b.sigAnn || 0, t1, t1 + wY) : 0;
    var base = D * b.taper * (b.baseRaw * sessMin + nightBase);
    var raw = Math.max(C.R_min * sessMin, base, fl), cap = C.R_max * sessMin + (nightBase > 0 ? C.night_cap : 0);
    return { charge: Math.min(cap, raw), base: base, floor: fl, floorBinds: fl > base, capBinds: raw > cap, taper: b.taper, w: wY, tauEnd: t1 + wY, b: b };
  }

  /**
   * v4 overnight lump for a 24/7 lock (replaces v3's stand-alone gap ES for nights that follow a covered session):
   * the incremental expected shortfall of adding the gap to the session, so session + night = one day's ES, not
   * sqrt(.75)+sqrt(.25) = 1.37 of it.  night = 1.12 * L * (1+3H) * N * S * [sd G(zd) - ss G(zs)],
   * ss = sigma sqrt(w_session/252), sd = sigma sqrt((w_session + w_night*m)/252); m = 1.25 for a weekend/holiday gap
   * (v3's 1.118^2), or (1 + IM/sigma_gap)^2-style event uplift via m. Taper and D apply on top (see dayCharge).
   */
  function nightLump(o, varMult) {
    var b = insuranceRateBreakdown(o); if (!(b.E > 0)) return 0;
    var S = b.S_rate, K = +(o.lockIn || o.price), N = +o.shares, sig = b.sigAnn;
    var ss = sig * Math.sqrt(C.w_session / 252), sd = sig * Math.sqrt((C.w_session + C.w_night * (varMult || 1)) / 252);
    var es = function (sg) { return sg * G((S - K) / (S * sg)); };
    return 1.12 * b.L * b.newsFactor * N * S * Math.max(0, es(sd) - es(ss));
  }

  /** Per-person cap: shares coverable for K given the person's other insured value (K x shares). */
  function capShares(K, held, otherInsuredValue) {
    var room = Math.max(0, Math.min(C.CAP_PER_STOCK, C.CAP_TOTAL - (otherInsuredValue || 0)));
    return Math.max(0, Math.min(held, Math.floor(room / K + 1e-9)));
  }

  /** $/min. The one swappable entry point used by the app. */
  function insuranceRatePerMinute(opts) { return insuranceRateBreakdown(opts).rate; }

  g.insuranceRatePerMinute = insuranceRatePerMinute;
  g.insuranceRateBreakdown = insuranceRateBreakdown;
  g.paracordChargeForInterval = chargeForInterval;
  g.paracordTaper = taper;
  g.paracordDayCharge = dayCharge;
  g.paracordNightLump = nightLump;
  g.paracordBsPut = bsPut;
  g.paracordCapShares = capShares;
  g.PARACORD_RATE_CONSTANTS = C;
  g.PARACORD_RATE_META = { placeholder: true, source: 'paracord-pricing-v4.md (draft v4)' };
  if (typeof module !== 'undefined') module.exports = { insuranceRatePerMinute: insuranceRatePerMinute, insuranceRateBreakdown: insuranceRateBreakdown, chargeForInterval: chargeForInterval, dayCharge: dayCharge, nightLump: nightLump, taper: taper, bsPut: bsPut, floorCharge: floorCharge, capShares: capShares, G: G, Phi: Phi, C: C };
})(typeof window !== 'undefined' ? window : globalThis);
