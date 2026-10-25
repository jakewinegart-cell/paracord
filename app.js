/* Paracord — DEMO app logic. Simulated prices only; no real accounts, trades or market data. */
(function () {
  'use strict';
  var STOCKS = window.PC_STOCKS, BROKERS = window.PC_BROKERS;
  var BY_T = {}; STOCKS.forEach(function (s) { BY_T[s.t] = s; });
  var BY_B = {}; BROKERS.forEach(function (b) { BY_B[b.id] = b; });
  var KEY = 'paracord-demo-v2';
  var DAY = 24 * 3600 * 1000, MIN = 60000;
  var NEWS_TAU_MIN = 20, NEWS_WINDOW_MIN = 30; // per paracord-pricing-v1.md

  /* ---------------- state ---------------- */
  function freshState() {
    var holdings = [];
    window.PC_DEFAULT_LINKED.forEach(function (id) { BY_B[id].demo.forEach(function (h) { holdings.push({ acct: id, t: h[0], sh: h[1] }); }); });
    return { v: 2, linked: window.PC_DEFAULT_LINKED.slice(), holdings: holdings, ins: {}, news: {}, clock: { offset: 0, speed: 1 }, px: {}, open: {}, receipts: [] };
  }
  var state;
  try { state = JSON.parse(localStorage.getItem(KEY)) || freshState(); } catch (e) { state = freshState(); }
  if (state.v !== 2) state = freshState();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  if (!state.conf) state.conf = { target: 0, mood: 0, open: null };
  var confHist = [], confNoise = 0, confLast = null;
  var sim = new window.PCSim(STOCKS, state.px);
  STOCKS.forEach(function (s) { if (!state.open[s.t]) state.open[s.t] = sim.hist(s.t)[0]; });

  var lastReal = Date.now();
  function simNow() { return Date.now() + state.clock.offset; }

  /* ---------------- derived ---------------- */
  function sharesOf(t) { return state.holdings.reduce(function (a, h) { return a + (h.t === t && state.linked.indexOf(h.acct) >= 0 ? h.sh : 0); }, 0); }
  function acctsOf(t) { var o = []; state.holdings.forEach(function (h) { if (h.t === t && h.sh > 0 && state.linked.indexOf(h.acct) >= 0 && o.indexOf(h.acct) < 0) o.push(h.acct); }); return o; }
  function heldTickers() { return STOCKS.filter(function (s) { return sharesOf(s.t) > 0; }); }
  function chg(t) { var o = state.open[t], p = sim.price(t); return (p - o) / o; }
  function annVol(t) { return sim.sigma1(t) * Math.sqrt(window.PCSim.TICKS_PER_YEAR); }

  /** H_t: max over the last 30 sim-min of severity x relevance x e^(-age/20 min) */
  function newsScore(t) {
    var now = simNow(), h = 0;
    (state.news[t] || []).forEach(function (e) {
      var age = (now - e.at) / MIN;
      if (age >= 0 && age <= NEWS_WINDOW_MIN) h = Math.max(h, e.sev * e.rel * Math.exp(-age / NEWS_TAU_MIN));
    });
    return Math.min(1, h);
  }
  function rateInputs(t, opt) {
    var d = BY_T[t], ins = state.ins[t];
    opt = opt || {};
    return {
      price: sim.price(t), shares: opt.shares != null ? opt.shares : (ins ? ins.shares : sharesOf(t)),
      lockIn: opt.lockIn != null ? opt.lockIn : (ins ? ins.lockIn : sim.price(t)),
      sigma1: sim.sigma1(t), float: d.float, adv: d.adv, news: newsScore(t),
      inCompletedDayBlock: false, // D_t applied as a rebate at block end (see accrue)
      elapsedMs: ins ? simNow() - ins.enabledAt : 0
    };
  }
  function breakdown(t, opt) { return window.insuranceRateBreakdown(rateInputs(t, opt)); }
  function rateOf(t, opt) { return window.insuranceRatePerMinute(rateInputs(t, opt)); }

  /* ---------------- insurance ---------------- */
  function enableIns(t) {
    var n = sharesOf(t); if (!n) return;
    var now = simNow();
    state.ins[t] = { lockIn: sim.price(t), shares: n, enabledAt: now, lastAt: now, cost: 0, blockStart: now, blockCost: 0, blocksDone: 0, rebates: 0 };
    save();
  }
  function disableIns(t) { var c = state.ins[t] ? state.ins[t].cost : 0; delete state.ins[t]; save(); toast('Insurance off · total demo cost ' + money(c)); }

  function accrue() {
    var now = simNow();
    Object.keys(state.ins).forEach(function (t) {
      var ins = state.ins[t];
      ins.shares = Math.min(ins.shares, sharesOf(t));
      if (ins.shares <= 0) { delete state.ins[t]; return; }
      var rate = rateOf(t); // $/min, D_t = 1 while the current 24h block is open
      var from = ins.lastAt;
      while (from < now) {
        var blockEnd = ins.blockStart + DAY, to = Math.min(now, blockEnd);
        var c = rate * (to - from) / MIN;
        ins.cost += c; ins.blockCost += c;
        if (to >= blockEnd) { // completed, unbroken 24h block -> D_t = 0.90 on that block (10% rebate)
          var reb = ins.blockCost * (1 - window.PARACORD_RATE_CONSTANTS.D_full_day);
          ins.cost -= reb; ins.rebates += reb; ins.blocksDone++;
          ins.blockStart = blockEnd; ins.blockCost = 0;
          if (ins.blocksDone === 1) toast('🎉 24h insured — 10% off earned (' + money(reb) + ' demo rebate)');
        }
        from = to;
      }
      ins.lastAt = now;
    });
  }

  /* ---------------- formatting ---------------- */
  function money(n, d) { if (d == null) d = Math.abs(n) < 1 && n !== 0 ? 4 : 2; var s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); return (n < 0 ? '−$' : '$') + s; }
  function rateStr(r) { return money(r, r < 1 ? 3 : 2) + '/min'; }
  function pct(x) { return (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + '%'; }
  function signed(n) { return (n >= 0 ? '+' : '−') + money(Math.abs(n), 2); }
  function cls(x) { return x >= 0 ? 'up' : 'down'; }
  function dur(ms) { ms = Math.max(0, ms); var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + String(ss).padStart(2, '0') + 's'; }
  function big(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : n.toLocaleString(); }
  function bb(id, sm) { var b = BY_B[id]; return '<span class="bb' + (sm ? ' sm' : '') + '"><i style="background:' + b.color + '">' + b.short + '</i>' + b.name + '</span>'; }
  function tk(t) { return '<div class="tk" style="background:' + BY_T[t].color + '">' + t + '</div>'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- router (history.pushState so Android Back works) ---------------- */
  var route = { view: 'home' };
  var ROOTS = ['home', 'insured', 'accounts', 'demo', 'projections'];
  var doneFlows = {};
  function hashOf(r) { return '#/' + r.view + (r.t ? '/' + r.t : '') + (r.step ? '/' + r.step : '') + (r.sheet ? '?sheet=' + r.sheet : ''); }
  function go(r) { history.pushState(r, '', hashOf(r)); route = r; render(); }
  function replace(r) { history.replaceState(r, '', hashOf(r)); route = r; render(); }
  function openSheet(name, extra) { var r = Object.assign({}, route, { sheet: name }, extra || {}); r.sheetDepth = (route.sheet ? (route.sheetDepth || 1) : 0) + 1; go(r); }
  function tab(v) {
    if (route.view === v && !route.sheet) return;
    var r = { view: v };
    if (ROOTS.indexOf(route.view) >= 0 && route.view !== 'home' && !route.sheet) replace(r); else go(r);
  }
  window.addEventListener('popstate', function (e) { route = e.state || { view: 'home' }; render(); });

  /* ---------------- rendering ---------------- */
  var $view = document.getElementById('view'), $sheet = document.getElementById('sheetRoot');
  function render() {
    if (route.view === 'cashout' && route.step !== 'receipt' && doneFlows[route.flow]) { history.back(); return; }
    var isRoot = ROOTS.indexOf(route.view) >= 0;
    document.getElementById('backBtn').hidden = isRoot;
    document.getElementById('brand').style.display = isRoot ? '' : 'none';
    var title = '';
    var html;
    switch (route.view) {
      case 'stock': html = viewStock(route.t); title = route.t + ' · ' + BY_T[route.t].name.replace(/ \(.*\)/, ''); break;
      case 'cashout': html = viewCashout(); title = route.step === 'receipt' ? 'Receipt' : route.step === 'confirm' ? 'Confirm cash-out' : 'Cash out ' + route.t; break;
      case 'insured': html = viewInsured(); break;
      case 'accounts': html = viewAccounts(); break;
      case 'demo': html = viewDemo(); break;
      case 'projections': html = window.PCProjections ? window.PCProjections.view() : ''; break;
      default: html = viewHome();
    }
    document.getElementById('title').textContent = title;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === route.view); });
    document.getElementById('tabs').style.display = (route.view === 'cashout') ? 'none' : '';
    $view.innerHTML = html;
    $sheet.innerHTML = route.sheet ? '<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true">' + '<div class="grab"></div>' + renderSheet() + '</div></div>' : '';
    if (!render.noScroll) window.scrollTo(0, 0);
    render.noScroll = false;
    live();
  }

  function stockRow(s) {
    var t = s.t, on = !!state.ins[t];
    return '<button class="stock" data-act="open-stock" data-t="' + t + '">' + tk(t) +
      '<div style="min-width:0"><div class="nm">' + t + ' <span class="muted small" data-live="shares:' + t + '">' + sharesOf(t) + ' sh</span></div>' +
      '<div class="sub">' + esc(s.name.replace(/ \(.*\)/, '')) + ' · ' + s.tag + '</div>' +
      '<div class="badges" style="margin-top:4px">' + acctsOf(t).map(function (a) { return bb(a, true); }).join('') + '</div></div>' +
      '<svg width="76" height="32" viewBox="0 0 76 32"><polyline data-live="spark:' + t + '" fill="none" stroke-width="2" points=""/></svg>' +
      '<div class="px"><div style="font-weight:700" data-live="price:' + t + '"></div><div class="small" data-live="chg:' + t + '"></div>' +
      '<div class="small muted" data-live="value:' + t + '"></div><span class="ins ' + (on ? 'on' : 'off') + '">' + (on ? '⛨ INSURED' : 'UNINSURED') + '</span></div></button>';
  }

  function viewHome() {
    var held = heldTickers();
    return '<div class="card hero"><div class="small" style="opacity:.8">Total holdings (simulated)</div><div class="big" data-live="total"></div>' +
      '<div class="row between small" style="margin-top:8px"><span>Protected: <b data-live="protected"></b></span><span>Insurance: <b data-live="totalrate"></b></span></div></div>' +
      confCard() +
      '<div class="card"><div class="row between"><h3 style="margin:0">Linked accounts</h3><button class="btn sm ghost" data-act="link">+ Link account</button></div>' +
      '<div class="badges" style="margin-top:10px">' + (state.linked.length ? state.linked.map(function (a) { return bb(a); }).join('') : '<span class="muted">No accounts linked</span>') + '</div></div>' +
      '<h3 class="muted small" style="margin:16px 4px 8px;text-transform:uppercase;letter-spacing:.6px">Your stocks · live (simulated)</h3>' +
      (held.length ? held.map(stockRow).join('') : '<div class="card center muted">Link a demo account to see holdings.</div>') +
      '<div class="footer-note">Demo — simulated prices, no real trades. Paracord is a prototype; nothing here is investment or insurance advice.</div>';
  }

  function insuranceCard(t) {
    var ins = state.ins[t], n = sharesOf(t);
    var head = '<div class="row between"><div><div style="font-weight:800;font-size:17px">Paracord insurance</div><div class="small muted">Lock in today\'s price for your ' + n + ' shares</div></div>' +
      '<button class="toggle" role="switch" aria-label="Paracord insurance" aria-checked="' + (!!ins) + '" data-act="toggle-ins" data-t="' + t + '"></button></div>';
    if (!ins) {
      return '<div class="card">' + head + '<div class="ratebox"><div class="small muted">If enabled now (lock-in at current price)</div>' +
        '<div class="rate" style="font-size:26px" data-live="previewrate:' + t + '"></div><div class="small muted">Rate updates live with simulated volatility & news</div></div>' +
        '<div class="small muted">Turning this on sets your lock-in to the current simulated price. You can cash out insured shares to Paracord at the lock-in price any time (demo).</div></div>';
    }
    var S = sim.price(t);
    return '<div class="card">' + head +
      '<div class="grid2" style="margin-top:14px">' +
      '<div class="stat"><div class="k">Lock-in price (K)</div><div class="v" data-live="lock:' + t + '"></div></div>' +
      '<div class="stat"><div class="k">Max protected</div><div class="v" data-live="maxprot:' + t + '"></div><div class="small muted">' + ins.shares + ' sh × lock-in</div></div>' +
      '<div class="stat"><div class="k">Now vs lock-in</div><div class="v" data-live="pl:' + t + '"></div></div>' +
      '<div class="stat"><div class="k">Insured for</div><div class="v" style="font-size:15px" data-live="elapsed:' + t + '"></div></div></div>' +
      '<div style="margin-top:12px"><div class="row between small"><span class="muted">Adjust lock-in K (demo re-lock, K ≤ price)</span><b data-live="kpct:' + t + '"></b></div>' +
      '<input type="range" id="kslider" data-t="' + t + '" min="' + (S * 0.85).toFixed(2) + '" max="' + Math.max(S, ins.lockIn).toFixed(2) + '" step="0.01" value="' + ins.lockIn.toFixed(2) + '" aria-label="Lock-in price slider"></div>' +
      '<div class="ratebox"><div class="row between"><span class="small muted">Live insurance rate</span><span data-live="newspill:' + t + '"></span></div>' +
      '<div class="rate" data-live="rate:' + t + '"></div>' +
      '<div class="small muted" data-live="ratesub:' + t + '"></div>' +
      '<div class="row between" style="margin-top:10px"><span class="small muted">Running cost since enabled</span><b class="num" style="font-size:18px" data-live="cost:' + t + '"></b></div></div>' +
      '<button class="btn ' + (newsScore(t) > 0.01 ? 'ghost' : 'warn') + '" data-act="news" data-t="' + t + '" data-live-btn="news:' + t + '">' + (newsScore(t) > 0.01 ? 'Clear demo news shock' : '⚡ Demo news shock (H → 1)') + '</button>' +
      '</div>' + discountCard(t) + breakdownCard(t) +
      '<button class="btn mint" data-act="cashout" data-t="' + t + '">Cash out at lock-in price</button>';
  }

  function discountCard(t) {
    return '<div class="card"><h3>Full-day discount</h3><div class="row" style="gap:14px">' +
      '<svg class="ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="34" fill="none" stroke="#d6d6d6" stroke-width="9"/>' +
      '<circle data-live="ring:' + t + '" cx="42" cy="42" r="34" fill="none" stroke="#c8102e" stroke-width="9" stroke-linecap="round" transform="rotate(-90 42 42)" stroke-dasharray="213.6" stroke-dashoffset="213.6"/>' +
      '<text data-live="ringpct:' + t + '" x="42" y="47" text-anchor="middle" fill="#111111" font-size="15" font-weight="800"></text></svg>' +
      '<div style="flex:1"><div data-live="discount:' + t + '"></div><div class="small muted" style="margin-top:4px">Keep insurance on for a full, unbroken 24h to get 10% off that day\'s charges (D<sub>t</sub> = 0.90).</div>' +
      '<div class="row" style="margin-top:8px;gap:6px"><button class="btn sm ghost" data-act="skip" data-ms="3600000">⏩ +1h</button><button class="btn sm ghost" data-act="skip" data-ms="' + DAY + '">⏩ +24h</button></div></div></div></div>';
  }

  function breakdownCard(t) {
    return '<div class="card breakdown"><details class="how" open><summary>How this rate is computed</summary>' +
      '<div class="formula">R = clamp(c·E·L·(1+3H), $0.02, $6.00) · D\nc = 0.0029/min · h = 390 min</div>' +
      '<div data-live="breakdown:' + t + '"></div>' +
      '<div class="small muted" style="margin-top:8px">Draft formula v1 (placeholder, rate.js → insuranceRatePerMinute). F and ADV are simulated demo values.</div></details></div>';
  }

  function viewStock(t) {
    var d = BY_T[t], n = sharesOf(t);
    return '<div class="row between"><div><div class="big" data-live="price:' + t + '"></div><div data-live="chg:' + t + '"></div></div>' +
      '<div style="text-align:right"><span class="pill vol">' + d.tag + '</span><div class="small muted" style="margin-top:6px" data-live="vol:' + t + '"></div></div></div>' +
      '<div class="small muted" style="margin:4px 0 10px">Simulated price · updates every second</div>' +
      '<canvas class="chart" id="chart" data-t="' + t + '"></canvas>' +
      '<div class="row small muted" style="margin:6px 2px 12px;gap:14px"><span><span style="color:' + d.color + '">━</span> price (sim)</span>' + (state.ins[t] ? '<span><span style="color:#c8102e">╍</span> lock-in</span>' : '') + '</div>' +
      '<div class="card"><h3>Your holding</h3><div class="grid2"><div class="stat"><div class="k">Shares</div><div class="v">' + n + '</div></div>' +
      '<div class="stat"><div class="k">Value</div><div class="v" data-live="value:' + t + '"></div></div></div>' +
      '<div class="badges" style="margin-top:10px">' + state.holdings.filter(function (h) { return h.t === t && h.sh > 0 && state.linked.indexOf(h.acct) >= 0; }).map(function (h) { return bb(h.acct) + '<span class="small muted" style="align-self:center">' + h.sh + ' sh</span>'; }).join('') + '</div></div>' +
      (n ? insuranceCard(t) : '<div class="card muted">No shares held in linked demo accounts.</div>') +
      '<div class="footer-note">Demo — simulated prices, no real trades.</div>';
  }

  function viewInsured() {
    var ts = Object.keys(state.ins);
    if (!ts.length) return '<div class="card center"><div style="font-size:40px">⛨</div><b>No insured holdings yet</b><p class="muted">Open a stock and switch on Paracord insurance to lock in its price.</p><button class="btn" data-act="tab" data-tab="home">Browse portfolio</button></div>';
    return '<div class="card hero"><div class="small" style="opacity:.8">Total insurance rate</div><div class="big" data-live="totalrate"></div><div class="small">Protected value: <b data-live="protected"></b> · Cost so far: <b data-live="totalcost"></b></div></div>' +
      ts.map(function (t) {
        return '<button class="stock" style="grid-template-columns:40px 1fr auto" data-act="open-stock" data-t="' + t + '">' + tk(t) +
          '<div><div class="nm">' + t + ' · lock ' + money(state.ins[t].lockIn, 2) + '</div><div class="sub" data-live="elapsed:' + t + '"></div><div class="small" data-live="discountmini:' + t + '"></div></div>' +
          '<div class="px"><div style="font-weight:800" data-live="rate:' + t + '"></div><div class="small muted" data-live="cost:' + t + '"></div></div></button>';
      }).join('') + '<div class="footer-note">Demo — simulated prices, no real trades.</div>';
  }

  function viewAccounts() {
    return '<div class="card"><h3>Linked brokerages (demo)</h3>' + BROKERS.map(function (b) {
      var on = state.linked.indexOf(b.id) >= 0;
      return '<div class="broker"><div class="lg" style="background:' + b.color + '">' + b.short + '</div><div><b>' + b.name + '</b><div class="small muted">' +
        (on ? state.holdings.filter(function (h) { return h.acct === b.id && h.sh > 0; }).map(function (h) { return h.sh + ' ' + h.t; }).join(' · ') || 'No demo holdings' : 'Not linked') + '</div></div>' +
        (on ? '<button class="btn sm ghost" style="margin-left:auto" data-act="unlink" data-b="' + b.id + '">Unlink</button>' : '<button class="btn sm" style="margin-left:auto" data-act="link-direct" data-b="' + b.id + '">Link</button>') + '</div>';
    }).join('') + '</div><div class="small muted center">Links are simulated. Paracord never asks for your brokerage password.</div>';
  }

  function demoControls() {
    var sp = state.clock.speed;
    return '<div class="card"><h3>Demo clock</h3><div class="small muted">Sim time: <b data-live="simclock"></b></div>' +
      '<div class="seg" style="margin:10px 0">' + [1, 60, 600].map(function (x) { return '<button class="' + (sp === x ? 'on' : '') + '" data-act="speed" data-x="' + x + '">×' + x + '</button>'; }).join('') + '</div>' +
      '<div class="grid2"><button class="btn ghost" data-act="skip" data-ms="3600000">⏩ Skip 1 hour</button><button class="btn ghost" data-act="skip" data-ms="' + DAY + '">⏩ Skip 24 hours</button></div>' +
      '<div class="small muted" style="margin-top:8px">Fast-forward accrues insurance cost at the current rate and advances the 24h discount progress.</div></div>' +
      '<div class="card"><h3>Reset</h3><button class="btn danger" data-act="reset">Reset demo</button><div class="small muted" style="margin-top:8px">Clears insured flags, lock-ins, timestamps, linked accounts and receipts from this browser.</div></div>';
  }
  function viewDemo() {
    return '<div class="demo-tag">DEMO MENU</div><p class="muted small">Everything in Paracord is simulated: prices are a random walk, accounts and holdings are fake, and no trade ever happens.</p>' + demoControls() +
      '<div class="card small"><h3>Simulated stocks</h3>' + STOCKS.map(function (s) { return '<div class="kv"><span class="k">' + s.t + ' · ' + s.tag + '</span><span class="v">σ ' + Math.round(s.vol * 100) + '% · F ' + big(s.float) + ' · ADV ' + big(s.adv) + '</span></div>'; }).join('') + '</div>';
  }

  /* ---------- sheets ---------- */
  function renderSheet() {
    if (route.sheet === 'demo') return '<h2>Demo menu</h2>' + demoControls() + '<button class="btn ghost" data-act="close-sheet">Close</button>';
    if (route.sheet === 'link-pick') {
      return '<h2>Link a brokerage</h2><div class="demo-tag">DEMO — simulated link, no password</div><p class="small muted">Pick a brokerage. You\'ll approve a simulated read-only link — no credentials are ever requested.</p>' +
        BROKERS.map(function (b) {
          var on = state.linked.indexOf(b.id) >= 0;
          return '<button class="broker" data-act="pick-broker" data-b="' + b.id + '"' + (on ? ' disabled style="opacity:.6"' : '') + '><div class="lg" style="background:' + b.color + '">' + b.short + '</div><b>' + b.name + '</b><span class="st' + (on ? ' linked' : '') + '">' + (on ? '✓ Linked' : 'Link ›') + '</span></button>';
        }).join('') + '<button class="btn ghost" data-act="close-sheet">Cancel</button>';
    }
    if (route.sheet === 'link-approve') {
      var b = BY_B[route.b];
      return '<div class="oauth"><div class="url">🔒 demo-auth.' + b.id + '.example/authorize (simulated)</div><div class="body">' +
        '<div class="pair"><div class="lg" style="background:' + b.color + '">' + b.short + '</div><span style="font-size:22px">⇄</span><div class="lg" style="background:#111111">⟆</div></div>' +
        '<h2 class="center" style="color:#111111">Paracord (Demo) wants to connect to your ' + b.name + ' demo account</h2>' +
        '<div class="small" style="color:#5c5c5c">Signed in as <b>Demo User</b> (simulated)</div>' +
        '<ul class="small"><li>View holdings &amp; share counts (read-only, simulated)</li><li>No trading, no transfers, no money movement</li></ul>' +
        '<div class="note"><b>DEMO:</b> No password or credentials are requested. This screen imitates an OAuth approval — nothing connects to ' + b.name + '.</div>' +
        '<button class="btn" data-act="approve" data-b="' + b.id + '">Approve demo link</button><button class="btn ghost" data-act="close-sheet">Deny</button></div></div>';
    }
    if (route.sheet === 'link-done') {
      var b2 = BY_B[route.b];
      return '<div class="check">✓</div><h2 class="center">' + b2.name + ' linked (demo)</h2><p class="center muted small">Demo holdings imported:</p>' +
        '<div class="card">' + b2.demo.map(function (h) { return '<div class="kv"><span class="k">' + h[0] + ' · ' + BY_T[h[0]].name.replace(/ \(.*\)/, '') + '</span><span class="v">' + h[1] + ' sh</span></div>'; }).join('') + '</div>' +
        '<div class="badges" style="justify-content:center;margin-bottom:12px">' + state.linked.map(function (a) { return bb(a); }).join('') + '</div>' +
        '<button class="btn" data-act="link-finish">Done</button>';
    }
    return '';
  }

  /* ---------- cash-out ---------- */
  function coCalc(t, n) {
    var ins = state.ins[t], S = sim.price(t);
    var costPart = ins ? ins.cost * n / ins.shares : 0;
    return { S: S, K: ins.lockIn, n: n, payout: n * ins.lockIn, market: n * S, cost: costPart, net: n * ins.lockIn - costPart };
  }
  function viewCashout() {
    var t = route.t;
    if (route.step === 'receipt') {
      var r = state.receipts.filter(function (x) { return x.ref === route.ref; })[0];
      if (!r) return '<div class="card">Receipt not found.</div>';
      return '<div class="demo-tag" style="display:block;text-align:center">DEMO — no real trade</div><div class="check">✓</div><h2 class="center" style="margin:0">Cash-out complete (demo)</h2>' +
        '<p class="center muted small">Ref <b class="num" style="color:#111111">' + r.ref + '</b><br>' + new Date(r.at).toLocaleString() + ' (sim clock)</p>' +
        '<div class="card">' + kv('Stock', r.t + ' · ' + BY_T[r.t].name.replace(/ \(.*\)/, '')) + kv('Shares sold to Paracord', r.n) + kv('Lock-in price', money(r.K, 2)) + kv('Market price at execution', money(r.S, 2)) +
        kv('Payout', money(r.payout, 2)) + kv('Insurance cost settled', '−' + money(r.cost)) + kv('Net', money(r.net, 2), 'total') + kv('vs selling at market', '<span class="' + cls(r.payout - r.market) + '">' + signed(r.payout - r.market) + '</span>') + '</div>' +
        '<div class="small muted center" style="margin-bottom:12px">Simulated receipt. No shares moved and no money was paid.</div><button class="btn" data-act="receipt-done">Done</button>';
    }
    var ins = state.ins[t];
    if (!ins) return '<div class="card">This holding is not insured.</div>';
    var n = Math.min(route.n || ins.shares, ins.shares);
    if (route.step === 'confirm') {
      return '<div class="demo-tag" style="display:block;text-align:center">DEMO — no real trade</div>' +
        '<div class="card center" style="margin-top:12px"><div class="small muted">You\'re selling to Paracord</div><div class="big">' + n + ' ' + t + '</div><div class="muted">at lock-in <b style="color:#111111">' + money(ins.lockIn, 2) + '</b> / share</div></div>' +
        '<div class="card" id="cosum">' + coRows(t, n) + '</div>' +
        '<div class="card small muted">By confirming, the demo will reduce your simulated ' + t + ' holding by ' + n + ' shares and settle the pro-rated insurance cost. Nothing is sent to any brokerage.</div>' +
        '<button class="btn mint" data-act="co-confirm">Confirm demo cash-out</button><button class="btn ghost" data-act="back">Cancel</button>';
    }
    return '<div class="demo-tag" style="display:block;text-align:center">DEMO — no real trade</div>' +
      '<div class="card" style="margin-top:12px"><h3>Shares to sell at lock-in</h3><div class="stepper"><button data-act="co-n" data-d="-1" aria-label="Fewer">−</button>' +
      '<input id="coN" type="number" inputmode="numeric" min="1" max="' + ins.shares + '" value="' + n + '" aria-label="Share count"><button data-act="co-n" data-d="1" aria-label="More">+</button></div>' +
      '<input type="range" id="coR" min="1" max="' + ins.shares + '" value="' + n + '" aria-label="Share count slider">' +
      '<div class="row between small muted"><span>1</span><button class="btn sm ghost" data-act="co-max">Max (' + ins.shares + ')</button><span>' + ins.shares + ' insured</span></div></div>' +
      '<div class="card" id="cosum">' + coRows(t, n) + '</div>' +
      '<button class="btn" data-act="co-review">Review cash-out</button>';
  }
  function kv(k, v, c) { return '<div class="kv' + (c ? ' ' + c : '') + '"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
  function coRows(t, n) {
    var c = coCalc(t, n);
    return kv('Lock-in price', money(c.K, 2)) + kv('Current market price (sim)', money(c.S, 2)) + kv('Payout (' + n + ' × lock-in)', money(c.payout, 2)) +
      kv('Market value of these shares', money(c.market, 2)) + kv('Protection benefit', '<span class="' + cls(c.payout - c.market) + '">' + signed(c.payout - c.market) + '</span>') +
      kv('Insurance cost so far (pro-rated)', '−' + money(c.cost)) + kv('Net to you', money(c.net, 2), 'total');
  }
  function doCashout() {
    var t = route.t, ins = state.ins[t]; if (!ins) return;
    var n = Math.min(route.n || ins.shares, ins.shares), c = coCalc(t, n);
    var ref = 'PCD-DEMO-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    state.receipts.unshift({ ref: ref, t: t, n: n, K: c.K, S: c.S, payout: c.payout, market: c.market, cost: c.cost, net: c.net, at: simNow() });
    var left = n;
    state.holdings.forEach(function (h) { if (h.t === t && left > 0 && state.linked.indexOf(h.acct) >= 0) { var x = Math.min(h.sh, left); h.sh -= x; left -= x; } });
    ins.cost -= c.cost; ins.shares -= n;
    if (ins.shares <= 0) delete state.ins[t];
    doneFlows[route.flow] = true; save();
    replace({ view: 'cashout', t: t, step: 'receipt', ref: ref, flow: route.flow });
  }

  /* ---------------- User Confidence Index (demo) ---------------- */
  function confCtx() {
    return { mood: state.conf.mood, noise: confNoise, price: function (t) { return sim.price(t); }, open: function (t) { return state.open[t]; },
      sigma1: function (t) { return sim.sigma1(t); }, news: newsScore };
  }
  function confCompute() { if (!window.PCConfidence) return null; confLast = window.PCConfidence.compute(confCtx()); if (state.conf.open == null) { state.conf.open = confLast.index; } return confLast; }
  function confCard() {
    var tg = state.conf.target;
    function b(v, l) { return '<button class="' + (Math.abs(tg - v) < 0.001 ? 'on' : '') + '" data-act="conf" data-v="' + v + '">' + l + '</button>'; }
    return '<div class="card conf" id="conf-card"><div class="row between"><h3 style="margin:0">User Confidence Index</h3><span class="demo-tag">DEMO DATA</span></div>' +
      '<div id="conf-body"></div>' +
      '<div class="conf-ctl"><div class="small muted" style="margin:10px 0 6px">Demo scenario</div><div class="seg" id="conf-seg">' + b(-0.5, 'Panic day') + b(0, 'Normal') + b(1, 'Euphoria') + '</div>' +
      '<label class="small muted conf-sl" for="confSlider">Crowd mood &amp; market move <b id="conf-sl-v"></b></label>' +
      '<input type="range" id="confSlider" min="-100" max="100" step="5" value="' + Math.round(tg * 100) + '" aria-label="Crowd mood and market move"></div>' +
      '<details class="how small"><summary>How it\'s computed</summary><div class="muted">' +
      'Demo crowd of 100,000 Paracord users, each holding 100 shares of every demo stock, cushion 5% below the open. ' +
      'Share of users turning insurance on = logistic(−1 − 0.9·move<sub>σ</sub> + 1.6·H − 1.4·mood + noise). ' +
      'Fear = 0.40·insured share + 0.20·cash-in rate + 0.15·waiting-line/surge share + 0.15·drop + 0.10·news H − 0.25·rally; Index = 100 / (1 + e<sup>8·(fear − 0.15)</sup>). ' +
      'Resilience prices today\'s book with the v3 rate (live repricing; half the session at the open price, half at the moved price), the 1%-of-float capacity cap and surge (half of over-capacity users surge, the rest wait), and the surge-uplift reserve. ' +
      'Cash-ins are optional: only some users below the cushion cash in (at mid-session); the rest keep coverage. Payouts = cash-ins + expected shortfall of policies still on. Not a forecast.</div></details></div>';
  }
  function confBody(r) {
    var C = window.PCConfidence, T = r.T, v = r.index, d = v - state.conf.open;
    var gauge = '<div class="conf-gauge">' + C.BANDS.map(function (bd) { return '<span class="' + (r.band === bd[2] ? 'on' : '') + '" style="width:20%">' + bd[2] + '</span>'; }).join('') +
      '<i style="left:' + Math.min(99, Math.max(1, v)) + '%"></i></div>';
    var h = confHist.length > 1 ? confHist : [v, v], n = h.length;
    var pts = h.map(function (x, i) { return (i * 120 / (n - 1)).toFixed(1) + ',' + (34 - x / 100 * 32).toFixed(1); }).join(' ');
    var spark = '<svg class="conf-spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-label="Index this session"><line x1="0" x2="120" y1="18" y2="18" stroke="#d6d6d6" stroke-dasharray="2 3"/><polyline points="' + pts + '" fill="none" stroke="#111111" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
    function m(x) { return '$' + Math.round(x).toLocaleString(); }
    var res = '<div class="conf-res"><div class="row between"><b>Paracord resilience · today</b><span class="small muted">demo book</span></div>' +
      '<div class="conf-status ' + r.ok + '">' + (r.ok === 'ok' ? '✓ ' : '✕ ') + r.status + '</div>' +
      '<div class="grid2" style="margin-top:8px">' +
      '<div class="stat"><div class="k">Premiums in</div><div class="v">' + m(T.prem) + '</div><div class="small muted">incl. ' + m(T.uplift) + ' surge</div></div>' +
      '<div class="stat"><div class="k">Payouts out</div><div class="v' + (T.pay > T.prem ? ' down' : '') + '">' + m(T.pay) + '</div><div class="small muted">cash-ins ' + m(T.payCash) + ' · open ' + m(T.payExp) + '</div></div>' +
      '<div class="stat"><div class="k">Surge reserve</div><div class="v">' + m(T.uplift) + '</div><div class="small muted">target ' + m(T.target) + (r.reserveUsed > 0 ? ' · used ' + m(r.reserveUsed) : '') + '</div></div>' +
      '<div class="stat"><div class="k">Capacity use (max)</div><div class="v">' + Math.round(T.uMax * 100) + '%</div><div class="small muted">' + Math.round(T.wait).toLocaleString() + ' waiting · ' + Math.round(T.surge).toLocaleString() + ' surge</div></div>' +
      '</div><div class="small muted" style="margin-top:6px">Net ' + (r.net >= 0 ? '+' : '−') + m(Math.abs(r.net)) + ' · ' + Math.round(T.policies).toLocaleString() + ' policies across 4 stocks · cash-ins are optional, nothing auto-sells</div></div>';
    return '<div class="conf-top"><div><div class="big conf-num">' + v.toFixed(0) + '</div>' +
      '<div class="small"><b>' + r.band + '</b> · <span class="' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' vs open</span></div></div>' + spark + '</div>' + gauge +
      '<div class="small muted conf-drv">Insured ' + Math.round(r.pIns * 100) + '% of users · cash-ins ' + Math.round(r.cashRate * 100) + '% · waiting/surge ' + Math.round(r.lineRate * 100) + '% · market ' + (r.mkt >= 0 ? '+' : '−') + Math.abs(r.mkt).toFixed(1) + 'σ · news H ' + r.H.toFixed(2) + '</div>' + res;
  }
  function confSliderLabel(v) { var mv = v < 0 ? v * 3 : v * 1.5; return (v < -0.6 ? 'Extreme panic' : v < -0.2 ? 'Panic' : v > 0.6 ? 'Euphoria' : v > 0.2 ? 'Upbeat' : 'Normal') + ' · market ' + (mv >= 0 ? '+' : '−') + Math.abs(mv).toFixed(1) + 'σ'; }
  function confLive() {
    var body = document.getElementById('conf-body'); if (!body) return;
    var r = confLast || confCompute(); if (!r) return;
    body.innerHTML = confBody(r);
    var lv = document.getElementById('conf-sl-v'); if (lv) lv.textContent = confSliderLabel(state.conf.target);
  }
  function confSet(v, withNews) {
    state.conf.target = Math.max(-1, Math.min(1, v));
    if (withNews != null) STOCKS.forEach(function (s) { state.news[s.t] = withNews ? [{ at: simNow(), sev: 1, rel: 1 }] : []; });
    document.querySelectorAll('#conf-seg button').forEach(function (b) { b.classList.toggle('on', Math.abs(+b.dataset.v - state.conf.target) < 0.001); });
    var sl = document.getElementById('confSlider'); if (sl && document.activeElement !== sl) sl.value = Math.round(state.conf.target * 100);
    save(); confCompute(); confLive();
  }

  /* ---------------- live updates ---------------- */
  function sparkPts(t) {
    var h = sim.hist(t).slice(-40), mn = Math.min.apply(null, h), mx = Math.max.apply(null, h), r = mx - mn || 1;
    return h.map(function (p, i) { return (i * 76 / (h.length - 1)).toFixed(1) + ',' + (29 - (p - mn) / r * 26).toFixed(1); }).join(' ');
  }
  function totals() {
    var v = 0, p = 0, r = 0, c = 0;
    heldTickers().forEach(function (s) { v += sharesOf(s.t) * sim.price(s.t); });
    Object.keys(state.ins).forEach(function (t) { var i = state.ins[t]; p += i.shares * i.lockIn; r += rateOf(t); c += i.cost; });
    return { v: v, p: p, r: r, c: c };
  }
  function bdHtml(t) {
    var b = breakdown(t), d = BY_T[t], ins = state.ins[t];
    var blocks = ins ? ins.blocksDone : 0;
    function term(sym, name, val, ex) { return '<div class="term"><span class="sym">' + sym + '</span><div><b>' + name + '</b><div class="ex">' + ex + '</div></div><span class="val">' + val + '</span></div>'; }
    return term('E', 'Expected shortfall', money(b.E, 2), 'N·S·σ<sub>h</sub>·G(z) = ' + (ins ? ins.shares : 0) + ' × ' + money(sim.price(t), 2) + ' × ' + (b.sigma_h * 100).toFixed(2) + '% × ' + b.G.toFixed(4) + '<br>σ₁ ' + (b.sigma1 * 100).toFixed(3) + '%/min' + (sim.sigma1Floored(t) ? ' (floored)' : '') + ' · z = ' + b.z.toFixed(2)) +
      term('L', 'Liquidity factor', '×' + b.L.toFixed(3), 'max(1,(1B/F)^0.1)·(1+10·N/ADV) = ' + b.Lfloat.toFixed(3) + ' × ' + b.Lsize.toFixed(4) + '<br>F ' + big(d.float) + ' · ADV ' + big(d.adv) + ' (simulated)') +
      term('H', 'News-shock score', b.H.toFixed(2) + ' → ×' + b.newsFactor.toFixed(2), '1 + 3·H; demo shock sets H = 1, decays e<sup>−age/20 min</sup>, ignored after 30 min') +
      term('D', 'Full-day discount', blocks ? '0.90 ✓' : '1.00', blocks ? blocks + ' completed 24h block' + (blocks > 1 ? 's' : '') + ' billed at 0.90 (' + money(ins.rebates, 2) + ' rebated); current block at 1.00 until it completes' : 'Becomes 0.90 for a completed unbroken 24h block (applied as a 10% rebate)') +
      term('R', 'Rate', rateStr(b.rate), 'raw ' + money(b.raw, 4) + '/min' + (b.clampedTo === 'floor' ? ' → floor $0.02' : b.clampedTo === 'cap' ? ' → cap $6.00' : ''));
  }
  function liveVal(kind, t, el) {
    var ins = t && state.ins[t];
    switch (kind) {
      case 'price': return money(sim.price(t), 2);
      case 'chg': el.className = (el.className.replace(/\b(up|down)\b/g, '') + ' ' + cls(chg(t))).trim(); return pct(chg(t)) + ' today';
      case 'value': return money(sharesOf(t) * sim.price(t), 2);
      case 'shares': return sharesOf(t) + ' sh';
      case 'vol': return 'Realized vol ' + Math.round(annVol(t) * 100) + '% (σ₁ ' + (sim.sigma1(t) * 100).toFixed(3) + '%/min)';
      case 'total': return money(totals().v, 2);
      case 'protected': return money(totals().p, 2);
      case 'totalrate': return rateStr(totals().r);
      case 'totalcost': return money(totals().c);
      case 'previewrate': return rateStr(rateOf(t, { shares: sharesOf(t), lockIn: sim.price(t) }));
      case 'simclock': return new Date(simNow()).toLocaleString() + ' · ×' + state.clock.speed;
    }
    if (!ins) return '';
    var S = sim.price(t);
    switch (kind) {
      case 'lock': return money(ins.lockIn, 2);
      case 'kpct': return money(ins.lockIn, 2) + ' (' + ((ins.lockIn / S - 1) * 100).toFixed(1) + '% vs price)';
      case 'maxprot': return money(ins.shares * ins.lockIn, 2);
      case 'pl': var d = (S - ins.lockIn) * ins.shares; el.className = 'v ' + cls(d); return signed(d) + '<div class="small">' + pct(S / ins.lockIn - 1) + '</div>';
      case 'rate': return rateStr(rateOf(t));
      case 'ratesub': var b = breakdown(t); return 'σ ' + Math.round(annVol(t) * 100) + '% ann. · ' + (b.clampedTo === 'floor' ? 'at $0.02 floor · ' : b.clampedTo === 'cap' ? 'at $6 cap · ' : '') + '≈ ' + money(b.rate / 60, 5) + '/sec';
      case 'cost': return money(ins.cost);
      case 'elapsed': return dur(simNow() - ins.enabledAt);
      case 'newspill': var h = newsScore(t); return h > 0.01 ? '<span class="pill news">⚡ News H ' + h.toFixed(2) + '</span>' : '';
      case 'breakdown': return bdHtml(t);
      case 'discount': return ins.blocksDone ? '<span class="pill gold">★ 10% off</span><div class="small muted" style="margin-top:6px">' + money(ins.rebates, 2) + ' rebated · next day ' + Math.floor(prog(ins) * 100) + '%</div>' : '<b>' + dur(DAY - (simNow() - ins.blockStart)) + '</b><div class="small muted">to 10% off</div>';
      case 'discountmini': return ins.blocksDone ? '<span class="pill gold" style="padding:2px 8px;font-size:11px">★ 10% off</span>' : '<span class="muted">' + Math.floor(prog(ins) * 100) + '% to 10% off</span>';
      case 'ringpct': return ins.blocksDone ? '10%' : Math.floor(prog(ins) * 100) + '%';
    }
    return '';
  }
  function prog(ins) { return Math.min(1, (simNow() - ins.blockStart) / DAY); }

  function live() {
    document.querySelectorAll('[data-live]').forEach(function (el) {
      var k = el.getAttribute('data-live').split(':'), kind = k[0], t = k[1];
      if (kind === 'spark') { el.setAttribute('points', sparkPts(t)); el.setAttribute('stroke', chg(t) >= 0 ? '#111111' : '#c8102e'); return; }
      if (kind === 'ring') { var ins = state.ins[t]; if (ins) el.setAttribute('stroke-dashoffset', (213.6 * (1 - (ins.blocksDone ? 1 : prog(ins)))).toFixed(1)); if (ins && ins.blocksDone) el.setAttribute('stroke', '#111111'); return; }
      var v = liveVal(kind, t, el);
      if (el.innerHTML !== v) el.innerHTML = v;
    });
    var nb = document.querySelector('[data-live-btn]');
    if (nb) { var on = newsScore(nb.dataset.t) > 0.01; nb.textContent = on ? 'Clear demo news shock' : '⚡ Demo news shock (H → 1)'; nb.className = 'btn ' + (on ? 'ghost' : 'warn'); }
    var ks = document.getElementById('kslider');
    if (ks && document.activeElement !== ks && state.ins[ks.dataset.t]) { var S = sim.price(ks.dataset.t), K = state.ins[ks.dataset.t].lockIn; ks.max = Math.max(S, K).toFixed(2); ks.min = (Math.min(S, K) * 0.85).toFixed(2); ks.value = K.toFixed(2); }
    var cs = document.getElementById('cosum');
    if (cs && route.view === 'cashout' && state.ins[route.t]) cs.innerHTML = coRows(route.t, Math.min(route.n || state.ins[route.t].shares, state.ins[route.t].shares));
    drawChart();
    confLive();
  }

  function drawChart() {
    var c = document.getElementById('chart'); if (!c) return;
    var t = c.dataset.t, dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var data = sim.hist(t), ins = state.ins[t];
    var mn = Math.min.apply(null, data), mx = Math.max.apply(null, data);
    if (ins) { mn = Math.min(mn, ins.lockIn); mx = Math.max(mx, ins.lockIn); }
    var pad = (mx - mn) * 0.1 || 1; mn -= pad; mx += pad;
    var L = 8, R = 58, T = 10, B = 14;
    function X(i) { return L + i * (w - L - R) / (data.length - 1); }
    function Y(p) { return T + (mx - p) / (mx - mn) * (h - T - B); }
    g.strokeStyle = '#e6e6e6'; g.lineWidth = 1; g.fillStyle = '#5c5c5c'; g.font = '11px sans-serif';
    for (var k = 0; k <= 3; k++) { var p = mn + (mx - mn) * k / 3, y = Y(p); g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); g.fillText(p.toFixed(2), w - R + 6, y + 4); }
    if (ins) { var ly = Y(ins.lockIn); g.fillStyle = 'rgba(200,16,46,.06)'; g.fillRect(L, ly, w - L - R, h - B - ly); }
    var col = BY_T[t].color, grad = g.createLinearGradient(0, T, 0, h);
    grad.addColorStop(0, col + '55'); grad.addColorStop(1, col + '00');
    g.beginPath(); data.forEach(function (p, i) { i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p)); });
    g.lineTo(X(data.length - 1), h - B); g.lineTo(X(0), h - B); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); data.forEach(function (p, i) { i ? g.lineTo(X(i), Y(p)) : g.moveTo(X(i), Y(p)); }); g.strokeStyle = col; g.lineWidth = 2; g.stroke();
    var lx = X(data.length - 1), lyy = Y(data[data.length - 1]); g.fillStyle = col; g.beginPath(); g.arc(lx, lyy, 4, 0, 7); g.fill();
    if (ins) {
      var y2 = Y(ins.lockIn); g.setLineDash([6, 5]); g.strokeStyle = '#c8102e'; g.lineWidth = 2; g.beginPath(); g.moveTo(L, y2); g.lineTo(w - R, y2); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#c8102e'; g.fillRect(w - R + 2, y2 - 9, R - 4, 18); g.fillStyle = '#ffffff'; g.font = 'bold 11px sans-serif'; g.fillText('K ' + ins.lockIn.toFixed(2), w - R + 5, y2 + 4);
    }
  }

  var toastT;
  function toast(msg) { var el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove('show'); }, 2600); }

  /* ---------------- events ---------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    if (el.classList.contains('scrim') && e.target !== el) return; // clicks inside the sheet don't close it
    var a = el.dataset.act, t = el.dataset.t;
    switch (a) {
      case 'open-stock': go({ view: 'stock', t: t }); break;
      case 'tab': tab(el.dataset.tab); break;
      case 'back': history.back(); break;
      case 'close-sheet': history.go(-(route.sheetDepth || 1)); break;
      case 'link': openSheet('link-pick'); break;
      case 'link-direct': openSheet('link-approve', { b: el.dataset.b }); break;
      case 'pick-broker': openSheet('link-approve', { b: el.dataset.b }); break;
      case 'approve':
        var b = el.dataset.b;
        if (state.linked.indexOf(b) < 0) { state.linked.push(b); BY_B[b].demo.forEach(function (h) { state.holdings.push({ acct: b, t: h[0], sh: h[1] }); }); save(); }
        replace(Object.assign({}, route, { sheet: 'link-done' })); break;
      case 'link-finish': history.go(-(route.sheetDepth || 1)); break;
      case 'unlink':
        state.linked = state.linked.filter(function (x) { return x !== el.dataset.b; });
        state.holdings = state.holdings.filter(function (h) { return h.acct !== el.dataset.b; });
        accrue(); save(); render.noScroll = true; render(); toast(BY_B[el.dataset.b].name + ' unlinked (demo)'); break;
      case 'toggle-ins':
        if (state.ins[t]) disableIns(t); else { enableIns(t); toast('⛨ Insured at ' + money(sim.price(t), 2) + ' (demo)'); }
        render.noScroll = true; render(); break;
      case 'news':
        if (newsScore(t) > 0.01) state.news[t] = []; else { state.news[t] = [{ at: simNow(), sev: 1, rel: 1 }]; toast('⚡ Demo news shock on ' + t + ' — H = 1, decays over ~20 sim-min'); }
        save(); live(); break;
      case 'skip': accrue(); state.clock.offset += +el.dataset.ms; accrue(); save(); live(); toast('⏩ Skipped ' + (+el.dataset.ms === DAY ? '24 hours' : '1 hour') + ' (demo clock)'); break;
      case 'speed': state.clock.speed = +el.dataset.x; save(); render.noScroll = true; render(); break;
      case 'reset':
        if (el.dataset.armed) { localStorage.removeItem(KEY); state = freshState(); state.conf = { target: 0, mood: 0, open: null }; confHist = []; confLast = null; sim = new window.PCSim(STOCKS, {}); STOCKS.forEach(function (s) { state.open[s.t] = sim.hist(s.t)[0]; }); save(); replace({ view: 'home' }); toast('Demo reset'); }
        else { el.dataset.armed = '1'; el.textContent = 'Tap again to reset everything'; }
        break;
      case 'cashout': go({ view: 'cashout', t: t, step: 'summary', n: state.ins[t].shares, flow: Date.now().toString(36) }); break;
      case 'co-n': setN((route.n || 1) + (+el.dataset.d)); break;
      case 'co-max': setN(state.ins[route.t].shares); break;
      case 'co-review': go(Object.assign({}, route, { step: 'confirm' })); break;
      case 'co-confirm': doCashout(); break;
      case 'receipt-done': history.go(-2); break;
      case 'conf': var cv = +el.dataset.v; confSet(cv, cv < 0 ? true : false);
        toast(cv < 0 ? '⚡ Demo panic day: market −1.5σ, news shock on all four' : cv > 0 ? 'Demo euphoria: market +1.5σ, news cleared' : 'Demo normal day: news cleared'); break;
    }
  });
  function setN(n) {
    var ins = state.ins[route.t]; if (!ins) return;
    n = Math.max(1, Math.min(ins.shares, Math.round(n) || 1));
    route = Object.assign({}, route, { n: n }); history.replaceState(route, '', hashOf(route));
    var i = document.getElementById('coN'), r = document.getElementById('coR');
    if (i && +i.value !== n) i.value = n; if (r) r.value = n;
    document.getElementById('cosum').innerHTML = coRows(route.t, n);
  }
  document.addEventListener('input', function (e) {
    if (e.target.id === 'coN' || e.target.id === 'coR') setN(+e.target.value);
    if (e.target.id === 'confSlider') confSet(+e.target.value / 100);
    if (e.target.id === 'kslider') {
      var t = e.target.dataset.t, ins = state.ins[t]; if (!ins) return;
      accrue(); ins.lockIn = Math.min(+e.target.value, sim.price(t)); save(); live();
    }
  });
  document.getElementById('backBtn').onclick = function () { history.back(); };
  document.getElementById('demoChip').onclick = function () { if (route.sheet !== 'demo') openSheet('demo'); };
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.dataset.tab); }; });

  /* ---------------- loop ---------------- */
  function tick() {
    var nowR = Date.now();
    state.clock.offset += (nowR - lastReal) * (state.clock.speed - 1);
    lastReal = nowR;
    sim.step();
    STOCKS.forEach(function (s) { state.px[s.t] = sim.price(s.t); });
    // confidence index: ease the crowd mood toward the chosen scenario, small AR(1) noise, then record the session sparkline
    state.conf.mood += (state.conf.target - state.conf.mood) * 0.25;
    confNoise = 0.92 * confNoise + 0.12 * (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    var cr = confCompute(); if (cr) { confHist.push(cr.index); if (confHist.length > 240) confHist.shift(); }
    accrue(); save(); live();
  }

  // initial route (supports deep links like #/stock/COP)
  var m = location.hash.match(/^#\/(\w+)(?:\/(\w+))?/);
  history.replaceState({ view: 'home' }, '', '#/home');
  accrue();
  if (m && m[1] === 'stock' && BY_T[m[2]]) go({ view: 'stock', t: m[2] });
  else if (m && ROOTS.indexOf(m[1]) > 0) go({ view: m[1] });
  else render();
  setInterval(tick, 1000);

  // test/demo hook (read-only helpers)
  window.__paracord = { state: function () { return state; }, rate: rateOf, breakdown: breakdown, sim: sim, news: newsScore, confidence: function () { return confLast; } };
})();
