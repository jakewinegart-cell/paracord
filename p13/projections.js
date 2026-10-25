/* Paracord — Projections playground (DEMO). Implements the queue / surge / overnight model of
 * /workspace/paracord-pricing-v3.md, repriced per paracord-pricing-v4.md, with the p9 changes: lock vol = max(recent
 * realized, options-implied incl. earnings bump) and firm-wide $ limits (per name / sector / firm) with book-stress
 * surge in place of the 1%-of-float pool. Stock inputs: demo snapshot, as of Oct 23, 2026 (data/universe.js).
 * Reuses rate.js (insuranceRateBreakdown) for the daytime base rate. Nothing here is live data. */
(function (g) {
  'use strict';
  var STOCKS = g.PC_STOCKS, BY_T = {};
  STOCKS.forEach(function (s) { BY_T[s.t] = s; });
  var C = g.PARACORD_RATE_CONSTANTS;
  var KEY = 'p13:paracord-proj-v1'; // p13 preview: namespaced (same origin as p12 root)
  var MIN_PER_YEAR = 252 * 390;
  var COVERAGE_OPTS = [0.25, 0.5, 0.75, 1];   // p3 coverage-length toggle: fraction of the trading-session window held
  var LIM = g.paracordLimits;
  var AS_OF = Date.parse(((g.PC_UNIVERSE || {}).as_of || '2026-10-23') + 'T20:00:00Z'); // snapshot close: lock time for projections
  var P = {              // v3 constants (EXAMPLE values from the md); capacity is now rate.js firm limits
    nearCap: 0.90, hardStop: 1.25, nearCapMaxOrder: 0.005,
    nightLoad: 1.12,     // 1.12 * E_night * L * (1 + 3H)
    Tc: 17.5,            // closed hours, normal weeknight
    nightCapPerHour: C.R_max * 60, // $360/hour before surge
    tailZ: 1.645,        // 1-in-20 one-sided
    reserveDrop: 0.20    // reserve target: payout on a 20% drop across surge shares
  };

  /** p9: surge multiplier from book-wide stress (rate.js) */
  function surgeMultiplier(s) { return LIM.surgeMultiplier(s); }
  function Gz(z) { var phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); return phi - z * (1 - Phi(z)); }
  function Phi(z) {
    var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  /** Expected shortfall below K for N shares when the log-move sd is sd: N*S*sd*G((S-K)/(S*sd)) */
  function shortfall(N, S, K, sd) { if (sd <= 0) return Math.max(0, K - S) * N; return N * S * sd * Gz((S - K) / (S * sd)); }

  /** Overnight lump premium per policy (md sec. 6 & 10.8, option (a)) */
  function nightPremium(o) {
    var sigmaGap = o.annVol / Math.sqrt(252);            // = IM / 0.798 on a normal night
    var E = shortfall(o.shares, o.price, o.lockIn, sigmaGap);
    var raw = P.nightLoad * E * o.L * (1 + 3 * o.news);
    var cap = P.nightCapPerHour * P.Tc;
    return { E: E, raw: raw, premium: Math.min(raw, cap), capped: raw > cap, sigmaGap: sigmaGap, IM: sigmaGap * 0.798, perHour: Math.min(raw, cap) / P.Tc };
  }

  /** p9: closed-form FIFO fill in $ (rate.js fillBook). U orders of n shares at K into an effective $ limit. */
  function fill(U, n, K, lim, surgePct, stress) { return LIM.fillBook(U, n * K, lim, surgePct, stress); }
  /** lock vol for a demo stock at the snapshot close: max(20-day realized, implied incl. earnings bump in the next 28 days) */
  function lockVolOf(d) { return g.paracordLockVol(d, { at: AS_OF, rv: d.vol20 }); }
  /** per-person capped shares for each stock (filled in display order for the $25k total) */
  function capped(ts, I) {
    var other = 0;
    return ts.map(function (t) { var d = BY_T[t], K = d.p0 * (1 - I.cushion / 100), n = g.paracordCapShares(K, I.shares, other); other += K * n; return { t: t, K: K, n: n, other: other - K * n }; });
  }
  /** firm limits across the projected stocks: effective $ limit per stock and book stress */
  function allocFor(cs, I) {
    var al = LIM.allocate(cs.map(function (c) { return { key: c.t, sector: BY_T[c.t].sector, demand: I.users * c.n * c.K, cap: LIM.nameLimit(BY_T[c.t]) }; }));
    al.stress = LIM.bookStress(al.firmUtil, al.sectorUtilMax, 0); al.M = LIM.surgeMultiplier(al.stress);
    return al;
  }

  /**
   * v4 (paracord-pricing-v4.md): rate locked at the moment users turn coverage on (S, sigma, H at lock), duration taper
   * f(n) on policy day n, put-value floor 1.15 x N x BS put for the covered variance, per-person caps on shares
   * ($5,000 per stock / $25,000 total, K x shares, per verified person), annual membership (non-refundable) as up-front cash.
   * `otherInsured` = insured value (K x shares) the same person already has in other stocks (for the $25k total cap).
   */
  function projectStock(t, I, otherInsured, al) {
    var d = BY_T[t], S = d.p0, nReq = I.shares, K = S * (1 - I.cushion / 100), H = I.news;
    var n = g.paracordCapShares(K, nReq, otherInsured || 0);  // per-person cap: covered shares per user
    var capWhy = n >= nReq ? null : (K * (nReq) > C.CAP_PER_STOCK && (otherInsured || 0) + C.CAP_PER_STOCK <= C.CAP_TOTAL ? 'per-stock' : 'total');
    var day = Math.max(1, Math.round(I.day || 1)), taper = g.paracordTaper(day);
    var lv = lockVolOf(d);                                  // p9: max(recent realized, implied) -> rate AND floor
    var lock = { price: S, volatility: lv.used, news: H };  // locked at the start of the policy
    var o = { price: S, shares: n, lockIn: K, volatility: lv.used, float: d.float, adv: d.adv, news: H, lock: lock };
    var b = g.insuranceRateBreakdown(Object.assign({}, o, { day: day }));
    var sigma1 = b.sigma1, sigAnn = b.sigAnn;
    var base = b.base;                                      // tapered per-minute base, no D, no floor
    if (!al) al = allocFor([{ t: t, K: K, n: n }], I);
    var lim = al.lim[t], nameLim = LIM.nameLimit(d);
    var f = fill(I.users, n, K, lim, I.surgePct / 100, al.stress);
    f.QsSh = K ? f.Qs / K : 0;
    var insured = f.normal + f.surge, insShares = K ? (f.Qn + f.Qs) / K : 0;
    var cov = COVERAGE_OPTS.indexOf(+I.coverage) >= 0 ? +I.coverage : 1;
    var mFull = I.hours * 60;
    var m = mFull * cov;                                    // covered (billed) session minutes per trading day
    var discEligible = I.overnight && I.hours >= 6.5 && cov >= 1; // unbroken 24h block needs full day + night coverage
    var dfac = discEligible ? 1 - (1 - C.D_full_day) * I.fullDay / 100 : 1;
    var nl = I.overnight ? g.paracordNightLump(o, 1) : 0;    // untapered night lump (full-day pricing: stand-alone gap ES on a full day's variance)
    // per-policy charges for policy day n (taper, floor, cap, D on the base part only)
    var cAll = g.paracordDayCharge(o, day, m, nl, dfac), cDay = g.paracordDayCharge(o, day, m, 0, dfac);
    var cAll1 = g.paracordDayCharge(o, day, m, nl, 1), cDay1 = g.paracordDayCharge(o, day, m, 0, 1);
    var perDay = cDay.charge, perNight = Math.max(0, cAll.charge - cDay.charge);
    var perDay1 = cDay1.charge, perNight1 = Math.max(0, cAll1.charge - cDay1.charge); // undiscounted (surge uplift base)
    // ---- day ----
    var dayBase = insured * perDay;
    var dayUplift = perDay1 * f.sumMm1;                     // surge uplift on the effective (tapered/floored) charge -> reserve
    var dayPrem = dayBase + dayUplift;
    // expected payouts for day n of a lock held since day 1: ES increment over the covered variance (news raises realized vol by (1+H))
    var wd = C.var_session * m / 390 / 252, wn = I.overnight ? C.var_night / 252 : 0, t0 = (day - 1) * (wd + wn), sl = sigAnn * (1 + H);
    function es(tau) { return tau > 0 ? shortfall(n, S, K, sl * Math.sqrt(tau)) : 0; }
    var lossPerPolicyDay = m > 0 ? es(t0 + wd) - es(t0) : 0;
    var dayLoss = insured * lossPerPolicyDay;
    // ---- night ----
    var sigmaGap = sigAnn * Math.sqrt(C.var_night / 252);
    var np = { E: nl / (P.nightLoad * b.L * (1 + 3 * H) || 1), raw: nl, premium: perNight, untapered: nl, sigmaGap: sigmaGap, IM: sigmaGap * 0.798, perHour: perNight / P.Tc, capped: cAll.capBinds };
    var nightBase = I.overnight ? insured * perNight : 0;
    var nightUplift = I.overnight ? perNight1 * f.sumMm1 : 0;
    var nightPrem = nightBase + nightUplift;
    var sdGapLoss = sigmaGap * (1 + H);
    var nightLoss = I.overnight ? insured * (es(t0 + wd + wn) - es(t0 + wd)) : 0;
    var tailPerShare = Math.max(0, K - S * (1 - P.tailZ * sdGapLoss));  // 95th-pct gap
    var tail = I.overnight ? insShares * tailPerShare : 0;
    var reserve = dayUplift + nightUplift;
    var reserveTarget = f.QsSh * Math.max(0, K - S * (1 - P.reserveDrop));
    var surgeTail = I.overnight ? f.QsSh * tailPerShare : 0;
    var reservePays = Math.min(reserve, surgeTail);
    var fee = +I.fee || C.MEMBERSHIP_FEE;
    return {
      t: t, S: S, K: K, n: n, nReq: nReq, capWhy: capWhy, insuredValue: K * n, day: day, taper: taper, sigma1: sigma1, b: b, base: base, lim: lim, nameLim: nameLim, al: al, lv: lv, f: f, insured: insured, insShares: insShares,
      m: m, mFull: mFull, cov: cov, dfac: dfac, discEligible: discEligible, perDay: perDay, perNight: perNight,
      floorDay: cDay.floor, floorBinds: cDay.floorBinds, capBinds: cDay.capBinds, baseDay: cDay.base,
      dayBase: dayBase, dayUplift: dayUplift, dayPrem: dayPrem, dayLoss: dayLoss, dayProfit: dayPrem - dayLoss, lossPerPolicyDay: lossPerPolicyDay,
      np: np, nightPrem: nightPrem, nightUplift: nightUplift, nightLoss: nightLoss, nightProfit: nightPrem - nightLoss,
      tail: tail, tailPerShare: tailPerShare, badNight: nightPrem - tail, reserve: reserve, reserveTarget: reserveTarget,
      surgeTail: surgeTail, reservePays: reservePays, capitalPays: tail - reservePays,
      profit: dayPrem - dayLoss + nightPrem - nightLoss,
      perShare: insShares ? (dayPrem - dayLoss + nightPrem - nightLoss) / insShares : 0, fee: fee
    };
  }

  /* p12 membership plans: Yearly $199 billed up front, Monthly $29.99 billed at the start of each month.
   * Plan mix and monthly churn are DEMO ASSUMPTIONS (defaults 70% Yearly / 30% Monthly, 8%/month).
   * Monthly: all monthly members pay month 1 at join; churn c applies after each month, so first-year months paid per
   * monthly member = sum_{k=0..11} (1 - c)^k = (1 - (1 - c)^12) / c. Non-refundable for the current period. */
  function membership(users, mixY, churn) {
    var feeY = C.MEMBERSHIP_YEARLY || 199, feeM = C.MEMBERSHIP_MONTHLY || 29.99;
    mixY = Math.min(1, Math.max(0, mixY)); churn = Math.min(0.99, Math.max(0, churn));
    var nY = users * mixY, nM = users * (1 - mixY);
    var months = churn > 0 ? (1 - Math.pow(1 - churn, 12)) / churn : 12;
    var upFront = nY * feeY, monthly = nM * feeM * months;
    return { feeY: feeY, feeM: feeM, mixY: mixY, churn: churn, nY: nY, nM: nM, months: months, upFront: upFront,
      monthly: monthly, firstYear: upFront + monthly, day1: upFront + nM * feeM, nM12: nM * Math.pow(1 - churn, 11),
      monthlyNoChurn: nM * feeM * 12, save: feeM * 12 - feeY, savePct: (feeM * 12 - feeY) / (feeM * 12) };
  }

  function project(I) {
    var ts = I.stock === 'ALL' ? STOCKS.map(function (s) { return s.t; }) : [I.stock];
    // per-person $25k total cap: stocks are filled in display order; firm limits are shared across the stocks projected
    var cs = capped(ts, I), al = allocFor(cs, I);
    var rows = cs.map(function (c) { return projectStock(c.t, I, c.other, al); });
    var tot = {};
    ['dayPrem', 'dayBase', 'dayUplift', 'dayLoss', 'dayProfit', 'nightPrem', 'nightUplift', 'nightLoss', 'nightProfit', 'tail', 'badNight', 'reserve', 'reserveTarget', 'reservePays', 'capitalPays', 'profit', 'insShares'].forEach(function (k) {
      tot[k] = rows.reduce(function (a, r) { return a + r[k]; }, 0);
    });
    ['normal', 'surge', 'wait'].forEach(function (k) { tot[k] = rows.reduce(function (a, r) { return a + r.f[k]; }, 0); });
    tot.perShare = tot.insShares ? tot.profit / tot.insShares : 0;
    var M = membership(I.users, I.mixYearly / 100, I.churn / 100);
    tot.mem = M; tot.fee = M.feeY;
    tot.membership = M.firstYear;                // first-year membership revenue (Yearly up front + Monthly billed monthly with churn)
    tot.memberDaily = M.firstYear / 365;         // straight-line view over the first 12 months
    tot.insuredValue = rows.reduce(function (a, r) { return a + r.insuredValue; }, 0);
    return { rows: rows, tot: tot, I: I };
  }

  /* ---------------- inputs ---------------- */
  var DEF = { users: 1000, stock: 'MOON', shares: 100, cushion: 0, hours: 6.5, overnight: false, news: 0, fullDay: 50, surgePct: 50, coverage: 1, day: 1, mixYearly: 70, churn: 8 };
  var I;
  try { I = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { I = Object.assign({}, DEF); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(I)); } catch (e) {} }

  // users slider is log-scaled: 0..1000 -> 1..1,000,000
  var FIELDS = [
    { k: 'users', label: 'Users turning insurance on', min: 1, max: 1000000, step: 1, log: true, fmt: function (v) { return v.toLocaleString(); } },
    { k: 'shares', label: 'Shares per user (per stock)', min: 1, max: 5000, step: 1 },
    { k: 'cushion', label: 'Cushion below price (K = S × (1 − c))', min: 0, max: 20, step: 0.5, unit: '%' },
    { k: 'hours', label: 'Hours insured per trading day', min: 0, max: 6.5, step: 0.25, unit: 'h' },
    { k: 'day', label: 'Policy day n (trading days since lock; taper f(n) = √n − √(n−1), min 0.05)', min: 1, max: 252, step: 1 },
    { k: 'news', label: 'News-shock level H', min: 0, max: 1, step: 0.05 },
    { k: 'fullDay', label: 'Users staying a full 24h (10% off base)', min: 0, max: 100, step: 5, unit: '%' },
    { k: 'surgePct', label: 'Over-capacity users who pay surge (rest wait)', min: 0, max: 100, step: 5, unit: '%' },
    { k: 'mixYearly', label: 'Plan mix: members on Yearly (rest Monthly) · demo assumption', min: 0, max: 100, step: 5, unit: '%' },
    { k: 'churn', label: 'Monthly-plan churn per month · demo assumption', min: 0, max: 30, step: 0.5, unit: '%' }
  ];
  function toSlider(f, v) { return f.log ? Math.round(Math.log10(Math.max(1, v)) / 6 * 1000) : v; }
  function fromSlider(f, s) { return f.log ? Math.round(Math.pow(10, s / 1000 * 6)) : +s; }

  function money(n, d) { if (d == null) d = Math.abs(n) >= 100 ? 0 : 2; return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function signed(n, d) { return (n >= 0 ? '+' : '') + money(n, d); }
  function num(n) { return Math.round(n).toLocaleString(); }
  function bigm(x) { var v = Math.abs(x); return '$' + (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : Math.round(v)); }
  function pct0(x) { return Math.round(x * 100) + '%'; }
  function volLine(lv) { return pct0(lv.used) + ' (higher of recent ' + pct0(lv.rv) + ' / options-implied ' + pct0(lv.iv) + (lv.earnInside ? ', incl. earnings ' + lv.earnDate + ' +' + (lv.bumpPts * 100).toFixed(1) + ' pts' : '') + (lv.ivSrc === 'assumed' ? ', implied assumed for a fictional stock' : lv.ivSrc === 'iv30' ? ', implied estimated' : '') + ')'; }
  function cls(n) { return n >= 0 ? 'up' : 'down'; }

  function fieldHtml(f) {
    return '<div class="pj-field"><div class="pj-flabel"><label for="pj-n-' + f.k + '">' + f.label + '</label>' +
      '<span class="pj-numwrap"><input class="pj-num" id="pj-n-' + f.k + '" data-pk="' + f.k + '" type="number" inputmode="decimal" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + I[f.k] + '">' + (f.unit ? '<span class="pj-unit">' + f.unit + '</span>' : '') + '</span></div>' +
      '<input class="pj-range" id="pj-r-' + f.k + '" data-pk="' + f.k + '" type="range" min="' + (f.log ? 0 : f.min) + '" max="' + (f.log ? 1000 : f.max) + '" step="' + (f.log ? 1 : f.step) + '" value="' + toSlider(f, I[f.k]) + '" aria-label="' + f.label + '"></div>';
  }
  function segHtml(k, opts) {
    return '<div class="pj-seg" role="group">' + opts.map(function (o) { return '<button class="' + (I[k] === o[0] ? 'on' : '') + '" data-pseg="' + k + '" data-pv="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>';
  }

  function view() {
    return '<div id="pj-root"><div class="pj-tag">PROJECTION — DEMO INPUTS</div>' +
      '<p class="pj-intro">Playground for the draft v4 pricing with the p9 changes (rate locked at start at max(recent, implied) volatility, duration taper, put-value floor, per-person caps, annual membership, firm-wide limits with book-stress surge; waiting line and overnight from v3). Stock inputs: ' + ((g.PC_UNIVERSE || {}).label || 'demo snapshot') + '. Outputs are examples, not forecasts.</p>' +
      '<div class="pj-card"><h3 class="pj-h">Inputs</h3>' +
      '<div class="pj-field"><div class="pj-flabel"><span>Stock</span></div>' + segHtml('stock', [['COP', 'COP'], ['WMT', 'WMT'], ['NVDA', 'NVDA'], ['MOON', 'MOON'], ['ALL', 'All four']]) + '</div>' +
      FIELDS.slice(0, 4).map(fieldHtml).join('') +
      '<div class="pj-field" id="pj-coverage"><div class="pj-flabel"><span>Coverage length (share of trading day held)</span></div>' +
      segHtml('coverage', COVERAGE_OPTS.map(function (c) { return [c, Math.round(c * 100) + '%']; })) +
      '<div class="pj-sub pj-covnote" id="pj-covnote">' + covNote() + '</div></div>' +
      '<div class="pj-field"><div class="pj-flabel"><span>Include overnight coverage</span></div>' + segHtml('overnight', [[false, 'No'], [true, 'Yes']]) + '</div>' +
      FIELDS.slice(4, 8).map(fieldHtml).join('') +
      '<div class="pj-field" id="pj-fee"><div class="pj-flabel"><span>Membership plans (non-refundable for the current billing period)</span></div>' +
      '<div class="pj-seg pj-plans" role="group"><span class="pj-plan"><b>Monthly</b> $' + (C.MEMBERSHIP_MONTHLY || 29.99).toFixed(2) + '/mo</span><span class="pj-plan"><b>Yearly</b> $' + (C.MEMBERSHIP_YEARLY || 199) + '/yr</span></div>' +
      '<div class="pj-sub">Every user is a member on top of premiums. Yearly is paid up front; Monthly is billed each month and auto-renews until cancelled. Yearly saves $' + ((C.MEMBERSHIP_MONTHLY || 29.99) * 12 - (C.MEMBERSHIP_YEARLY || 199)).toFixed(2) + ' (≈' + Math.round(((C.MEMBERSHIP_MONTHLY || 29.99) * 12 - (C.MEMBERSHIP_YEARLY || 199)) / ((C.MEMBERSHIP_MONTHLY || 29.99) * 12) * 100) + '%) vs 12 × $' + (C.MEMBERSHIP_MONTHLY || 29.99).toFixed(2) + ' = $' + ((C.MEMBERSHIP_MONTHLY || 29.99) * 12).toFixed(2) + '.</div></div>' +
      FIELDS.slice(8).map(fieldHtml).join('') +
      '<div class="pj-sub pj-capnote">Coverage cap: at most $' + C.CAP_PER_STOCK.toLocaleString() + ' insured value per stock and $' + C.CAP_TOTAL.toLocaleString() + ' in total (K × shares), per verified person (identity/KYC), not per brokerage account.</div>' +
      '<div class="pj-sub pj-exercise">Optional exercise: the cushion (K) is only the line where users <b>may</b> cash in. Nothing is sold automatically, and users can keep insurance on indefinitely.</div>' +
      '<button class="pj-btn ghost" data-pact="reset">Reset inputs</button></div>' +
      '<div id="pj-out">' + outHtml() + '</div></div>';
  }

  function covNote() {
    var cov = +I.coverage || 1, h = I.hours * cov;
    return 'Applies to the trading-session hours above: covered time = ' + I.hours + ' h × ' + Math.round(cov * 100) + '% = ' +
      (Math.round(h * 100) / 100) + ' h (' + Math.round(h * 60) + ' billed min). Premium scales linearly with billed minutes; expected payouts scale with √time. ' +
      'Short coverage is held up by the v4 put floor. Overnight stays a separate nightly price' + (cov < 1 ? '; the 10% full-24h discount needs 100% coverage.' : '.');
  }

  /* ---------------- outputs ---------------- */
  function capBar(r) {
    var f = r.f, U = I.users || 1;
    var seg = function (v, c) { return v ? '<span class="pj-bar-' + c + '" style="width:' + (v / U * 100) + '%"></span>' : ''; };
    var band = f.u >= P.hardStop - 1e-9 ? 'Hard stop' : f.u >= 1 ? 'At cap (surge)' : f.u >= P.nearCap ? 'Near cap' : 'Open';
    var uw = Math.min(100, f.u / 1.3 * 100);
    return '<div class="pj-cap"><div class="pj-row"><b>' + r.t + '</b><span class="pj-band pj-band-' + band.split(' ')[0].toLowerCase() + '">' + band + ' · u ' + f.u.toFixed(2) + '</span></div>' +
      '<div class="pj-bar" aria-label="Users by fill type">' + seg(f.normal, 'n') + seg(f.surge, 's') + seg(f.wait, 'w') + '</div>' +
      '<div class="pj-legend"><span><i class="pj-dot n"></i>Normal ' + num(f.normal) + '</span><span><i class="pj-dot s"></i>Surge ' + num(f.surge) + (f.surge ? ' (' + f.Mmin.toFixed(2) + '–' + f.Mmax.toFixed(2) + '×)' : '') + '</span><span><i class="pj-dot w"></i>Waiting ' + num(f.wait) + '</span></div>' +
      '<div class="pj-util"><span style="width:' + uw + '%"></span><em style="left:' + (0.9 / 1.3 * 100) + '%"></em><em style="left:' + (1 / 1.3 * 100) + '%"></em><em style="left:' + (1.25 / 1.3 * 100) + '%"></em></div>' +
      '<div class="pj-sub">Limit ' + bigm(r.lim) + (r.lim < r.nameLim - 1 ? ' (sector/firm share; name limit ' + bigm(r.nameLim) + ')' : ' = min(10% of the ' + bigm(C.FIRM_LIMIT) + ' firm limit, 10% of ' + bigm(BY_T[r.t].addv) + '/day traded)') + ' · insured ' + bigm(f.Qn + f.Qs) + ' (' + num(r.insShares) + ' sh) · book stress ' + r.al.stress.toFixed(2) + (r.al.M > 1 ? ' → surge ×' + r.al.M.toFixed(2) + ' on new locks' : '') + ' · ticks at u = 0.90 / 1.00 / 1.25</div></div>';
  }
  function kpi(k, v, sub, c) { return '<div class="pj-kpi"><div class="k">' + k + '</div><div class="v ' + (c || '') + '">' + v + '</div>' + (sub ? '<div class="pj-sub">' + sub + '</div>' : '') + '</div>'; }
  function line(k, v, c) { return '<div class="pj-line' + (c ? ' ' + c : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; }

  function memberCard(M) {
    function m2(x) { return money(x, 2); }
    function ref(n) { var R = membership(n, M.mixY, M.churn); return '<div class="pj-tr" data-ref="' + n + '"><span><b>' + num(n) + '</b></span><span>' + money(R.upFront) + '</span><span>' + money(R.monthly) + '</span><span>' + money(R.firstYear) + '</span></div>'; }
    return '<div class="pj-card" id="pj-member"><h3 class="pj-h">Membership plans · first year <span class="pj-mini">Projection — demo assumptions</span></h3>' +
      line('Yearly: ' + num(M.nY) + ' members × $' + M.feeY + ' (up front)', money(M.upFront), 'em') +
      line('Monthly: ' + num(M.nM) + ' members × $' + M.feeM.toFixed(2) + ' × ' + M.months.toFixed(3) + ' paid months', money(M.monthly)) +
      '<div class="pj-sub">Paid months per Monthly member = Σ(1 − ' + (M.churn * 100) + '%)^k, k = 0…11 = (1 − ' + (1 - M.churn).toFixed(3) + '^12) / ' + M.churn.toFixed(3) + ' = ' + M.months.toFixed(3) + ' (12 with no churn: ' + money(M.monthlyNoChurn) + '). ' + num(M.nM12) + ' Monthly members still paying in month 12.</div>' +
      line('= first-year membership revenue', money(M.firstYear), 'em') +
      line('Cash on day 1 (Yearly + first Monthly charge)', money(M.upFront) + ' + ' + money(M.nM * M.feeM) + ' = ' + money(M.day1)) +
      '<div class="pj-table" style="margin-top:8px"><div class="pj-tr pj-th"><span>Users</span><span>Up front</span><span>Monthly yr 1</span><span>First year</span></div>' + ref(1000) + ref(10000) + '</div>' +
      '<div class="pj-sub">Plan mix ' + Math.round(M.mixY * 100) + '% Yearly / ' + Math.round((1 - M.mixY) * 100) + '% Monthly and ' + (M.churn * 100) + '%/month Monthly churn are demo assumptions. Fees are non-refundable for the current billing period (no refund liability). Yearly renewals and Yearly churn fall after the first year and are not counted. Not included in the premium or profit KPIs above.</div></div>';
  }

  function outHtml() {
    var pr = project(I), T = pr.tot, rows = pr.rows, multi = rows.length > 1;
    var h = '<div class="pj-card"><h3 class="pj-h">Capacity &amp; waiting line <span class="pj-mini">Projection — demo inputs</span></h3>' + rows.map(capBar).join('') + '</div>';
    h += '<div class="pj-card"><h3 class="pj-h">' + (multi ? 'Totals · all four' : rows[0].t + ' · per trading day') + ' · ' + Math.round(rows[0].cov * 100) + '% coverage <span class="pj-mini">Projection — demo inputs</span></h3><div class="pj-kpis">' +
      kpi('Premium / day', money(T.dayPrem), 'policy day ' + rows[0].day + ' · taper ×' + rows[0].taper.toFixed(3) + ' · incl. ' + money(T.dayUplift) + ' surge uplift · ' + num(rows[0].m) + ' covered min' + (rows.some(function (r) { return r.floorBinds; }) ? ' · put floor binds' : '')) +
      kpi('Premium / night', I.overnight ? money(T.nightPrem) : '—', I.overnight ? 'lump, 1 night' : 'overnight off') +
      kpi('Expected payouts', money(T.dayLoss + T.nightLoss), 'day ' + money(T.dayLoss) + (I.overnight ? ' · night ' + money(T.nightLoss) : '')) +
      kpi('Expected profit / day', signed(T.dayProfit), null, cls(T.dayProfit)) +
      kpi('Expected profit / night', I.overnight ? signed(T.nightProfit) : '—', null, cls(T.nightProfit)) +
      kpi('Expected profit / share', signed(T.perShare, 4), 'per insured share, day + night', cls(T.perShare)) +
      kpi('Reserve (surge uplift)', money(T.reserve), 'target ' + money(T.reserveTarget) + ' (20% drop on surge shares)') +
      kpi('1-in-20 bad gap loss', I.overnight ? '−' + money(T.tail) : '—', I.overnight ? '95th-pct overnight gap, all insured shares' : 'turn overnight on') +
      kpi('Membership · first year', money(T.mem.firstYear), 'Yearly ' + money(T.mem.upFront) + ' + Monthly ' + money(T.mem.monthly) + ' (' + I.mixYearly + '/' + (100 - I.mixYearly) + ' mix, ' + I.churn + '%/mo churn, assumed) · ≈ ' + money(T.memberDaily) + '/day') +
      kpi('Membership cash up front', money(T.mem.upFront), num(T.mem.nY) + ' Yearly × $' + T.mem.feeY + ' · day 1 incl. first Monthly charge ' + money(T.mem.day1)) +
      kpi('Covered shares / user', rows.map(function (r) { return num(r.n) + (r.n < r.nReq ? ' of ' + num(r.nReq) : ''); }).join(' · '), rows.some(function (r) { return r.n < r.nReq; }) ? 'capped: $' + C.CAP_PER_STOCK.toLocaleString() + ' per stock / $' + C.CAP_TOTAL.toLocaleString() + ' per person (K × shares)' : 'within the per-person cap ($' + C.CAP_PER_STOCK.toLocaleString() + ' per stock, $' + C.CAP_TOTAL.toLocaleString() + ' total)') +
      '</div><div class="pj-row pj-sub" style="margin-top:8px"><span>Users: ' + num(T.normal) + ' normal · ' + num(T.surge) + ' surge · ' + num(T.wait) + ' waiting</span></div></div>';
    h += memberCard(T.mem);
    if (multi) {
      h += '<div class="pj-card"><h3 class="pj-h">Per stock <span class="pj-mini">Projection — demo inputs</span></h3><div class="pj-table"><div class="pj-tr pj-th"><span>Stock</span><span>Covered sh</span><span>Prem/day</span><span>Loss</span><span>Profit</span></div>' +
        rows.map(function (r) { return '<div class="pj-tr"><span><b>' + r.t + '</b></span><span>' + num(r.n) + (r.n < r.nReq ? '/' + num(r.nReq) : '') + '</span><span>' + money(r.dayPrem + r.nightPrem) + '</span><span>' + money(r.dayLoss + r.nightLoss) + '</span><span class="' + cls(r.profit) + '">' + signed(r.profit) + '</span></div>'; }).join('') +
        '<div class="pj-tr pj-tot"><span><b>Total</b></span><span></span><span>' + money(T.dayPrem + T.nightPrem) + '</span><span>' + money(T.dayLoss + T.nightLoss) + '</span><span class="' + cls(T.profit) + '">' + signed(T.profit) + '</span></div></div>' +
        '<div class="pj-sub">Night premium and loss are included in Prem/day and Loss when overnight is on.</div></div>';
    }
    // breakdown
    h += '<div class="pj-card" id="pj-breakdown"><h3 class="pj-h">Breakdown <span class="pj-mini">Projection — demo inputs</span></h3>' + rows.map(function (r) {
      var b = r.b;
      return '<div class="pj-bd"><div class="pj-bdh">' + r.t + ' · S ' + money(r.S, 2) + ' · K ' + money(r.K, 2) + ' · ' + r.n + ' sh/user</div>' +
        '<div class="pj-formula">Rate locked at start (S ' + money(r.S, 2) + ', H ' + I.news.toFixed(2) + ') · base₁ = 0.0029 × E ' + money(b.E, 2) + ' × L ' + b.L.toFixed(3) + ' × (1+3H) = ' + money(b.baseRaw, 4) + '/min · day ' + r.day + ' taper ×' + r.taper.toFixed(3) + ' → ' + money(r.base, 4) + '/min</div>' +
        line('Volatility used (rate and put floor)', volLine(r.lv)) +
        line('Covered shares per user (cap $' + C.CAP_PER_STOCK.toLocaleString() + '/stock, $' + C.CAP_TOTAL.toLocaleString() + ' total, per verified person)', num(r.n) + ' of ' + num(r.nReq) + ' requested · insured value ' + money(r.insuredValue)) +
        line('Base: tapered rate × covered minutes × D (base only)', money(r.base, 4) + ' × ' + num(r.m) + (r.cov < 1 ? ' (' + num(r.mFull) + ' × ' + Math.round(r.cov * 100) + '%)' : '') + ' × ' + r.dfac.toFixed(3) + ' = ' + money(r.baseDay, 2) + '/policy' + (r.discEligible ? '' : ' (10% off needs overnight + 6.5 h + 100% coverage)')) +
        line('Floor: 1.15 × N × BS put for this day\'s covered variance', money(r.floorDay, 2) + '/policy' + (r.floorBinds ? ' ← binds' : '')) +
        line('Charge / policy = min(cap, max(base, floor))' + (r.capBinds ? ' (cap $6/min binds)' : ''), money(r.perDay, 2) + ' × ' + num(r.insured) + ' insured users') +
        line('= base premium / day', money(r.dayBase)) +
        line('+ surge uplift (Base × (M−1) × min) → reserve', money(r.dayUplift)) +
        line('= premium / day', money(r.dayPrem), 'em') +
        line('− expected payouts / day (G(z), σ ∝ √' + (Math.round(r.m / 60 * 100) / 100) + ' h covered)', '−' + money(r.dayLoss)) +
        line('= expected profit / day', '<span class="' + cls(r.dayProfit) + '">' + signed(r.dayProfit) + '</span>', 'em') +
        (I.overnight ?
          line('Night price / policy = 1.12 × ΔE_night (gap on top of the session) × L × (1+3H) × taper, floored', money(r.np.premium, 2) + ' (untapered ' + money(r.np.untapered, 2) + ' · ≈ ' + money(r.np.perHour, 2) + '/h from close)') +
          line('× insured users (+ surge uplift)', num(r.insured) + ' → ' + money(r.nightPrem)) +
          line('− expected overnight loss', '−' + money(r.nightLoss)) +
          line('= expected profit / night', '<span class="' + cls(r.nightProfit) + '">' + signed(r.nightProfit) + '</span>', 'em') +
          '<div class="pj-bad"><div class="pj-bdh pj-row">Bad-night scenario (1-in-20 gap) <span class="pj-mini">Projection — demo inputs</span></div>' +
          line('Gap move 1.645 × σ_gap', (P.tailZ * r.np.sigmaGap * (1 + I.news) * 100).toFixed(2) + '% → ' + money(r.tailPerShare, 2) + '/sh below K') +
          line('Tail loss × ' + num(r.insShares) + ' insured sh', '−' + money(r.tail)) +
          line('Night premium collected', money(r.nightPrem)) +
          line('Net on a bad night', '<span class="' + cls(r.badNight) + '">' + signed(r.badNight) + '</span>', 'em') +
          line('Paid by surge reserve / general capital', money(r.reservePays) + ' / ' + money(r.capitalPays)) + '</div>'
          : '<div class="pj-sub">Turn on overnight coverage to see the night price and the bad-night scenario.</div>') + '</div>';
    }).join('') + '</div>';
    h += '<details class="pj-card pj-assume"><summary>Assumptions</summary><ul class="pj-sub">' +
      '<li>Stock inputs are a <b>' + ((g.PC_UNIVERSE || {}).label || 'demo snapshot') + '</b> (not live data): COP ' + money(BY_T.COP.p0, 2) + ', WMT ' + money(BY_T.WMT.p0, 2) + ', NVDA ' + money(BY_T.NVDA.p0, 2) + ' closing prices, realized vols, shares outstanding (float proxy), daily volume and options-implied vol; MOON ($24.20, implied vol 150% assumed) is fictional.</li>' +
      '<li>p9 volatility: σ = max(recent realized vol (20-day), options-implied vol) for each stock, used for BOTH the locked base rate and the 1.15× put floor. Implied vol is Black-Scholes (r = 0) backed out of listed Nov-20-2026 put mids for COP/WMT/NVDA (higher of at-the-money and 5% below); it includes an earnings bump when a known report date (COP Nov 5, NVDA Nov 17, WMT Nov 19) falls within 28 days of the lock: σ² = σ_base² + m²·365/28, m = assumed 1-day earnings move (estimate).</li>' +
      '<li>p9 capacity: firm-wide limits on insured value (K × shares): per stock min(10% of the ' + bigm(C.FIRM_LIMIT) + ' firm limit, 10% of its daily $ volume), per sector 25% of the firm limit, and the firm total (demo values). Surge is set by book-wide stress (firm or sector utilisation), so a crowded book raises prices on all names together.</li>' +
      '<li>v4: the rate is locked when coverage starts (S, σ and H at lock; S_eff = max(S, K)); later moves do not reprice it. Policy day n is trading days since the lock; turning coverage off resets it. The base is multiplied by f(n) = max(√n − √(n−1), 0.05), so cumulative base cost grows like √n, like a put.</li>' +
      '<li>Floor: each day\'s charge is at least 1.15 × N × [P(n·w) − P((n−1)·w)], the Black-Scholes put (σ_annual, r = 0) for the covered variance w = 0.75 × (covered session min / 390) + 0.25 × (night covered), in trading days. This is a minimum, not a target: the price never drops below the comparable put (cumulative charge ≥ 1.15 × the put). $6/min cap on the base before surge; $0.002/min operational minimum.</li>' +
      '<li>Full-day pricing: the session and the overnight gap are each priced on a full trading day of variance (as in v3). σ₁ = σ_annual × √(1 / (252·390)); the night lump is the stand-alone gap expected shortfall on a full day\'s variance. The put floor and expected losses use the physical split (session 75%, overnight 25% of a day\'s variance), so the floor matches the comparable listed put.</li>' +
      '<li>Per-person caps: covered shares = floor(min($5,000, $25,000 − insured value in other stocks) / K), per verified person (identity/KYC) — not per account. "All four" fills stocks in order for the $25k total.</li>' +
      '<li>Membership (p12): Monthly $' + (C.MEMBERSHIP_MONTHLY || 29.99).toFixed(2) + '/month or Yearly $' + (C.MEMBERSHIP_YEARLY || 199) + '/year, each non-refundable for the current billing period and auto-renewing until cancelled (cancellation takes effect at the end of the current period). Plan mix (default 70% Yearly) and Monthly churn (default 8%/month) are demo assumptions. Yearly fees are cash up front; Monthly fees are billed at the start of each month. Not included in premium or profit KPIs above.</li>' +
      '<li>All users arrive at once, FIFO, identical orders. Open band (u &lt; 0.90 of the stock\'s limit): fill if it fits; near cap: fill only if it fits and ≤ 0.5% of the limit; otherwise the chosen % pay surge (M = max(2.0, M(book stress))) and the rest wait. No surge fill may push u above 1.25.</li>' +
      '<li>"All four": every user insures the chosen shares in each stock; each stock has its own limit, and the sector and firm limits are shared. Totals add stocks; the bad-gap total assumes all four gap down together.</li>' +
      '<li>Expected loss: the increase in expected shortfall N·S·σ√τ·G(z) over day n\'s covered variance for a lock held since day 1 (σ_gap = σ_annual·√(0.25/252) overnight). News is assumed to raise realized vol by (1+H) for losses; the premium uses (1+3H), locked at start.</li>' +
      '<li>Overnight = one normal weeknight (T_c 17.5 h, no event), option (a) lump premium (full-day pricing: stand-alone gap ES on a full day of variance, tapered, never below the put floor), capped at $360/h × 17.5 h before surge.</li>' +
      '<li>10% off applies to base (day and night) only, and only when overnight is on, hours = 6.5 and coverage = 100%, since D needs an unbroken 24 h block.</li>' +
      '<li>Coverage length: insured users hold coverage for 25/50/75/100% of the insured session hours. The base is linear in billed minutes but payouts scale with √time; in v4 the put floor prices short coverage by its covered variance, so partial-day coverage is no longer underpriced. Overnight tail and reserve target are not scaled.</li>' +
      '<li>Optional exercise: K is only the level where users may cash in. No automatic sell and no coverage end at K; payouts are modeled as expected shortfall below K at the end of each covered window (users who keep coverage roll into the next window).</li>' +
      '<li>Reserve = one day\'s surge uplift (day + night). No queue promotion, offer windows, cash-outs or intraday payouts are simulated.</li></ul></details>' +
      '<div class="pj-foot">Projection — demo inputs. Not a forecast, quote, or approved rate.</div>';
    return h;
  }

  function refresh() { var o = document.getElementById('pj-out'); if (o) o.innerHTML = outHtml(); save(); }
  function setVal(k, v, src) {
    var f = FIELDS.filter(function (x) { return x.k === k; })[0]; if (!f) return;
    if (isNaN(v)) return;
    v = Math.min(f.max, Math.max(f.min, v));
    if (f.k === 'users' || f.k === 'shares' || f.k === 'day') v = Math.round(v);
    I[k] = v;
    var n = document.getElementById('pj-n-' + k), r = document.getElementById('pj-r-' + k);
    if (n && src !== n) n.value = v;
    if (r && src !== r) r.value = toSlider(f, v);
    var cn = document.getElementById('pj-covnote'); if (cn) cn.innerHTML = covNote();
    refresh();
  }
  document.addEventListener('input', function (e) {
    var el = e.target; if (!el.dataset || !el.dataset.pk) return;
    var f = FIELDS.filter(function (x) { return x.k === el.dataset.pk; })[0];
    if (el.type === 'range') setVal(f.k, fromSlider(f, +el.value), el);
    else if (el.value !== '') setVal(f.k, +el.value, el);
  });
  document.addEventListener('change', function (e) { var el = e.target; if (el.dataset && el.dataset.pk && el.type === 'number') el.value = I[el.dataset.pk]; });
  document.addEventListener('click', function (e) {
    var s = e.target.closest('[data-pseg]');
    if (s) {
      var k = s.dataset.pseg, v = s.dataset.pv; I[k] = k === 'overnight' ? v === 'true' : (k === 'coverage' || k === 'fee') ? +v : v;
      s.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === s); });
      var cn = document.getElementById('pj-covnote'); if (cn) cn.innerHTML = covNote();
      refresh(); return;
    }
    var a = e.target.closest('[data-pact="reset"]');
    if (a) { I = Object.assign({}, DEF); save(); var root = document.getElementById('pj-root'); if (root) root.outerHTML = view(); }
  });

  g.PCProjections = { view: view, project: project, projectStock: projectStock, fill: fill, surgeMultiplier: surgeMultiplier, nightPremium: nightPremium, inputs: function () { return I; }, constants: P, coverageOptions: COVERAGE_OPTS };
})(window);
