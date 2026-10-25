/* Paracord DEMO data. Holdings and accounts are simulated. Stock reference data comes from data/universe.js,
 * a DEMO SNAPSHOT AS OF OCT 23, 2026 built offline by tools/build-universe.py (not live data; see its notes).
 * MOON is a fictional demo stock; its numbers are assumptions. */
(function (g) {
  var U = g.PC_UNIVERSE || { stocks: [], label: 'demo snapshot (missing)', as_of: '' };
  g.PC_SNAPSHOT_LABEL = U.label;                       // 'demo snapshot, as of Oct 23, 2026'
  /* sim/rate definition for one universe record:
   *  p0 = snapshot price (the random walk starts and mean-reverts here)
   *  vol = 63-day realized vol (drives the walk); vol20 = 20-day realized vol (floor under the sim's EWMA "recent" vol)
   *  iv / iv_base / earn / earn_move = options-implied vol inputs for the p9 lock vol (rate.js lockVol)
   *  float = SEC shares outstanding (float proxy), adv = average daily share volume, addv = average daily $ volume
   *  a, c = market / own-sector factor loadings for the correlated sim */
  function def(r) {
    return { t: r.t, name: r.name, sector: r.sector, p0: r.px, px: r.px, vol: r.rv63, vol20: r.rv20, rv20: r.rv20, rv1y: r.rv1y,
      iv: r.iv, iv_base: r.iv_base, iv_src: r.iv_src, iv_win: r.iv_win, earn: r.earn, earn_move: r.earn_move, earn_timing: r.earn_timing, earn_implied: r.earn_implied, earn_hist: r.earn_hist,
      float: r.float, adv: r.adv_sh, adv_sh: r.adv_sh, addv: r.addv, liq: r.liq, a: r.a, c: r.c, w: r.w,
      est: r.est || [], fictional: !!r.fictional, color: '#111111' };
  }
  g.PC_UNIVERSE_DEFS = U.stocks.map(def);
  var BY = {}; g.PC_UNIVERSE_DEFS.forEach(function (d) { BY[d.t] = d; });
  g.PC_UNIVERSE_BY_T = BY;
  // The four demo tickers shown in the app (Stage 0 keeps the p8 set; the full list is engine-only until Stage 1).
  var TAGS = { COP: 'Energy', WMT: 'Staples', NVDA: 'Tech', MOON: 'Volatile' };
  g.PC_STOCKS = ['COP', 'WMT', 'NVDA', 'MOON'].filter(function (t) { return BY[t]; }).map(function (t) {
    var d = BY[t]; d.tag = TAGS[t]; return d;
  });
  // Demo brokerages. Logos are just colored initials — no real links.
  g.PC_BROKERS = [
    { id: 'robinhood', name: 'Robinhood', short: 'RH', color: '#2b2b2b', demo: [['COP', 40], ['MOON', 300]] },
    { id: 'fidelity',  name: 'Fidelity',  short: 'FI', color: '#2b2b2b', demo: [['WMT', 60], ['NVDA', 25]] },
    { id: 'schwab',    name: 'Charles Schwab', short: 'CS', color: '#2b2b2b', demo: [['COP', 20], ['WMT', 15]] },
    { id: 'vanguard',  name: 'Vanguard',  short: 'VG', color: '#2b2b2b', demo: [['WMT', 30], ['NVDA', 10]] },
    { id: 'etrade',    name: 'E*TRADE',   short: 'ET', color: '#2b2b2b', demo: [['MOON', 100], ['COP', 10]] },
    { id: 'webull',    name: 'Webull',    short: 'WB', color: '#2b2b2b', demo: [['MOON', 150], ['NVDA', 5]] }
  ];
  g.PC_DEFAULT_LINKED = ['robinhood', 'fidelity'];
  // tabs1: large demo portfolio for the consumer Portfolio tab - every other name in the demo universe (503 S&P names + MOON),
  // split between the two default linked accounts. Share counts are DEMO values: a deterministic hash of the ticker gives a
  // position of roughly $300-$15,000 at the snapshot price (at least 1 share). Not real holdings.
  function hash(t) { var h = 2166136261; for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  var have = {}; g.PC_BROKERS.forEach(function (b) { if (g.PC_DEFAULT_LINKED.indexOf(b.id) >= 0) b.demo.forEach(function (h) { have[h[0]] = 1; }); });
  g.PC_BIG_PORTFOLIO = [];
  g.PC_UNIVERSE_DEFS.forEach(function (d) {
    if (have[d.t] || !(d.p0 > 0)) return;
    var h = hash(d.t), target = 300 * Math.pow(50, (h % 1000) / 1000), sh = Math.max(1, Math.round(target / d.p0));
    var acct = (h >>> 10) % 2 ? 'robinhood' : 'fidelity';
    g.PC_BIG_PORTFOLIO.push([d.t, sh, acct]);
  });
  g.PC_BIG_PORTFOLIO.forEach(function (x) { g.PC_BROKERS.forEach(function (b) { if (b.id === x[2]) b.demo.push([x[0], x[1]]); }); });
})(window);
