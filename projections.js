/* Paracord — Projections playground (DEMO). Implements the capacity / queue / surge /
 * overnight model of /workspace/paracord-pricing-v3.md, repriced per paracord-pricing-v4.md, on DEMO inputs only.
 * Reuses rate.js (insuranceRateBreakdown) for the daytime base rate. Nothing here is live data. */
(function (g) {
  'use strict';
  var STOCKS = g.PC_STOCKS, BY_T = {};
  STOCKS.forEach(function (s) { BY_T[s.t] = s; });
  var C = g.PARACORD_RATE_CONSTANTS;
  var KEY = 'paracord-proj-v1';
  var MIN_PER_YEAR = 252 * 390;
  var COVERAGE_OPTS = [0.25, 0.5, 0.75, 1];   // p3 coverage-length toggle: fraction of the trading-session window held
  var P = {              // v3 constants (EXAMPLE values from the md)
    q: 0.01,             // Q_max = 1% of float
    nearCap: 0.90, hardStop: 1.25, nearCapMaxOrder: 0.005,
    nightLoad: 1.12,     // 1.12 * E_night * L * (1 + 3H)
    Tc: 17.5,            // closed hours, normal weeknight
    nightCapPerHour: C.R_max * 60, // $360/hour before surge
    tailZ: 1.645,        // 1-in-20 one-sided
    reserveDrop: 0.20    // reserve target: payout on a 20% drop across surge shares
  };

  /** M(u) = 2 + (u - 1)/0.25 for 1 <= u < 1.25 (u below 1 is clamped to 2.0x) */
  function surgeMultiplier(u) { return 2 + (Math.min(Math.max(u, 1), P.hardStop) - 1) / 0.25; }
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

  /** FIFO fill of U identical orders of n shares into a pool of Q_max (md sec. 3–5). */
  function fill(U, n, Qmax, surgePct) {
    var Qn = 0, Qs = 0, r = { normal: 0, surge: 0, wait: 0, waitHard: 0, sumMm1: 0, Mmin: 0, Mmax: 0, firstSurgeAt: 0 };
    var acc = 0;
    for (var i = 0; i < U; i++) {
      var Q = Qn + Qs, u = Q / Qmax, room = Qmax - Q;
      if (u >= P.hardStop) { r.waitHard += U - i; r.wait += U - i; break; }
      if (n <= room && (u < P.nearCap || n <= P.nearCapMaxOrder * Qmax)) { Qn += n; r.normal++; continue; }
      // over capacity (or the order doesn't fit): choose surge or wait, deterministically by surgePct
      acc += surgePct; var wantsSurge = acc >= 1; if (wantsSurge) acc -= 1;
      if (wantsSurge && (Q + n) / Qmax <= P.hardStop) {
        var M = surgeMultiplier(u);
        Qs += n; r.surge++; r.sumMm1 += M - 1;
        if (!r.Mmin) { r.Mmin = M; r.firstSurgeAt = i + 1; } r.Mmax = M;
      } else { r.wait++; if ((Q + n) / Qmax > P.hardStop) r.waitHard++; }
    }
    r.Qn = Qn; r.Qs = Qs; r.u = (Qn + Qs) / Qmax; r.Qmax = Qmax;
    return r;
  }

  /**
   * v4 (paracord-pricing-v4.md): rate locked at the moment users turn coverage on (S, sigma, H at lock), duration taper
   * f(n) on policy day n, put-value floor 1.15 x N x BS put for the covered variance, per-person caps on shares
   * ($5,000 per stock / $25,000 total, K x shares, per verified person), annual membership (non-refundable) as up-front cash.
   * `otherInsured` = insured value (K x shares) the same person already has in other stocks (for the $25k total cap).
   */
  function projectStock(t, I, otherInsured) {
    var d = BY_T[t], S = d.p0, nReq = I.shares, K = S * (1 - I.cushion / 100), H = I.news;
    var n = g.paracordCapShares(K, nReq, otherInsured || 0);  // per-person cap: covered shares per user
    var capWhy = n >= nReq ? null : (K * (nReq) > C.CAP_PER_STOCK && (otherInsured || 0) + C.CAP_PER_STOCK <= C.CAP_TOTAL ? 'per-stock' : 'total');
    var day = Math.max(1, Math.round(I.day || 1)), taper = g.paracordTaper(day);
    var lock = { price: S, volatility: d.vol, news: H };  // locked at the start of the policy
    var o = { price: S, shares: n, lockIn: K, volatility: d.vol, float: d.float, adv: d.adv, news: H, lock: lock };
    var b = g.insuranceRateBreakdown(Object.assign({}, o, { day: day }));
    var sigma1 = b.sigma1, sigAnn = b.sigAnn;
    var base = b.base;                                      // tapered per-minute base, no D, no floor
    var Qmax = P.q * d.float;
    var f = fill(I.users, n, Qmax, I.surgePct / 100);
    var insured = f.normal + f.surge, insShares = f.Qn + f.Qs;
    var cov = COVERAGE_OPTS.indexOf(+I.coverage) >= 0 ? +I.coverage : 1;
    var mFull = I.hours * 60;
    var m = mFull * cov;                                    // covered (billed) session minutes per trading day
    var discEligible = I.overnight && I.hours >= 6.5 && cov >= 1; // unbroken 24h block needs full day + night coverage
    var dfac = discEligible ? 1 - (1 - C.D_full_day) * I.fullDay / 100 : 1;
    var nl = I.overnight ? g.paracordNightLump(o, 1) : 0;    // untapered v4 night lump (incremental over the session)
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
    var wd = C.w_session * m / 390 / 252, wn = I.overnight ? C.w_night / 252 : 0, t0 = (day - 1) * (wd + wn), sl = sigAnn * (1 + H);
    function es(tau) { return tau > 0 ? shortfall(n, S, K, sl * Math.sqrt(tau)) : 0; }
    var lossPerPolicyDay = m > 0 ? es(t0 + wd) - es(t0) : 0;
    var dayLoss = insured * lossPerPolicyDay;
    // ---- night ----
    var sigmaGap = sigAnn * Math.sqrt(C.w_night / 252);
    var np = { E: nl / (P.nightLoad * b.L * (1 + 3 * H) || 1), raw: nl, premium: perNight, untapered: nl, sigmaGap: sigmaGap, IM: sigmaGap * 0.798, perHour: perNight / P.Tc, capped: cAll.capBinds };
    var nightBase = I.overnight ? insured * perNight : 0;
    var nightUplift = I.overnight ? perNight1 * f.sumMm1 : 0;
    var nightPrem = nightBase + nightUplift;
    var sdGapLoss = sigmaGap * (1 + H);
    var nightLoss = I.overnight ? insured * (es(t0 + wd + wn) - es(t0 + wd)) : 0;
    var tailPerShare = Math.max(0, K - S * (1 - P.tailZ * sdGapLoss));  // 95th-pct gap
    var tail = I.overnight ? insShares * tailPerShare : 0;
    var reserve = dayUplift + nightUplift;
    var reserveTarget = f.Qs * Math.max(0, K - S * (1 - P.reserveDrop));
    var surgeTail = I.overnight ? f.Qs * tailPerShare : 0;
    var reservePays = Math.min(reserve, surgeTail);
    var fee = +I.fee || C.MEMBERSHIP_FEE;
    return {
      t: t, S: S, K: K, n: n, nReq: nReq, capWhy: capWhy, insuredValue: K * n, day: day, taper: taper, sigma1: sigma1, b: b, base: base, Qmax: Qmax, f: f, insured: insured, insShares: insShares,
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

  function project(I) {
    var ts = I.stock === 'ALL' ? STOCKS.map(function (s) { return s.t; }) : [I.stock];
    var other = 0; // per-person $25k total cap: stocks are filled in display order
    var rows = ts.map(function (t) { var r = projectStock(t, I, other); other += r.insuredValue; return r; });
    var tot = {};
    ['dayPrem', 'dayBase', 'dayUplift', 'dayLoss', 'dayProfit', 'nightPrem', 'nightUplift', 'nightLoss', 'nightProfit', 'tail', 'badNight', 'reserve', 'reserveTarget', 'reservePays', 'capitalPays', 'profit', 'insShares'].forEach(function (k) {
      tot[k] = rows.reduce(function (a, r) { return a + r[k]; }, 0);
    });
    ['normal', 'surge', 'wait'].forEach(function (k) { tot[k] = rows.reduce(function (a, r) { return a + r.f[k]; }, 0); });
    tot.perShare = tot.insShares ? tot.profit / tot.insShares : 0;
    tot.fee = +I.fee || C.MEMBERSHIP_FEE;
    tot.membership = I.users * tot.fee;          // up-front annual membership cash, non-refundable: kept, no refund liability
    tot.memberDaily = tot.membership / 365;      // straight-line revenue recognition over the 12-month term (accounting view)
    tot.insuredValue = rows.reduce(function (a, r) { return a + r.insuredValue; }, 0);
    return { rows: rows, tot: tot, I: I };
  }

  /* ---------------- inputs ---------------- */
  var DEF = { users: 1000, stock: 'MOON', shares: 100, cushion: 0, hours: 6.5, overnight: false, news: 0, fullDay: 50, surgePct: 50, coverage: 1, day: 1, fee: 99 };
  var FEE_OPTS = [49, 99, 199];
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
    { k: 'surgePct', label: 'Over-capacity users who pay surge (rest wait)', min: 0, max: 100, step: 5, unit: '%' }
  ];
  function toSlider(f, v) { return f.log ? Math.round(Math.log10(Math.max(1, v)) / 6 * 1000) : v; }
  function fromSlider(f, s) { return f.log ? Math.round(Math.pow(10, s / 1000 * 6)) : +s; }

  function money(n, d) { if (d == null) d = Math.abs(n) >= 100 ? 0 : 2; return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function signed(n, d) { return (n >= 0 ? '+' : '') + money(n, d); }
  function num(n) { return Math.round(n).toLocaleString(); }
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
      '<p class="pj-intro">Playground for the draft v4 pricing (rate locked at start, duration taper, put-value floor, per-person caps, annual membership; capacity, waiting line, surge and overnight from v3). All inputs and prices are simulated examples, not forecasts.</p>' +
      '<div class="pj-card"><h3 class="pj-h">Inputs</h3>' +
      '<div class="pj-field"><div class="pj-flabel"><span>Stock</span></div>' + segHtml('stock', [['COP', 'COP'], ['WMT', 'WMT'], ['NVDA', 'NVDA'], ['MOON', 'MOON'], ['ALL', 'All four']]) + '</div>' +
      FIELDS.slice(0, 4).map(fieldHtml).join('') +
      '<div class="pj-field" id="pj-coverage"><div class="pj-flabel"><span>Coverage length (share of trading day held)</span></div>' +
      segHtml('coverage', COVERAGE_OPTS.map(function (c) { return [c, Math.round(c * 100) + '%']; })) +
      '<div class="pj-sub pj-covnote" id="pj-covnote">' + covNote() + '</div></div>' +
      '<div class="pj-field"><div class="pj-flabel"><span>Include overnight coverage</span></div>' + segHtml('overnight', [[false, 'No'], [true, 'Yes']]) + '</div>' +
      FIELDS.slice(4).map(fieldHtml).join('') +
      '<div class="pj-field" id="pj-fee"><div class="pj-flabel"><span>Annual membership fee (paid up front, non-refundable)</span></div>' + segHtml('fee', FEE_OPTS.map(function (x) { return [x, '$' + x + '/yr']; })) +
      '<div class="pj-sub">Each user pays the membership once a year on top of premiums. It is non-refundable, so the whole fee is cash kept on day 1 with no refund liability.</div></div>' +
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
    var band = f.u >= P.hardStop ? 'Hard stop' : f.u >= 1 ? 'At cap (surge)' : f.u >= P.nearCap ? 'Near cap' : 'Open';
    var uw = Math.min(100, f.u / 1.3 * 100);
    return '<div class="pj-cap"><div class="pj-row"><b>' + r.t + '</b><span class="pj-band pj-band-' + band.split(' ')[0].toLowerCase() + '">' + band + ' · u ' + f.u.toFixed(2) + '</span></div>' +
      '<div class="pj-bar" aria-label="Users by fill type">' + seg(f.normal, 'n') + seg(f.surge, 's') + seg(f.wait, 'w') + '</div>' +
      '<div class="pj-legend"><span><i class="pj-dot n"></i>Normal ' + num(f.normal) + '</span><span><i class="pj-dot s"></i>Surge ' + num(f.surge) + (f.surge ? ' (' + f.Mmin.toFixed(2) + '–' + f.Mmax.toFixed(2) + '×)' : '') + '</span><span><i class="pj-dot w"></i>Waiting ' + num(f.wait) + '</span></div>' +
      '<div class="pj-util"><span style="width:' + uw + '%"></span><em style="left:' + (0.9 / 1.3 * 100) + '%"></em><em style="left:' + (1 / 1.3 * 100) + '%"></em><em style="left:' + (1.25 / 1.3 * 100) + '%"></em></div>' +
      '<div class="pj-sub">Q_max ' + num(r.Qmax) + ' sh (1% of ' + (BY_T[r.t].float / 1e6).toLocaleString() + 'M float) · insured ' + num(r.insShares) + ' sh · ticks at u = 0.90 / 1.00 / 1.25</div></div>';
  }
  function kpi(k, v, sub, c) { return '<div class="pj-kpi"><div class="k">' + k + '</div><div class="v ' + (c || '') + '">' + v + '</div>' + (sub ? '<div class="pj-sub">' + sub + '</div>' : '') + '</div>'; }
  function line(k, v, c) { return '<div class="pj-line' + (c ? ' ' + c : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; }

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
      kpi('Membership cash (up front)', money(T.membership), num(I.users) + ' × $' + T.fee + ' · annual, non-refundable: kept, no refund liability · recognized ≈ ' + money(T.memberDaily) + '/day over 12 months') +
      kpi('Covered shares / user', rows.map(function (r) { return num(r.n) + (r.n < r.nReq ? ' of ' + num(r.nReq) : ''); }).join(' · '), rows.some(function (r) { return r.n < r.nReq; }) ? 'capped: $' + C.CAP_PER_STOCK.toLocaleString() + ' per stock / $' + C.CAP_TOTAL.toLocaleString() + ' per person (K × shares)' : 'within the per-person cap ($' + C.CAP_PER_STOCK.toLocaleString() + ' per stock, $' + C.CAP_TOTAL.toLocaleString() + ' total)') +
      '</div><div class="pj-row pj-sub" style="margin-top:8px"><span>Users: ' + num(T.normal) + ' normal · ' + num(T.surge) + ' surge · ' + num(T.wait) + ' waiting</span></div></div>';
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
        '<div class="pj-formula">Rate locked at start (S ' + money(r.S, 2) + ', σ ' + Math.round(BY_T[r.t].vol * 100) + '%, H ' + I.news.toFixed(2) + ') · base₁ = 0.0029 × E ' + money(b.E, 2) + ' × L ' + b.L.toFixed(3) + ' × (1+3H) = ' + money(b.baseRaw, 4) + '/min · day ' + r.day + ' taper ×' + r.taper.toFixed(3) + ' → ' + money(r.base, 4) + '/min</div>' +
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
      '<li>Prices are each demo stock\'s simulated reference price (COP $104.80, WMT $98.40, NVDA $182.50, MOON $24.20); σ is its simulated annual vol; F and ADV are simulated. Not market data.</li>' +
      '<li>v4: the rate is locked when coverage starts (S, σ and H at lock; S_eff = max(S, K)); later moves do not reprice it. Policy day n is trading days since the lock; turning coverage off resets it. The base is multiplied by f(n) = max(√n − √(n−1), 0.05), so cumulative base cost grows like √n, like a put.</li>' +
      '<li>Floor: each day\'s charge is at least 1.15 × N × [P(n·w) − P((n−1)·w)], the Black-Scholes put (σ_annual, r = 0) for the covered variance w = 0.75 × (covered session min / 390) + 0.25 × (night covered), in trading days. Cumulative charge ≥ 1.15 × the put. $6/min cap on the base before surge; $0.002/min operational minimum.</li>' +
      '<li>Variance split: the session carries 75% of a day\'s close-to-close variance and the overnight gap 25%. σ₁ = σ_annual × √(0.75 / (252·390)); the night lump prices only the gap on top of the session.</li>' +
      '<li>Per-person caps: covered shares = floor(min($5,000, $25,000 − insured value in other stocks) / K), per verified person (identity/KYC) — not per account. "All four" fills stocks in order for the $25k total.</li>' +
      '<li>Membership: every user pays the annual fee up front ($49 / $99 / $199). Non-refundable, so it is counted as cash kept with no refund liability; for accounting it is recognized evenly over the 12-month term (fee/365 per day). It is not included in premium or profit KPIs above.</li>' +
      '<li>All users arrive at once, FIFO, identical orders. Open band (u &lt; 0.90): fill if it fits; near cap: fill only if it fits and ≤ 0.5% of Q_max; otherwise the chosen % pay surge (M fixed at the u they bought at; 2.0× if u &lt; 1) and the rest wait. No surge fill may push u above 1.25.</li>' +
      '<li>"All four": every user insures the chosen shares in each stock; each stock has its own pool. Totals add stocks; the bad-gap total assumes all four gap down together.</li>' +
      '<li>Expected loss: the increase in expected shortfall N·S·σ√τ·G(z) over day n\'s covered variance for a lock held since day 1 (σ_gap = σ_annual·√(0.25/252) overnight). News is assumed to raise realized vol by (1+H) for losses; the premium uses (1+3H), locked at start.</li>' +
      '<li>Overnight = one normal weeknight (T_c 17.5 h, no event), option (a) lump premium (v4: incremental gap ES, tapered, covered by the put floor), capped at $360/h × 17.5 h before surge.</li>' +
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
