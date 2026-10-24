/* Paracord DEMO data — all prices, holdings and accounts are simulated. */
(function (g) {
  g.PC_STOCKS = [
    // p0 = simulated start price; vol = simulated annualized vol driving the random walk;
    // vol20 = simulated "20-day" annualized vol used for the sigma_1 floor;
    // float (F) and adv (ADV) are simulated, plausible-looking, NOT sourced data.
    { t: 'COP',  name: 'ConocoPhillips',  p0: 104.80, vol: 0.18, vol20: 0.17, float: 1.2e9, adv: 6e6,   tag: 'Calm',     color: '#ef6c3a' },
    { t: 'WMT',  name: 'Walmart',          p0: 98.40,  vol: 0.22, vol20: 0.20, float: 4.4e9, adv: 15e6,  tag: 'Calm-ish', color: '#2f7cf6' },
    { t: 'NVDA', name: 'NVIDIA',           p0: 182.50, vol: 0.50, vol20: 0.45, float: 23e9,  adv: 200e6, tag: 'Moderate', color: '#76b900' },
    { t: 'MOON', name: 'Moonshot Labs (fictional demo ticker)', p0: 24.20, vol: 1.50, vol20: 1.35, float: 5e7, adv: 2e6, tag: 'Volatile', color: '#c04cfd' }
  ];
  // Demo brokerages. Logos are just colored initials — no real links.
  g.PC_BROKERS = [
    { id: 'robinhood', name: 'Robinhood', short: 'RH', color: '#00c805', demo: [['COP', 40], ['MOON', 300]] },
    { id: 'fidelity',  name: 'Fidelity',  short: 'FI', color: '#4a8f2e', demo: [['WMT', 60], ['NVDA', 25]] },
    { id: 'schwab',    name: 'Charles Schwab', short: 'CS', color: '#00a0df', demo: [['COP', 20], ['WMT', 15]] },
    { id: 'vanguard',  name: 'Vanguard',  short: 'VG', color: '#a8232c', demo: [['WMT', 30], ['NVDA', 10]] },
    { id: 'etrade',    name: 'E*TRADE',   short: 'ET', color: '#7a4dd8', demo: [['MOON', 100], ['COP', 10]] },
    { id: 'webull',    name: 'Webull',    short: 'WB', color: '#1b5cff', demo: [['MOON', 150], ['NVDA', 5]] }
  ];
  g.PC_DEFAULT_LINKED = ['robinhood', 'fidelity'];
})(window);
