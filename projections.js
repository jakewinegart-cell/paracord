/* Paracord — Projections playground (DEMO). Implements the capacity / queue / surge /
 * overnight model of /workspace/paracord-pricing-v3.md on DEMO inputs only.
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

  function projectStock(t, I) {
    var d = BY_T[t], S = d.p0, n = I.shares, K = S * (1 - I.cushion / 100), H = I.news;
    var sigma1 = d.vol / Math.sqrt(MIN_PER_YEAR);
    var b = g.insuranceRateBreakdown({ price: S, shares: n, lockIn: K, sigma1: sigma1, float: d.float, adv: d.adv, news: H });
    var base = b.preDiscount;                               // clamp(c·E·L·(1+3H), $0.02, $6) — no D
    var Qmax = P.q * d.float;
    var f = fill(I.users, n, Qmax, I.surgePct / 100);
    var insured = f.normal + f.surge, insShares = f.Qn + f.Qs;
    // Coverage length (p3): users hold coverage for only this fraction of the insured trading-session window.
    // Billed minutes (and so premium) scale linearly; overnight is a separate nightly price and is NOT scaled.
    var cov = COVERAGE_OPTS.indexOf(+I.coverage) >= 0 ? +I.coverage : 1;
    var mFull = I.hours * 60;
    var m = mFull * cov;                                    // covered (billed) minutes per trading day
    var discEligible = I.overnight && I.hours >= 6.5 && cov >= 1; // unbroken 24h block needs full day + night coverage
    var dfac = discEligible ? 1 - (1 - C.D_full_day) * I.fullDay / 100 : 1;
    // ---- day ----
    var dayBase = insured * base * m * dfac;
    var dayUplift = base * m * f.sumMm1;                    // surge uplift, never discounted -> reserve
    var dayPrem = dayBase + dayUplift;
    var sdLossDay = sigma1 * (1 + H) * Math.sqrt(m);         // assumption: news raises realized vol by (1+H)
    var lossPerPolicyDay = m > 0 ? shortfall(n, S, K, sdLossDay) : 0;
    var dayLoss = insured * lossPerPolicyDay;
    // ---- night ----
    var np = nightPremium({ annVol: d.vol, shares: n, price: S, lockIn: K, L: b.L, news: H });
    var nightBase = I.overnight ? insured * np.premium * dfac : 0;
    var nightUplift = I.overnight ? np.premium * f.sumMm1 : 0;
    var nightPrem = nightBase + nightUplift;
    var sdGapLoss = np.sigmaGap * (1 + H);
    var nightLoss = I.overnight ? insured * shortfall(n, S, K, sdGapLoss) : 0;
    var tailPerShare = Math.max(0, K - S * (1 - P.tailZ * sdGapLoss));  // 95th-pct gap
    var tail = I.overnight ? insShares * tailPerShare : 0;
    var reserve = dayUplift + nightUplift;
    var reserveTarget = f.Qs * Math.max(0, K - S * (1 - P.reserveDrop));
    var surgeTail = I.overnight ? f.Qs * tailPerShare : 0;
    var reservePays = Math.min(reserve, surgeTail);
    return {
      t: t, S: S, K: K, n: n, sigma1: sigma1, b: b, base: base, Qmax: Qmax, f: f, insured: insured, insShares: insShares,
      m: m, mFull: mFull, cov: cov, dfac: dfac, discEligible: discEligible,
      dayBase: dayBase, dayUplift: dayUplift, dayPrem: dayPrem, dayLoss: dayLoss, dayProfit: dayPrem - dayLoss, lossPerPolicyDay: lossPerPolicyDay,
      np: np, nightPrem: nightPrem, nightUplift: nightUplift, nightLoss: nightLoss, nightProfit: nightPrem - nightLoss,
      tail: tail, tailPerShare: tailPerShare, badNight: nightPrem - tail, reserve: reserve, reserveTarget: reserveTarget,
      surgeTail: surgeTail, reservePays: reservePays, capitalPays: tail - reservePays,
      profit: dayPrem - dayLoss + nightPrem - nightLoss,
      perShare: insShares ? (dayPrem - dayLoss + nightPrem - nightLoss) / insShares : 0
    };
  }

  function project(I) {
    var ts = I.stock === 'ALL' ? STOCKS.map(function (s) { return s.t; }) : [I.stock];
    var rows = ts.map(function (t) { return projectStock(t, I); });
    var tot = {};
    ['dayPrem', 'dayBase', 'dayUplift', 'dayLoss', 'dayProfit', 'nightPrem', 'nightUplift', 'nightLoss', 'nightProfit', 'tail', 'badNight', 'reserve', 'reserveTarget', 'reservePays', 'capitalPays', 'profit', 'insShares'].forEach(function (k) {
      tot[k] = rows.reduce(function (a, r) { return a + r[k]; }, 0);
    });
    ['normal', 'surge', 'wait'].forEach(function (k) { tot[k] = rows.reduce(function (a, r) { return a + r.f[k]; }, 0); });
    tot.perShare = tot.insShares ? tot.profit / tot.insShares : 0;
    return { rows: rows, tot: tot, I: I };
  }

  /* ---------------- inputs ---------------- */
  var DEF = { users: 1000, stock: 'MOON', shares: 100, cushion: 0, hours: 6.5, overnight: false, news: 0, fullDay: 50, surgePct: 50, coverage: 1 };
  var I;
  try { I = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { I = Object.assign({}, DEF); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(I)); } catch (e) {} }

  // users slider is log-scaled: 0..1000 -> 1..1,000,000
  var FIELDS = [
    { k: 'users', label: 'Users turning insurance on', min: 1, max: 1000000, step: 1, log: true, fmt: function (v) { return v.toLocaleString(); } },
    { k: 'shares', label: 'Shares per user (per stock)', min: 1, max: 5000, step: 1 },
    { k: 'cushion', label: 'Cushion below price (K = S × (1 − c))', min: 0, max: 20, step: 0.5, unit: '%' },
    { k: 'hours', label: 'Hours insured per trading day', min: 0, max: 6.5, step: 0.25, unit: 'h' },
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
      '<p class="pj-intro">Playground for the draft v3 pricing (capacity, waiting line, surge, overnight). All inputs and prices are simulated examples, not forecasts.</p>' +
      '<div class="pj-card"><h3 class="pj-h">Inputs</h3>' +
      '<div class="pj-field"><div class="pj-flabel"><span>Stock</span></div>' + segHtml('stock', [['COP', 'COP'], ['WMT', 'WMT'], ['NVDA', 'NVDA'], ['MOON', 'MOON'], ['ALL', 'All four']]) + '</div>' +
      FIELDS.slice(0, 4).map(fieldHtml).join('') +
      '<div class="pj-field" id="pj-coverage"><div class="pj-flabel"><span>Coverage length (share of trading day held)</span></div>' +
      segHtml('coverage', COVERAGE_OPTS.map(function (c) { return [c, Math.round(c * 100) + '%']; })) +
      '<div class="pj-sub pj-covnote" id="pj-covnote">' + covNote() + '</div></div>' +
      '<div class="pj-field"><div class="pj-flabel"><span>Include overnight coverage</span></div>' + segHtml('overnight', [[false, 'No'], [true, 'Yes']]) + '</div>' +
      FIELDS.slice(4).map(fieldHtml).join('') +
      '<div class="pj-sub pj-exercise">Optional exercise: the cushion (K) is only the line where users <b>may</b> cash in. Nothing is sold automatically, and users can keep insurance on indefinitely.</div>' +
      '<button class="pj-btn ghost" data-pact="reset">Reset inputs</button></div>' +
      '<div id="pj-out">' + outHtml() + '</div></div>';
  }

  function covNote() {
    var cov = +I.coverage || 1, h = I.hours * cov;
    return 'Applies to the trading-session hours above: covered time = ' + I.hours + ' h × ' + Math.round(cov * 100) + '% = ' +
      (Math.round(h * 100) / 100) + ' h (' + Math.round(h * 60) + ' billed min). Premium scales linearly with billed minutes; expected payouts scale with √time. ' +
      'Overnight stays a separate nightly price and is not affected' + (cov < 1 ? '; the 10% full-24h discount needs 100% coverage.' : '.');
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
      kpi('Premium / day', money(T.dayPrem), 'incl. ' + money(T.dayUplift) + ' surge uplift · ' + num(rows[0].m) + ' covered min') +
      kpi('Premium / night', I.overnight ? money(T.nightPrem) : '—', I.overnight ? 'lump, 1 night' : 'overnight off') +
      kpi('Expected payouts', money(T.dayLoss + T.nightLoss), 'day ' + money(T.dayLoss) + (I.overnight ? ' · night ' + money(T.nightLoss) : '')) +
      kpi('Expected profit / day', signed(T.dayProfit), null, cls(T.dayProfit)) +
      kpi('Expected profit / night', I.overnight ? signed(T.nightProfit) : '—', null, cls(T.nightProfit)) +
      kpi('Expected profit / share', signed(T.perShare, 4), 'per insured share, day + night', cls(T.perShare)) +
      kpi('Reserve (surge uplift)', money(T.reserve), 'target ' + money(T.reserveTarget) + ' (20% drop on surge shares)') +
      kpi('1-in-20 bad gap loss', I.overnight ? '−' + money(T.tail) : '—', I.overnight ? '95th-pct overnight gap, all insured shares' : 'turn overnight on') +
      '</div><div class="pj-row pj-sub" style="margin-top:8px"><span>Users: ' + num(T.normal) + ' normal · ' + num(T.surge) + ' surge · ' + num(T.wait) + ' waiting</span></div></div>';
    if (multi) {
      h += '<div class="pj-card"><h3 class="pj-h">Per stock <span class="pj-mini">Projection — demo inputs</span></h3><div class="pj-table"><div class="pj-tr pj-th"><span>Stock</span><span>Base $/min</span><span>Prem/day</span><span>Loss</span><span>Profit</span></div>' +
        rows.map(function (r) { return '<div class="pj-tr"><span><b>' + r.t + '</b></span><span>' + money(r.base, 3) + '</span><span>' + money(r.dayPrem + r.nightPrem) + '</span><span>' + money(r.dayLoss + r.nightLoss) + '</span><span class="' + cls(r.profit) + '">' + signed(r.profit) + '</span></div>'; }).join('') +
        '<div class="pj-tr pj-tot"><span><b>Total</b></span><span></span><span>' + money(T.dayPrem + T.nightPrem) + '</span><span>' + money(T.dayLoss + T.nightLoss) + '</span><span class="' + cls(T.profit) + '">' + signed(T.profit) + '</span></div></div>' +
        '<div class="pj-sub">Night premium and loss are included in Prem/day and Loss when overnight is on.</div></div>';
    }
    // breakdown
    h += '<div class="pj-card" id="pj-breakdown"><h3 class="pj-h">Breakdown <span class="pj-mini">Projection — demo inputs</span></h3>' + rows.map(function (r) {
      var b = r.b;
      return '<div class="pj-bd"><div class="pj-bdh">' + r.t + ' · S ' + money(r.S, 2) + ' · K ' + money(r.K, 2) + ' · ' + r.n + ' sh/user</div>' +
        '<div class="pj-formula">Base = clamp(0.0029 × E ' + money(b.E, 2) + ' × L ' + b.L.toFixed(3) + ' × (1+3×' + I.news.toFixed(2) + '), $0.02, $6) = ' + money(r.base, 4) + '/min' + (b.clampedTo ? ' (' + b.clampedTo + ')' : '') + '</div>' +
        line('Base rate × covered minutes × insured users', money(r.base, 4) + ' × ' + num(r.m) + (r.cov < 1 ? ' (' + num(r.mFull) + ' × ' + Math.round(r.cov * 100) + '%)' : '') + ' × ' + num(r.insured)) +
        line('× full-day discount factor (base only)', r.dfac.toFixed(3) + (r.discEligible ? '' : ' (needs overnight + 6.5 h + 100% coverage)')) +
        line('= base premium / day', money(r.dayBase)) +
        line('+ surge uplift (Base × (M−1) × min) → reserve', money(r.dayUplift)) +
        line('= premium / day', money(r.dayPrem), 'em') +
        line('− expected payouts / day (G(z), σ ∝ √' + (Math.round(r.m / 60 * 100) / 100) + ' h covered)', '−' + money(r.dayLoss)) +
        line('= expected profit / day', '<span class="' + cls(r.dayProfit) + '">' + signed(r.dayProfit) + '</span>', 'em') +
        (I.overnight ?
          line('Night price / policy = 1.12 × E_night ' + money(r.np.E, 2) + ' × L × (1+3H)', money(r.np.premium, 2) + ' (≈ ' + money(r.np.perHour, 2) + '/h from close)') +
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
      '<li>σ₁ = σ_annual / √(252·390) (blended, no EWMA). Base rate via rate.js; L uses each user\'s own N (not total demand).</li>' +
      '<li>All users arrive at once, FIFO, identical orders. Open band (u &lt; 0.90): fill if it fits; near cap: fill only if it fits and ≤ 0.5% of Q_max; otherwise the chosen % pay surge (M fixed at the u they bought at; 2.0× if u &lt; 1) and the rest wait. No surge fill may push u above 1.25.</li>' +
      '<li>"All four": every user insures the chosen shares in each stock; each stock has its own pool. Totals add stocks; the bad-gap total assumes all four gap down together.</li>' +
      '<li>Expected loss uses the md\'s normal model: N·S·σ·G(z) with σ = σ₁·√(minutes insured) by day and σ_gap = σ_annual/√252 (= IM/0.798) overnight. News is assumed to raise realized vol by (1+H) for losses; the premium uses (1+3H).</li>' +
      '<li>Overnight = one normal weeknight (T_c 17.5 h, no event), option (a) lump premium, capped at $360/h × 17.5 h before surge. No floor overnight.</li>' +
      '<li>10% off applies to base (day and night) only, and only when overnight is on, hours = 6.5 and coverage = 100%, since D needs an unbroken 24 h block.</li>' +
      '<li>Coverage length: insured users hold coverage for 25/50/75/100% of the insured session hours. Premium (base and surge uplift) is linear in billed minutes; expected payouts use σ₁·√(covered minutes), so they shrink only with √time — partial-day coverage earns proportionally less premium than it saves in payouts and can look underpriced. The pricing formula itself is unchanged. Overnight price, tail and reserve target are not scaled.</li>' +
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
    if (f.k === 'users' || f.k === 'shares') v = Math.round(v);
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
      var k = s.dataset.pseg, v = s.dataset.pv; I[k] = k === 'overnight' ? v === 'true' : k === 'coverage' ? +v : v;
      s.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === s); });
      var cn = document.getElementById('pj-covnote'); if (cn) cn.innerHTML = covNote();
      refresh(); return;
    }
    var a = e.target.closest('[data-pact="reset"]');
    if (a) { I = Object.assign({}, DEF); save(); var root = document.getElementById('pj-root'); if (root) root.outerHTML = view(); }
  });

  g.PCProjections = { view: view, project: project, projectStock: projectStock, fill: fill, surgeMultiplier: surgeMultiplier, nightPremium: nightPremium, inputs: function () { return I; }, constants: P, coverageOptions: COVERAGE_OPTS };
})(window);
