/* Paracord DEMO price simulator — geometric random walk, NOT market data.
 * Each 1-second tick is treated as ~1 trading minute of variance so the
 * moves are visible in a demo. Realized vol is annualized accordingly. */
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

  function Sim(stocks, startPrices) {
    this.s = {};
    var self = this;
    stocks.forEach(function (d) {
      var st = { def: d, price: (startPrices && startPrices[d.t]) || d.p0, hist: [], rets: [], regime: 1 };
      // seed history backwards-looking so charts/vol are populated on load
      var p = st.price, back = [p];
      for (var i = 0; i < HIST - 1; i++) { p = p / Math.exp(self._ret(st, p)); back.unshift(p); }
      st.hist = back;
      for (var j = 1; j < back.length; j++) st.rets.push(Math.log(back[j] / back[j - 1]));
      st.rets = st.rets.slice(-VOL_WINDOW);
      // EWMA of 1-min log returns, half-life ~30 min (paracord-pricing-v1.md)
      st.ewVar = Math.pow(d.vol / Math.sqrt(TICKS_PER_YEAR), 2);
      for (var k = 1; k < back.length; k++) { var rr = Math.log(back[k] / back[k - 1]); st.ewVar = LAMBDA * st.ewVar + (1 - LAMBDA) * rr * rr; }
      self.s[d.t] = st;
    });
  }
  Sim.prototype._ret = function (st, price) {
    st.regime = Math.min(1.6, Math.max(0.6, st.regime + 0.08 * (1 - st.regime) + 0.06 * randn()));
    var sig = st.def.vol / Math.sqrt(TICKS_PER_YEAR) * st.regime;
    var pull = 0.003 * Math.log(st.def.p0 / price); // mild mean reversion so the demo stays plausible
    return sig * randn() - 0.5 * sig * sig + pull;
  };
  Sim.prototype.step = function () {
    for (var t in this.s) {
      var st = this.s[t];
      var r = this._ret(st, st.price);
      var np = Math.max(0.5, st.price * Math.exp(r));
      var lr = Math.log(np / st.price);
      st.rets.push(lr);
      st.ewVar = LAMBDA * st.ewVar + (1 - LAMBDA) * lr * lr;
      if (st.rets.length > VOL_WINDOW) st.rets.shift();
      st.price = np;
      st.hist.push(np);
      if (st.hist.length > HIST) st.hist.shift();
    }
  };
  Sim.prototype.vol = function (t) {
    var r = this.s[t].rets, n = r.length;
    if (n < 2) return this.s[t].def.vol;
    var m = 0; for (var i = 0; i < n; i++) m += r[i]; m /= n;
    var v = 0; for (var k = 0; k < n; k++) v += (r[k] - m) * (r[k] - m); v /= (n - 1);
    return Math.sqrt(v) * Math.sqrt(TICKS_PER_YEAR);
  };
  /** per-minute sigma_1: EWMA, floored at (20-day daily vol)/sqrt(390) = vol20/sqrt(252*390) */
  Sim.prototype.sigma1 = function (t) {
    var st = this.s[t], floor = st.def.vol20 / Math.sqrt(TICKS_PER_YEAR);
    return Math.max(Math.sqrt(st.ewVar), floor);
  };
  Sim.prototype.sigma1Floored = function (t) {
    var st = this.s[t]; return Math.sqrt(st.ewVar) < st.def.vol20 / Math.sqrt(TICKS_PER_YEAR);
  };
  Sim.TICKS_PER_YEAR = TICKS_PER_YEAR;
  Sim.prototype.price = function (t) { return this.s[t].price; };
  Sim.prototype.hist = function (t) { return this.s[t].hist; };
  g.PCSim = Sim;
})(window);
