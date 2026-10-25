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
 * Full-day pricing (2026-10-25): sigma_1 = vol / sqrt(252*390) (session priced on a full day's variance, as in v3) and
 * the overnight lump is the stand-alone v3 gap ES on a full day's variance. The 1.15x put floor is a minimum only.
 * v4 changes:
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
 *  p9 (Stage 0, 2026-10-25):
 *  4. Lock vol = max(recent realized vol, options-implied vol) per name (lockVol). The SAME vol sets the locked base rate
 *     (sigma_1) and the 1.15x put floor, so the floor tracks the listed put even in calm weeks (p8 locked at realized vol
 *     only and fell to ~0.2x the put in flat weeks). Implied vol carries an earnings bump when a known earnings date
 *     falls inside the lock window: iv^2 = iv_base^2 + m^2 * 365 / window_days (m = 1-day event move, estimate).
 *  5. Firm-wide $ limits replace the 1%-of-float pool: per name min(10% of the firm limit, 10% of daily $ volume),
 *     per sector 25% of the firm limit, and a firm total (demo values). Surge is set by book-wide stress
 *     (firm / sector utilisation + an index-stress signal), so a crash raises prices on all names together.
 *  p13 preview (branch earnings1, 2026-10-25): earnings jump term. A lock window that contains a known earnings report
 *     gets the report's one-off jump variance J^2 added at the report time (the overnight gap for an after-close or
 *     before-open report), in BOTH the base (night lump / event lump) and the put floor (the comparable put's variance is
 *     sigma^2 tau + J^2). J = implied earnings move (expected |move|, ~ straddle / price) x sqrt(pi/2); fallback
 *     J = 3 x the normal daily move. The one-day slice of the p9 smeared bump already inside sigma_lock is netted off
 *     so short locks do not pay the event twice. Approved follow-up: a lock that gets the event charge locks at the
 *     ex-earnings vol (lockVol opt.exEvent), so the smear is removed for the whole lock and nothing is netted. Lock vol, taper, rate lock, floor multiple, caps, limits: unchanged.
 *  Per-person caps (config): $5,000 insured value per stock and $25,000 total, insured value = K x shares,
 *  per verified person (identity/KYC), not per brokerage account.
 */
(function (g) {
  var C = {
    version: 4, build: 'p13-earnings1',
    h: 390,            // look-ahead horizon, minutes
    c: 0.0029,         // per min: ~1.12 x (1/390), fair rate + 12% load
    beta: 3,           // full-severity news ~quadruples the rate (at lock)
    F_ref: 1e9, alpha: 0.1, gamma: 10,
    R_min: 0.002,      // $/min operational minimum (v3's $0.02 flat floor is replaced by the put floor)
    R_max: 6.00,       // $/min cap on the base (before surge)
    D_full_day: 0.90,  // 10% off the base part for a completed 24h block
    taper_min: 0.05,   // f(n) never below 0.05 (reached at n ~ 100 trading days)
    floor_mult: 1.15,  // minimum only: cumulative charge never below 1.15 x the matching put value (not a target)
    // Full-day pricing (chosen 2026-10-25, as in v3): the session and the overnight gap are EACH priced on a full
    // trading day of variance. w_* are the pricing weights (sigma_1 and the night lump); var_* are the physical split
    // used only for the put-floor clock and expected-loss estimates, so the floor matches the comparable listed put.
    w_session: 1,      // pricing: session priced on a full day's variance (v4 draft had 0.75)
    w_night: 1,        // pricing: overnight gap priced on a full day's variance, stand-alone (v4 draft had 0.25, incremental)
    var_session: 0.75, // physical share of close-to-close variance in the 6.5h session (floor clock / loss model)
    var_night: 0.25,   // physical share in the overnight gap; 24/7 coverage = 1.00 trading day of variance per day
    night_cap: 6.00 * 60 * 17.5, // overnight lump cap before surge ($360/h x 17.5h, v3 sec. 6)
    MIN_PER_YEAR: 252 * 390,
    CAP_PER_STOCK: 5000,   // $ insured value (K x shares) per person per stock
    CAP_TOTAL: 25000,      // $ insured value per person across all stocks
    MEMBERSHIP_FEE: 199,   // $/yr Yearly plan (kept for older callers; = MEMBERSHIP_YEARLY)
    // p12 membership plans: Monthly $29.99/mo or Yearly $199/yr. Non-refundable for the current billing period,
    // auto-renew each period unless cancelled; cancelling takes effect at the end of the current period.
    MEMBERSHIP_MONTHLY: 29.99, // $/month, billed each month
    MEMBERSHIP_YEARLY: 199,    // $/year, billed up front
    MEMBER_MIX_YEARLY: 0.70,   // DEMO ASSUMPTION: share of members picking Yearly (rest Monthly)
    MEMBER_CHURN_MONTHLY: 0.08,// DEMO ASSUMPTION: share of Monthly members cancelling each month
    MONTH_TRADING_DAYS: 21,    // sim month for the crowd book = 21 trading days x 390 sim-min
    // p9 lock vol
    LOCK_WINDOW_DAYS: 28,  // look-ahead window for the earnings check when a lock has no fixed end (calendar days; 28 = 4 weeks = the 1-month listed put the floor is benchmarked against)
    // p9 firm-wide limits on insured value (K x shares, $). DEMO values, illustrative only.
    FIRM_LIMIT: 750e6,     // total insured value the firm will carry
    SECTOR_SHARE: 0.25,    // max share of the firm limit in one GICS sector
    NAME_SHARE: 0.10,      // max share of the firm limit in one name ...
    NAME_ADDV: 0.10,       // ... and at most 10% of the name's average daily $ volume
    NEAR_CAP: 0.90, HARD_STOP: 1.25, NEAR_CAP_MAX_ORDER: 0.005, // v3 queue bands, now in $ of the effective limit
    STRESS_PER_SIGMA: 0.08, // book stress added per 1 sigma of index drop
    // p13 preview: earnings jump term (DEMO). Expected |move| -> jump sd: x sqrt(pi/2) (normal: E|X| = sd sqrt(2/pi)).
    EARN_ABS_TO_SD: Math.sqrt(Math.PI / 2),
    EARN_FALLBACK_DAILY_MULT: 3,  // no implied move on file: jump sd = 3 x normal daily sd (sigma_lock / sqrt(252))
    EARN_LOAD_MULT: 1.5,          // RECOMMENDATION (DEMO, Jake to confirm): the event lump carries 1.5x the normal 1.12 load (fat tails; the gap can't be hedged)
    // DEMO ASSUMPTION implied earnings moves (expected |1-day move|). AMZN Oct 29 2026: mean of two quotes as of Oct 23 2026
    // (+-7.7% earnings-watcher.com, +-6.68% unusualwhales.com). Other names use the fallback until a feed is wired.
    EARN_IMPLIED_MOVE: { AMZN: 0.072 }
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
  /** Black-Scholes put per share from total log variance V (r = 0) */
  function bsPutVar(S, K, V) { return V > 0 ? bsPut(S, K, Math.sqrt(V), 1) : Math.max(K - S, 0); }
  /**
   * model put floor for covered trading time tau1 -> tau2 (years): 1.15 * N * [P(V(tau2)) - P(V(tau1))],
   * V(tau) = sigAnn^2 tau (+ ev.v once tau >= ev.tau: an earnings jump at covered time ev.tau, p13 preview).
   * Without ev this is exactly the v4 floor.
   */
  function floorCharge(N, S, K, sigAnn, tau1, tau2, ev) {
    if (!ev || !(ev.v > 0)) return C.floor_mult * N * Math.max(0, bsPut(S, K, sigAnn, tau2) - bsPut(S, K, sigAnn, tau1));
    var V = function (t) { return sigAnn * sigAnn * t + (t >= ev.tau ? ev.v : 0); };
    return C.floor_mult * N * Math.max(0, bsPutVar(S, K, V(tau2)) - bsPutVar(S, K, V(tau1)));
  }

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
    // vol * sqrt(w_session / (252*390)); full-day pricing (w_session = 1) prices the session on a full day's variance.
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
  function chargeForInterval(o, tau1, tau2, minutes, D, ev) {
    D = D == null ? 1 : D;
    var b = insuranceRateBreakdown(Object.assign({}, o, { tau: tau1 }));
    var sigAnn = b.sigAnn || 0, N = +o.shares, K = +(o.lockIn || o.price);
    var baseC = b.base * minutes * D;
    // p13 preview: the interval that holds the earnings report adds the one-off event lump (NOT tapered, NOT discounted:
    // a report is a fresh risk however long the lock has run). It gets its own lump cap (night_cap), like the night lump.
    var hit = ev && ev.v > 0 && tau1 < ev.tau && tau2 >= ev.tau, evC = hit ? eventLump(o, ev.v) : 0;
    baseC += evC;
    var fl = N > 0 ? floorCharge(N, b.S_rate, K, sigAnn, tau1, tau2, ev) : 0;
    var raw = Math.max(C.R_min * minutes, baseC, fl), cap = C.R_max * minutes + (hit ? C.night_cap : 0);
    return { charge: Math.min(cap, raw), base: baseC, floor: fl, floorBinds: fl > baseC, capBinds: raw > cap, b: b };
  }

  /**
   * Charge for taper day n of a lock, at trading-day granularity (used by Projections, the confidence book and
   * the put comparison). sessMin = covered session minutes that day (390 = full session); nightBase = the
   * untapered v3 overnight lump for that night (0 = no overnight coverage); D = full-day discount on the base part.
   * Floor clock (physical split): w = var_session * sessMin/390 + var_night * [night covered]; the floor for day n is
   * 1.15 N [P(n w / 252) - P((n-1) w / 252)], so the cumulative floor through day n is 1.15 N P(n w / 252).
   */
  function dayCharge(o, n, sessMin, nightBase, D, opt) {
    D = D == null ? 1 : D; nightBase = nightBase || 0; opt = opt || {};
    var b = insuranceRateBreakdown(Object.assign({}, o, { day: n, tau: 0 }));
    var N = +o.shares, K = +(o.lockIn || o.price);
    // covered variance time for this day, in years: an average 24/7 day = 1/252; opt.wYears overrides (e.g. calendar
    // time cal_days/365 when matching a dated put across a weekend)
    var wY = opt.wYears != null ? opt.wYears : (C.var_session * sessMin / 390 + (nightBase > 0 ? C.var_night : 0)) / 252;
    var t1 = opt.tauStart != null ? opt.tauStart : (n - 1) * wY;
    // p13 preview: opt.jumpVar = earnings jump variance of a report that falls in this day's covered window (charged
    // once, as the untapered event lump, whether the night or only the next session is covered); opt.ev = {tau, v} places
    // a report on the floor clock (default: end of this day) so the cumulative floor tracks a put that spans the report.
    var ev = opt.ev || (opt.jumpVar > 0 ? { tau: t1 + wY, v: opt.jumpVar } : null);
    var fl = N > 0 && wY > 0 ? floorCharge(N, b.S_rate, K, b.sigAnn || 0, t1, t1 + wY, ev) : 0;
    var evLump = opt.jumpVar > 0 ? eventLump(o, opt.jumpVar) : 0;
    var base = D * b.taper * (b.baseRaw * sessMin + nightBase) + evLump; // event lump: not tapered, not discounted
    var raw = Math.max(C.R_min * sessMin, base, fl), cap = C.R_max * sessMin + (nightBase > 0 ? C.night_cap : 0) + (evLump > 0 ? C.night_cap : 0);
    return { charge: Math.min(cap, raw), base: base, floor: fl, floorBinds: fl > base, capBinds: raw > cap, taper: b.taper, w: wY, tauEnd: t1 + wY, eventLump: evLump, b: b };
  }

  /**
   * Full-day pricing (w_night = 1, default): stand-alone v3 gap ES, night = 1.12 * L * (1+3H) * N * S * sg G(zg),
   * sg = sigma sqrt(w_night * m / 252). Otherwise (w_night < 1, v4 draft):
   * v4 overnight lump for a 24/7 lock (replaces v3's stand-alone gap ES for nights that follow a covered session):
   * the incremental expected shortfall of adding the gap to the session, so session + night = one day's ES, not
   * sqrt(.75)+sqrt(.25) = 1.37 of it.  night = 1.12 * L * (1+3H) * N * S * [sd G(zd) - ss G(zs)],
   * ss = sigma sqrt(w_session/252), sd = sigma sqrt((w_session + w_night*m)/252); m = 1.25 for a weekend/holiday gap
   * (v3's 1.118^2), or (1 + IM/sigma_gap)^2-style event uplift via m. Taper and D apply on top (see dayCharge).
   */
  function nightLump(o, varMult, jumpVar) {
    if (jumpVar > 0) return nightLump(o, varMult) + eventLump(o, jumpVar); // p13 preview: earnings night
    var b = insuranceRateBreakdown(o); if (!(b.E > 0)) return 0;
    var S = b.S_rate, K = +(o.lockIn || o.price), N = +o.shares, sig = b.sigAnn;
    var es = function (sg) { return sg * G((S - K) / (S * sg)); };
    if (C.w_night >= 1) return 1.12 * b.L * b.newsFactor * N * S * es(sig * Math.sqrt(C.w_night * (varMult || 1) / 252));
    var ss = sig * Math.sqrt(C.w_session / 252), sd = sig * Math.sqrt((C.w_session + C.w_night * (varMult || 1)) / 252);
    return 1.12 * b.L * b.newsFactor * N * S * Math.max(0, es(sd) - es(ss));
  }

  /**
   * p13 preview: untapered one-off earnings event lump = the extra expected shortfall from adding the jump variance J^2 to
   * a normal (full-day-priced) gap: 1.12 * EARN_LOAD_MULT (1.5) * L * (1+3H) * N * S * [sj G(zj) - sg G(zg)], sg = sigma sqrt(w_night/252),
   * sj = sqrt(sg^2 + J^2). Same liquidity and news factors as the night lump; load 1.5x. nightLump(o, m) + eventLump(o, J^2) =
   * the stand-alone gap ES of an earnings night.
   */
  function eventLump(o, jumpVar) {
    if (!(jumpVar > 0)) return 0;
    var b = insuranceRateBreakdown(o); if (!(b.E > 0)) return 0;
    var S = b.S_rate, K = +(o.lockIn || o.price), N = +o.shares;
    var es = function (sg) { return sg * G((S - K) / (S * sg)); };
    var sg = b.sigAnn * Math.sqrt(C.w_night / 252), sj = Math.sqrt(sg * sg + jumpVar);
    return 1.12 * C.EARN_LOAD_MULT * b.L * b.newsFactor * N * S * Math.max(0, es(sj) - es(sg));
  }

  /**
   * p13 preview: earnings jump for a lock. def = universe record, lv = lockVol(...) result.
   * J (jump sd) = implied earnings move (expected |move|) x sqrt(pi/2); source order: C.EARN_IMPLIED_MOVE[t],
   * def.earn_implied, def.earn_hist (historical average |move|), else fallback J = 3 x sigma_lock / sqrt(252).
   * smear = the one-day slice of the p9 earnings bump already inside sigma_lock ((used^2 - used_ex^2) / 252), netted off.
   * Returns { J, J2, v (= J^2 - smear, what is added), smear, src, at (report instant, ms), absMove }.
   */
  function earningsJump(def, lv) {
    var t = def.t, m = C.EARN_IMPLIED_MOVE[t] != null ? C.EARN_IMPLIED_MOVE[t] : (def.earn_implied != null ? +def.earn_implied : (def.earn_hist != null ? +def.earn_hist : null));
    var used = lv ? lv.used : (+def.iv || 0.3), src = m != null ? (C.EARN_IMPLIED_MOVE[t] != null || def.earn_implied != null ? 'implied' : 'historical') : 'fallback';
    var J = m != null ? m * C.EARN_ABS_TO_SD : C.EARN_FALLBACK_DAILY_MULT * used / Math.sqrt(252);
    var usedEx = lv ? Math.max(lv.rv || 0, lv.ivBase || 0) : used;
    var smear = lv && lv.earnInside ? Math.max(0, used * used - usedEx * usedEx) / 252 : 0;
    var at = def.earn ? Date.parse(def.earn + (def.earn_timing === 'BMO' ? 'T12:00:00Z' : 'T21:00:00Z')) : null;
    return { J: J, J2: J * J, v: Math.max(0, J * J - smear), smear: smear, src: src, at: at, absMove: m != null ? m : J / C.EARN_ABS_TO_SD, date: def.earn || null, timing: def.earn_timing || null };
  }

  /** Per-person cap: shares coverable for K given the person's other insured value (K x shares). */
  function capShares(K, held, otherInsuredValue) {
    var room = Math.max(0, Math.min(C.CAP_PER_STOCK, C.CAP_TOTAL - (otherInsuredValue || 0)));
    return Math.max(0, Math.min(held, Math.floor(room / K + 1e-9)));
  }


  /* ---------------- p9: lock vol = max(recent realized, options-implied) ---------------- */
  /**
   * def: universe record { rv (recent realized, annual; default rv20), iv, iv_base, iv_win, earn (YYYY-MM-DD|null), earn_move }
   * opt: { at: ms (lock time; default now), days: lock window in calendar days (default LOCK_WINDOW_DAYS), rv: override }
   * Returns { used, rv, iv (incl. earnings bump), ivBase, earnInside, earnDate, bumpPts, source: 'implied'|'realized' }.
   */
  function lockVol(def, opt) {
    opt = opt || {};
    var rv = opt.rv != null ? +opt.rv : (def.rv != null ? +def.rv : +def.rv20 || 0);
    var ivBase = def.iv_base != null ? +def.iv_base : +def.iv || 0, mv = +def.earn_move || 0;
    var days = opt.days != null ? +opt.days : C.LOCK_WINDOW_DAYS, at = opt.at != null ? +opt.at : Date.now();
    var inside = false, ed = null;
    if (def.earn) {
      ed = Date.parse(def.earn + 'T21:00:00Z');                   // report day (US close, UTC)
      var dd = (ed - at) / 86400000; inside = dd > -0.5 && dd <= days;
    }
    var iv = Math.sqrt(ivBase * ivBase + (inside && days > 0 ? mv * mv * 365 / days : 0));
    var used = Math.max(rv, iv);
    // p13 preview (approved 2026-10-25): opt.exEvent = this lock gets the one-time earnings charge (a known report still
    // ahead, inside the window). Its locked vol then drops the smeared earnings bump for the WHOLE lock: used =
    // max(realized, implied ex-earnings), and the report is priced only by the event term. No report in the window (or
    // exEvent not set): unchanged, used = max(realized, implied incl. bump) exactly as on main.
    var evAt = def.earn ? Date.parse(def.earn + (def.earn_timing === 'BMO' ? 'T12:00:00Z' : 'T21:00:00Z')) : null;
    var exEvent = !!(opt.exEvent && inside && evAt > at), usedBump = used;
    if (exEvent) used = Math.max(rv, ivBase);
    return { used: used, rv: rv, iv: exEvent ? ivBase : iv, ivBase: ivBase, earnInside: inside, earnDate: def.earn || null, bumpPts: exEvent ? 0 : iv - ivBase,
      source: (exEvent ? ivBase : iv) >= rv ? 'implied' : 'realized', ivSrc: def.iv_src || null, days: days,
      exEvent: exEvent, usedWithBump: usedBump, ivWithBump: iv };
  }

  /* ---------------- p9: firm-wide limits and book-stress surge ---------------- */
  function nameLimit(def) { var a = +def.addv || (+def.adv_sh || 0) * (+def.px || 0); return Math.min(C.NAME_SHARE * C.FIRM_LIMIT, a > 0 ? C.NAME_ADDV * a : C.NAME_SHARE * C.FIRM_LIMIT); }
  function sectorLimit() { return C.SECTOR_SHARE * C.FIRM_LIMIT; }
  /** Book-wide stress: max(firm utilisation, worst sector utilisation) + STRESS_PER_SIGMA x index drop in sigma. */
  function bookStress(firmUtil, sectorUtilMax, mktSigma) { return Math.max(firmUtil || 0, sectorUtilMax || 0) + C.STRESS_PER_SIGMA * Math.max(0, -(mktSigma || 0)); }
  /** Surge multiplier from book stress s: 1.0 below 0.90; 1 -> 2 between 0.90 and 1.00; 2 + (s - 1)/0.25 up to 3.0 at 1.25. */
  function surgeMultiplier(s) { s = +s || 0; if (s < C.NEAR_CAP) return 1; if (s < 1) return 1 + (s - C.NEAR_CAP) / (1 - C.NEAR_CAP); return 2 + (Math.min(s, C.HARD_STOP) - 1) / (C.HARD_STOP - 1); }
  /**
   * Allocate firm limits across names. items: [{ key, sector, demand ($ requested), cap (name limit $) }].
   * Sector and firm limits are shared pro rata when demand exceeds them. Returns { lim: {key: effective $ limit},
   * firmUtil, sectorUtil: {sector: util}, sectorUtilMax } where utilisation = demand (up to 1.25x each name cap) / limit.
   */
  function allocate(items) {
    var sec = {}, tot = 0, SL = sectorLimit();
    items.forEach(function (it) { var d = Math.min(it.demand, C.HARD_STOP * it.cap); it._d = d; sec[it.sector] = (sec[it.sector] || 0) + d; tot += d; });
    var sUtil = {}, sMax = 0, secAllowed = 0;
    Object.keys(sec).forEach(function (k) { sUtil[k] = sec[k] / SL; sMax = Math.max(sMax, sUtil[k]); secAllowed += Math.min(sec[k], SL); });
    var firmScale = secAllowed > C.FIRM_LIMIT ? C.FIRM_LIMIT / secAllowed : 1, lim = {};
    items.forEach(function (it) {
      var ss = sec[it.sector] > SL ? SL / sec[it.sector] : 1;
      var bind = ss * firmScale < 1;
      // binding sector/firm limit: the name gets its pro-rata share of the shared limit; otherwise its own cap
      lim[it.key] = bind ? Math.min(it.cap, it._d * ss * firmScale) : it.cap;
    });
    return { lim: lim, firmUtil: tot / C.FIRM_LIMIT, sectorUtil: sUtil, sectorUtilMax: sMax };
  }
  /**
   * Closed-form FIFO fill of U identical orders of `o` dollars (K x shares) into an effective limit Lim ($), v3 bands:
   * open (u < 0.90): fill if it fits; near cap (0.90-1.00): only orders <= 0.5% of the limit; over: surgePct pay surge
   * (no surge fill above 1.25 x limit), the rest wait. M = max(2, M(stress)) for over-capacity orders; normal fills pay
   * M(stress) (1.0 unless the book is stressed). Returns counts plus sumMm1 = total (M - 1) over filled orders.
   */
  function fillBook(U, o, Lim, surgePct, stress) {
    U = Math.max(0, Math.round(U)); var r = { normal: 0, surge: 0, wait: 0, waitHard: 0, sumMm1: 0, Mnorm: surgeMultiplier(stress), Msurge: Math.max(2, surgeMultiplier(stress)), Lim: Lim };
    if (!(o > 0) || !U) { r.Qn = r.Qs = 0; r.u = 0; r.Mmin = r.Mmax = 0; return r; }
    if (!(Lim > 0)) { r.wait = r.waitHard = U; r.Qn = r.Qs = 0; r.u = 0; r.Mmin = r.Mmax = 0; return r; }
    var k1 = Math.min(U, Math.max(0, Math.ceil(C.NEAR_CAP * Lim / o)));             // orders filled while u < 0.90
    if (k1 * o > Lim) k1 = Math.floor(Lim / o);
    var used = k1 * o, k2 = 0;
    if (o <= C.NEAR_CAP_MAX_ORDER * Lim) k2 = Math.min(U - k1, Math.max(0, Math.floor((Lim - used) / o)));
    used += k2 * o; r.normal = k1 + k2;
    var rest = U - r.normal, want = Math.floor(rest * surgePct + 1e-9), room = Math.max(0, Math.floor((C.HARD_STOP * Lim - used) / o));
    r.surge = Math.min(want, room); r.wait = rest - r.surge; r.waitHard = Math.max(0, want - r.surge);
    r.Qn = r.normal * o; r.Qs = r.surge * o; r.u = (r.Qn + r.Qs) / Lim;
    r.sumMm1 = r.normal * (r.Mnorm - 1) + r.surge * (r.Msurge - 1);
    r.Mmin = r.surge ? r.Msurge : 0; r.Mmax = r.Mmin;
    return r;
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
  g.paracordLockVol = lockVol;
  g.paracordEarningsJump = earningsJump;
  g.paracordEventLump = eventLump;
  g.paracordBsPutVar = bsPutVar;
  g.paracordLimits = { nameLimit: nameLimit, sectorLimit: sectorLimit, allocate: allocate, fillBook: fillBook, bookStress: bookStress, surgeMultiplier: surgeMultiplier };
  g.PARACORD_RATE_CONSTANTS = C;
  g.PARACORD_RATE_META = { placeholder: true, source: 'paracord-pricing-v4.md (draft v4) + p9 lock vol / firm limits' };
  if (typeof module !== 'undefined') module.exports = { insuranceRatePerMinute: insuranceRatePerMinute, insuranceRateBreakdown: insuranceRateBreakdown, chargeForInterval: chargeForInterval, dayCharge: dayCharge, nightLump: nightLump, taper: taper, bsPut: bsPut, floorCharge: floorCharge, capShares: capShares, G: G, Phi: Phi, C: C, lockVol: lockVol, earningsJump: earningsJump, eventLump: eventLump, bsPutVar: bsPutVar, nameLimit: nameLimit, sectorLimit: sectorLimit, allocate: allocate, fillBook: fillBook, bookStress: bookStress, surgeMultiplier: surgeMultiplier };
})(typeof window !== 'undefined' ? window : globalThis);
