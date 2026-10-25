/* Paracord DEMO price simulator — correlated random walk, NOT market data.
 * p9: factor model. Each 1-second tick is ~1 trading minute of variance (demo acceleration). A name's return is
 *   r_i = sigma_i,min * regime * (a_i * Z_mkt + c_i * Z_sector(i) + sqrt(1 - a_i^2 - c_i^2) * eps_i) - sigma^2/2 + pull + scenario
 * with a, c = market / own-sector loadings fitted on 2 years of daily returns (data/universe.js), so a market shock moves
 * every name together (by its loading) instead of independently. A shared market regime gives vol clustering.
 * Scenario: setScenario(x) drifts the market factor toward an x-sigma daily index move (x < 0 = sell-off); each name
 * moves by its regression-implied share a_i * x * (its own daily sigma), eased in over ~15 ticks. */
(function (g) {
  var TICKS_PER_YEAR = 252 * 390; // 1 tick ≈ 1 trading minute (demo acceleration)
  var VOL_WINDOW = 60, HIST = 180;
  var LAMBDA = Math.pow(0.5, 1 / 30); // EWMA decay for a 30-tick (≈30 sim-minute) half-life

  function randn() {
    var u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** stocks: defs { t, p0, vol, vol20, a, c, sector }. opts.histFor: tickers that keep a price history (default all). */
  function Sim(stocks, startPrices, opts) {
    opts = opts || {};
    this.s = {}; this.list = []; this.mktRegime = 1; this.scenario = 0; this.sectors = {};
    var self = this, keep = opts.histFor ? {} : null;
    if (keep) opts.histFor.forEach(function (t) { keep[t] = 1; });
    stocks.forEach(function (d) {
      var a = d.a != null ? +d.a : 0.45, c = d.c != null ? +d.c : 0.25, e2 = Math.max(0.0009, 1 - a * a - c * c);
      var st = { def: d, a: a, c: c, e: Math.sqrt(e2), sec: d.sector || 'Other', price: (startPrices && startPrices[d.t]) || d.p0,
        hist: [], rets: [], regime: 1, scen: 0, keep: !keep || !!keep[d.t] };
      self.sectors[st.sec] = 0;
      // seed history backwards so charts/vol are populated on load (idiosyncratic only; history is cosmetic)
      var p = st.price, back = [p], sig = d.vol / Math.sqrt(TICKS_PER_YEAR);
      st.ewVar = sig * sig;
      var n = st.keep ? HIST - 1 : VOL_WINDOW;
      for (var i = 0; i < n; i++) { var r = sig * randn() - 0.5 * sig * sig; p = p / Math.exp(r); back.unshift(p); }
      for (var k = 1; k < back.length; k++) { var rr = Math.log(back[k] / back[k - 1]); st.rets.push(rr); st.ewVar = LAMBDA * st.ewVar + (1 - LAMBDA) * rr * rr; }
      st.rets = st.rets.slice(-VOL_WINDOW);
      st.hist = st.keep ? back : [st.price];
      self.s[d.t] = st; self.list.push(st);
    });
  }
  Sim.prototype.setScenario = function (x) { this.scenario = +x || 0; };
  Sim.prototype.step = function () {
    this.mktRegime = Math.min(1.6, Math.max(0.6, this.mktRegime + 0.08 * (1 - this.mktRegime) + 0.05 * randn()));
    var zm = randn(), zs = {}, sc = this.scenario;
    for (var k in this.sectors) zs[k] = randn();
    for (var i = 0; i < this.list.length; i++) {
      var st = this.list[i], d = st.def;
      st.regime = Math.min(1.5, Math.max(0.7, st.regime + 0.08 * (1 - st.regime) + 0.04 * randn()));
      var sig = d.vol / Math.sqrt(TICKS_PER_YEAR) * this.mktRegime * st.regime;
      var z = st.a * zm + st.c * zs[st.sec] + st.e * randn();
      // scenario: eased drift toward a_i * x * daily sigma_i (regression-implied move for an x-sigma market day)
      var target = st.a * sc * d.vol / Math.sqrt(252), dr = (target - st.scen) * 0.15; st.scen += dr;
      var pull = 0.003 * (Math.log(d.p0 / st.price) + st.scen);  // mild mean reversion toward p0 x scenario shift
      var np = Math.max(0.5, st.price * Math.exp(sig * z - 0.5 * sig * sig + pull + dr));
      var lr = Math.log(np / st.price);
      st.rets.push(lr); if (st.rets.length > VOL_WINDOW) st.rets.shift();
      st.ewVar = LAMBDA * st.ewVar + (1 - LAMBDA) * lr * lr;
      st.price = np;
      if (st.keep) { st.hist.push(np); if (st.hist.length > HIST) st.hist.shift(); }
    }
  };
  Sim.prototype.vol = function (t) {
    var r = this.s[t].rets, n = r.length;
    if (n < 2) return this.s[t].def.vol;
    var m = 0; for (var i = 0; i < n; i++) m += r[i]; m /= n;
    var v = 0; for (var k = 0; k < n; k++) v += (r[k] - m) * (r[k] - m); v /= (n - 1);
    return Math.sqrt(v) * Math.sqrt(TICKS_PER_YEAR);
  };
  /** per-minute sigma_1 of RECENT REALIZED vol: EWMA, floored at the 20-day realized vol / sqrt(252*390) */
  Sim.prototype.sigma1 = function (t) {
    var st = this.s[t], floor = st.def.vol20 / Math.sqrt(TICKS_PER_YEAR);
    return Math.max(Math.sqrt(st.ewVar), floor);
  };
  /** recent realized vol, annualised (the "recent" leg of the p9 lock vol) */
  Sim.prototype.recentVol = function (t) { return this.sigma1(t) * Math.sqrt(TICKS_PER_YEAR); };
  Sim.prototype.sigma1Floored = function (t) {
    var st = this.s[t]; return Math.sqrt(st.ewVar) < st.def.vol20 / Math.sqrt(TICKS_PER_YEAR);
  };
  Sim.TICKS_PER_YEAR = TICKS_PER_YEAR;
  Sim.prototype.price = function (t) { return this.s[t].price; };
  Sim.prototype.hist = function (t) { return this.s[t].hist; };
  Sim.prototype.has = function (t) { return !!this.s[t]; };
  g.PCSim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
