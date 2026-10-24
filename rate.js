/*
 * Paracord — per-minute insurance rate (DEMO)
 * ------------------------------------------------------------------
 * Implements "Paracord: per-minute insurance rate, draft v1"
 * (/workspace/paracord-pricing-v1.md). This is a DRAFT / PLACEHOLDER
 * formula pending the real, reviewed Paracord rate — it is not a filed or
 * approved rate. Swap the body of insuranceRateBreakdown() (keep the
 * signature + returned fields) and the whole app picks it up.
 *
 *   R_t = clamp( c * E_t * L_t * (1 + beta*H_t), R_min, R_max ) * D_t
 *   E_t = N * S * sigma_h * G(z)              expected shortfall over h
 *   sigma_h = sigma_1 * sqrt(h)               h = 390 min (one trading day)
 *   z = (S - K) / (S * sigma_h)               K = lock-in price
 *   G(z) = phi(z) - z * (1 - Phi(z))
 *   L_t = max(1, (F_ref/F)^alpha) * (1 + gamma * N/ADV)
 *   H_t = news-shock score 0..1 (computed by the app, see app.js newsScore)
 *   D_t = 0.90 for minutes inside a completed, unbroken 24h insured block,
 *         else 1.00. Per the md, the app applies it as a 10% rebate on the
 *         block's charges when the block completes.
 *
 * Inputs (all simulated demo values):
 *   price (S), shares (N), lockIn (K), sigma1 (per-minute vol),
 *   float (F, shares), adv (avg daily volume, shares), news (H, 0..1),
 *   inCompletedDayBlock (bool -> D_t).
 *   Back-compat: `volatility` (annualized) is accepted if sigma1 is absent.
 */
(function (g) {
  var C = {
    h: 390,            // look-ahead horizon, minutes
    c: 0.0029,         // per min: ~1.12 x (1/390), fair rate + 12% load
    beta: 3,           // full-severity news ~quadruples the rate
    F_ref: 1e9,        // large-cap float reference, shares
    alpha: 0.1,        // small floats cost a bit more
    gamma: 10,         // position-size vs volume penalty
    R_min: 0.02,       // $/min floor (before day discount)
    R_max: 6.00,       // $/min cap
    D_full_day: 0.90,  // 10% off for a completed 24h block
    MIN_PER_YEAR: 252 * 390
  };

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function phi(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
  // Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf), |err| < 1.5e-7
  function Phi(z) {
    var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  function G(z) { return phi(z) - z * (1 - Phi(z)); }

  function insuranceRateBreakdown(o) {
    var S = +o.price, N = +o.shares, K = +(o.lockIn || o.price);
    var sigma1 = o.sigma1 != null ? +o.sigma1 : (+o.volatility || 0.2) / Math.sqrt(C.MIN_PER_YEAR);
    var F = +o.float || C.F_ref, ADV = +o.adv || 1e7;
    var H = clamp(+o.news || 0, 0, 1);
    var D = o.inCompletedDayBlock ? C.D_full_day : 1;
    if (!(S > 0) || !(N > 0)) {
      return { rate: 0, raw: 0, preDiscount: 0, E: 0, L: 1, H: H, D: D, G: 0, z: 0, sigma1: sigma1, sigma_h: 0, newsFactor: 1 + C.beta * H, clampedTo: null, constants: C };
    }
    var sigma_h = sigma1 * Math.sqrt(C.h);
    var z = (S - K) / (S * sigma_h);
    var Gz = G(z);
    var E = N * S * sigma_h * Gz;
    var Lfloat = Math.max(1, Math.pow(C.F_ref / F, C.alpha));
    var Lsize = 1 + C.gamma * N / ADV;
    var L = Lfloat * Lsize;
    var newsFactor = 1 + C.beta * H;
    var raw = C.c * E * L * newsFactor;
    var pre = clamp(raw, C.R_min, C.R_max);
    return {
      rate: pre * D, raw: raw, preDiscount: pre,
      clampedTo: raw < C.R_min ? 'floor' : raw > C.R_max ? 'cap' : null,
      E: E, G: Gz, z: z, sigma1: sigma1, sigma_h: sigma_h,
      L: L, Lfloat: Lfloat, Lsize: Lsize,
      H: H, newsFactor: newsFactor, D: D, constants: C
    };
  }

  /** $/min. The one swappable entry point used by the app. */
  function insuranceRatePerMinute(opts) { return insuranceRateBreakdown(opts).rate; }

  g.insuranceRatePerMinute = insuranceRatePerMinute;
  g.insuranceRateBreakdown = insuranceRateBreakdown;
  g.PARACORD_RATE_CONSTANTS = C;
  g.PARACORD_RATE_META = { placeholder: true, source: 'paracord-pricing-v1.md (draft v1)' };
  if (typeof module !== 'undefined') module.exports = { insuranceRatePerMinute: insuranceRatePerMinute, insuranceRateBreakdown: insuranceRateBreakdown, G: G, Phi: Phi };
})(typeof window !== 'undefined' ? window : globalThis);
