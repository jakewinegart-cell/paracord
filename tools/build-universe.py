#!/usr/bin/env python3
"""Build data/universe.json (+ data/universe.js wrapper) for the Paracord demo -- OFFLINE, run by hand.

    python3 tools/build-universe.py [--sp500 /workspace/paracord-sp500] [--chains /workspace/chains]

Output is a DEMO SNAPSHOT, AS OF OCT 23, 2026. It is not live data and must be labelled as such wherever shown.
Inputs (built earlier on the box, see /workspace/paracord-sp500-scope.md):
  universe.csv          price, ADV, realized vol, SEC shares outstanding, GICS sector  (Yahoo daily bars / SEC / Wikipedia)
  constituents.csv      company names
  options_liquidity.csv CBOE delayed-quote summary: iv30, expiries inside 35 days, 1-month 5%-OTM put spread
  returns.npy/dates.json 2y daily log returns (factor loadings, 20-day realized vol)
  chains/puts.json      listed NVDA/WMT/COP/AMZN puts (for options-implied vol in Paracord's own r=0 convention)
  tools/earnings_dates.csv  hand-checked earnings dates with sources (only names listed there get a date)
Derived / estimated fields are flagged in each record's "est" list. Nothing here is fabricated: MOON is a
fictional demo stock and is marked fictional; its implied vol (150%) is an assumption.
"""
import argparse, csv, json, math, os, sys
from datetime import date
import numpy as np

AS_OF = date(2026, 10, 23)
LABEL = 'demo snapshot, as of Oct 23, 2026'
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)

ap = argparse.ArgumentParser()
ap.add_argument('--sp500', default='/workspace/paracord-sp500'); ap.add_argument('--chains', default='/workspace/chains')
A = ap.parse_args()
P = lambda f: os.path.join(A.sp500, f)

def ncdf(x): return 0.5 * math.erfc(-x / math.sqrt(2))
def bs_put(S, K, s, T):                                   # r = 0, no dividends: same convention as rate.js bsPut
    if s <= 0 or T <= 0: return max(K - S, 0.0)
    v = s * math.sqrt(T); d1 = (math.log(S / K) + 0.5 * v * v) / v
    return K * ncdf(-(d1 - v)) - S * ncdf(-d1)
def implied(S, K, T, price):
    lo, hi = 1e-4, 5.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if bs_put(S, K, mid, T) < price: lo = mid
        else: hi = mid
    return 0.5 * (lo + hi)

U = list(csv.DictReader(open(P('universe.csv'))))
names = {r['t']: r for r in csv.DictReader(open(P('constituents.csv')))}
opt = {r['t']: r for r in csv.DictReader(open(P('options_liquidity.csv')))}
R2 = np.load(P('returns.npy')); assert R2.shape[1] == len(U), 'returns.npy columns must align with universe.csv'
earn = {r['t']: r for r in csv.DictReader(open(os.path.join(HERE, 'earnings_dates.csv')))}

n = len(U)
px = np.array([float(u['px']) for u in U]); adv_sh = np.array([float(u['adv_sh']) for u in U])
so = np.array([float(u['shares_out']) if u['shares_out'] not in ('', 'None') else np.nan for u in U])
turn = float(np.nanmedian(adv_sh / so)); so_est = np.isnan(so); so = np.where(so_est, adv_sh / turn, so)
mcap = so * px; w = mcap / mcap.sum()
sectors = sorted(set(u['sector'] for u in U)); sec = np.array([sectors.index(u['sector']) for u in U])

# ---- factor loadings (correlation units) from 2y of sessions: market (equal-weight, broad co-movement;
#      the cap-weighted index is dominated by mega-cap tech) + own sector (cap-weighted, ex-market) + idiosyncratic ----
R = np.where(np.isnan(R2), 0.0, R2); m = R.mean(1)
beta = (R - R.mean(0)).T @ (m - m.mean()) / len(m) / m.var()
resid = R - np.outer(m, beta)
a = np.array([np.corrcoef(R[:, j], m)[0, 1] for j in range(n)])
c = np.zeros(n)
for k in range(len(sectors)):
    idx = np.where(sec == k)[0]; F = resid[:, idx] @ w[idx]
    for j in idx:                                      # leave-one-out sector factor (a mega-cap must not load on itself)
        f = F - resid[:, j] * w[j]
        rc = np.corrcoef(resid[:, j], f)[0, 1] if resid[:, j].std() > 0 and len(idx) > 1 else 0.0
        c[j] = max(0.0, rc) * math.sqrt(max(0.0, 1 - a[j] ** 2))
lim = np.sqrt(a ** 2 + c ** 2); sc = np.where(lim > 0.97, 0.97 / lim, 1.0); a *= sc; c *= sc
rv20 = np.sqrt(np.nanmean(R2[-20:] ** 2, axis=0) * 252)

# ---- options-implied vol in Paracord's convention (r = 0 Black-Scholes on put mids), Nov-20-2026 expiry ----
chain_iv = {}
pp = os.path.join(A.chains, 'puts.json')
if os.path.exists(pp):
    rows = json.load(open(pp)); rows = rows if isinstance(rows, list) else rows.get('puts', rows)
    T_nov = (date(2026, 11, 20) - AS_OF).days
    for r in rows:
        if r['exp'] != '261120' or r['tag'] not in ('ATM', '5%OTM'): continue
        iv = implied(r['S'], r['K'], T_nov / 365, r['mid'])
        d = chain_iv.setdefault(r['t'], {'win': T_nov, 'by': {}}); d['by'][r['tag']] = round(iv, 4)
ratios = []
for t, d in chain_iv.items():
    d['iv'] = max(d['by'].values())                    # higher of ATM / 5%-OTM: covers the put skew
    if opt.get(t, {}).get('iv30'): ratios.append(d['iv'] / (float(opt[t]['iv30']) / 100))
ADJ = float(np.median(ratios)) if ratios else 1.0

def tier(o):
    if not o or o['ok'] != '1' or not o['otm5_1m_spread_pct']: return 'none'
    sp = float(o['otm5_1m_spread_pct']); ne = int(float(o['n_exp_35d'] or 0))
    return 'A' if sp <= 0.10 and ne >= 4 else 'B' if sp <= 0.20 else 'C'

EVT_K = 2.0                                            # assumed earnings-day move = 2 x a normal day's move
def decompose(iv, win, edate):
    """Split a quoted implied vol into an ex-earnings base vol and an event move (1-day sd)."""
    inside = edate is not None and 0 < (edate - AS_OF).days <= win
    base = iv / math.sqrt(1 + EVT_K ** 2 * 365 / (252 * win)) if inside else iv
    return base, EVT_K * base / math.sqrt(252)

recs = []
for j, u in enumerate(U):
    t = u['t']; o = opt.get(t); est = []
    e = earn.get(t); ed = date.fromisoformat(e['date']) if e else None
    if t in chain_iv: iv, win, src = chain_iv[t]['iv'], chain_iv[t]['win'], 'chain'
    elif o and o.get('iv30'): iv, win, src = float(o['iv30']) / 100 * ADJ, 30, 'iv30'; est.append('iv')
    else: iv, win, src = max(float(u['vol63']), rv20[j]) * 1.25, 30, 'proxy'; est.append('iv')
    base, mv = decompose(iv, win, ed); est.append('earn_move')
    if so_est[j]: est.append('shares_out')
    recs.append(dict(
        t=t, name=names.get(t, {}).get('name', t), sector=u['sector'], px=round(px[j], 2),
        rv20=round(float(rv20[j]), 4), rv63=round(float(u['vol63']), 4), rv1y=round(float(u['vol1y']), 4),
        iv=round(iv, 4), iv_src=src, iv_win=win, iv_base=round(base, 4), earn_move=round(mv, 4),
        earn=e['date'] if e else None, earn_timing=e['timing'] if e else None,
        shares_out=int(float('%.3g' % so[j])), float=int(float('%.3g' % so[j])), adv_sh=int(float('%.3g' % adv_sh[j])),
        addv=int(float('%.3g' % float(u['addv']))), liq=tier(o), a=round(float(a[j]), 3), c=round(float(c[j]), 3),
        w=round(float(w[j]), 6), est=est))

# MOON: fictional high-volatility demo stock (kept from p8; not an S&P 500 name)
mi = 1.50; mb, mm = decompose(mi, 30, None)
recs.append(dict(t='MOON', name='Moonshot Labs (fictional demo ticker)', sector='Information Technology', px=24.20,
                 rv20=1.35, rv63=1.50, rv1y=1.50, iv=mi, iv_src='assumed', iv_win=30, iv_base=mb, earn_move=round(mm, 4),
                 earn=None, earn_timing=None, shares_out=50000000, float=50000000, adv_sh=2000000, addv=48400000,
                 liq='none', a=0.5, c=0.2, w=0.0, est=['all'], fictional=True))

out = dict(label=LABEL, as_of=AS_OF.isoformat(), n=len(recs), sectors=sectors,
           notes=dict(
               iv='Implied vol in Paracord convention (Black-Scholes, r=0, no dividends). "chain": backed out of listed '
                  'Nov-20-2026 put mids (higher of ATM and 5%%-OTM). "iv30": CBOE 30-day IV x %.3f (median chain/iv30 ratio '
                  'on the chain names; covers skew + convention) -- ESTIMATE. "proxy": no options data, 1.25 x realized -- '
                  'ESTIMATE. "assumed": fictional.' % ADJ,
               iv_base='Implied vol with the earnings event removed when a known earnings date falls inside the quote window.',
               earn_move='Assumed 1-day earnings move = 2 x normal daily move (ESTIMATE). Added back only when the '
                         'earnings date falls inside a lock window.',
               earn='Only names in tools/earnings_dates.csv (hand-checked, sourced) have dates; others unknown (null).',
               shares_out='SEC dei:EntityCommonStockSharesOutstanding; est = filled from median turnover (%.4f/day). '
                          'Used as float proxy.' % turn,
               liq='Options liquidity tier: A = 1-month 5%%-OTM put spread <= 10%% and weekly expiries; B <= 20%%; '
                   'C wider; none = no usable chain.',
               a_c='Factor loadings (correlation units) from 501 sessions: a = equal-weight market, c = own-sector (ex-market).',
               rounding='Prices 2 dp, vols 4 dp, share/volume counts 3 significant figures.'),
           adj_iv30=round(ADJ, 4), index_daily_sd=round(float(m.std()), 5), stocks=recs)
os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
js = json.dumps(out, separators=(',', ':'))
open(os.path.join(ROOT, 'data', 'universe.json'), 'w').write(js)
open(os.path.join(ROOT, 'data', 'universe.js'), 'w').write(
    '/* Paracord ' + LABEL + ' -- generated by tools/build-universe.py, do not edit */\nwindow.PC_UNIVERSE=' + js + ';\n')
from collections import Counter
print('names', len(recs), 'iv30 adj', round(ADJ, 4), 'tiers', Counter(r['liq'] for r in recs), 'iv_src', Counter(r['iv_src'] for r in recs))
for t in ('COP', 'WMT', 'NVDA', 'AMZN', 'MOON'):
    r = next(x for x in recs if x['t'] == t)
    print(t, {k: r[k] for k in ('px', 'rv20', 'rv63', 'iv', 'iv_base', 'earn', 'earn_move', 'a', 'c', 'liq', 'float', 'adv_sh')})
