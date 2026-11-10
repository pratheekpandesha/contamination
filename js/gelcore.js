/* gelcore.js — image-analysis core for Gel Lane Analyzer (no DOM access).
 *
 * Conventions
 *   v[]  : intensity as stored in the image, normalised 0..1 (0 = black)
 *   S[]  : "band signal" = v (bright bands) or 1 - v (dark bands); bands are always positive in S
 *   d    : migration distance in px, measured down the lane from the centre of that lane's well
 */
(function (global) {
  'use strict';

  // ---------- small numeric helpers ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const odd = n => { n = Math.max(3, Math.round(n)); return n % 2 ? n : n + 1; };

  function movingAvg(a, w) {
    const n = a.length, r = Math.max(1, Math.floor(w / 2)), out = new Float64Array(n), ps = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + a[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
      out[i] = (ps[hi + 1] - ps[lo]) / (hi - lo + 1);
    }
    return out;
  }
  function movingExt(a, w, isMin) {
    const n = a.length, r = Math.max(1, Math.floor(w / 2)), out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
      let m = a[lo];
      for (let j = lo + 1; j <= hi; j++) { const x = a[j]; if (isMin ? x < m : x > m) m = x; }
      out[i] = m;
    }
    return out;
  }
  const movingMin = (a, w) => movingExt(a, w, true);
  const movingMax = (a, w) => movingExt(a, w, false);

  function medianFilter(a, w) {
    const n = a.length, r = Math.floor(w / 2), out = new Float64Array(n);
    // subsample the window for long windows (speed); medians are robust to this
    const step = Math.max(1, Math.floor(w / 60));
    const buf = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
      buf.length = 0;
      for (let j = lo; j <= hi; j += step) buf.push(a[j]);
      buf.sort((x, y) => x - y);
      out[i] = buf[buf.length >> 1];
    }
    return out;
  }
  function gaussSmooth(a, sigma) {
    if (sigma < 0.3) return Float64Array.from(a);
    const r = Math.ceil(sigma * 3), k = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, ws = 0;
      for (let j = -r; j <= r; j++) {
        const t = i + j;
        if (t < 0 || t >= n) continue;
        s += a[t] * k[j + r]; ws += k[j + r];
      }
      out[i] = s / ws;
    }
    return out;
  }
  function percentile(arr, p) {
    const a = Array.from(arr).sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[clamp(Math.round((p / 100) * (a.length - 1)), 0, a.length - 1)];
  }
  function median(arr) { return percentile(arr, 50); }
  function mad(arr) {
    const m = median(arr);
    return 1.4826 * median(Array.from(arr, x => Math.abs(x - m)));
  }
  function stdev(a) {
    let s = 0, s2 = 0;
    for (const x of a) { s += x; s2 += x * x; }
    const m = s / a.length;
    return Math.sqrt(Math.max(0, s2 / a.length - m * m));
  }
  function zscore(a) {
    let s = 0; for (const x of a) s += x;
    const m = s / a.length, sd = stdev(a) || 1;
    return Float64Array.from(a, x => (x - m) / sd);
  }
  /** local maxima with greedy non-maximum suppression */
  function findPeaks(a, minDist, minHeight) {
    const cand = [];
    for (let i = 1; i < a.length - 1; i++) {
      if (a[i] >= minHeight && a[i] > a[i - 1] && a[i] >= a[i + 1]) cand.push(i);
    }
    cand.sort((i, j) => a[j] - a[i]);
    const acc = [];
    for (const i of cand) if (acc.every(j => Math.abs(i - j) >= minDist)) acc.push(i);
    return acc.sort((i, j) => i - j);
  }
  function parabolic(a, i) {
    if (i <= 0 || i >= a.length - 1) return i;
    const den = a[i - 1] - 2 * a[i] + a[i + 1];
    if (den === 0) return i;
    return i + clamp(0.5 * (a[i - 1] - a[i + 1]) / den, -0.5, 0.5);
  }

  // ---------- image loading ----------
  function finishImage(v, w, h, bitDepth, rawMax) {
    // saturation: a value at the extreme of the range that occurs in many pixels
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < v.length; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
    let cmn = 0, cmx = 0;
    const eps = 0.5 / rawMax;
    for (let i = 0; i < v.length; i++) { const x = v[i]; if (x <= mn + eps) cmn++; if (x >= mx - eps) cmx++; }
    const need = Math.max(20, v.length * 1e-5);
    return {
      w, h, v, bitDepth,
      satLow: cmn >= need ? mn + eps : -1,
      satHigh: cmx >= need ? mx - eps : 2,
      min: mn, max: mx
    };
  }
  function fromRGBA(rgba, w, h) {
    const v = new Float32Array(w * h);
    for (let i = 0, j = 0; i < v.length; i++, j += 4) v[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    return finishImage(v, w, h, 8, 255);
  }
  function fromTIFF(buffer) {
    const UTIF = global.UTIF;
    if (!UTIF) throw new Error('TIFF decoder failed to load (check your internet connection).');
    const ifds = UTIF.decode(buffer);
    let ifd = null, best = 0;
    for (const f of ifds) {
      if (!f.t256) continue;
      const a = f.t256[0] * f.t257[0];
      if (a > best) { best = a; ifd = f; }
    }
    if (!ifd) throw new Error('No image found in TIFF.');
    UTIF.decodeImage(buffer, ifd, ifds);
    const w = ifd.width, h = ifd.height;
    const bps = ifd.t258 ? ifd.t258[0] : 1;
    const spp = ifd.t277 ? ifd.t277[0] : 1;
    const photo = ifd.t262 ? ifd.t262[0] : 1;
    const fmt = ifd.t339 ? ifd.t339[0] : 1;
    const d = ifd.data, n = w * h;
    let v = new Float32Array(n), rawMax = 255, depth = bps;
    if (spp === 1 && bps === 16) {
      // UTIF converts 16-bit data to little-endian
      rawMax = 65535;
      for (let i = 0; i < n; i++) v[i] = (d[2 * i] | (d[2 * i + 1] << 8)) / 65535;
    } else if (spp === 1 && bps === 8) {
      for (let i = 0; i < n; i++) v[i] = d[i] / 255;
    } else if (spp === 1 && bps === 32 && fmt === 3) {
      const f = new Float32Array(d.buffer, d.byteOffset, n);
      let mx = 0; for (let i = 0; i < n; i++) if (f[i] > mx) mx = f[i];
      for (let i = 0; i < n; i++) v[i] = f[i] / (mx || 1);
      rawMax = 65535;
    } else {
      const rgba = UTIF.toRGBA8(ifd);
      const im = fromRGBA(rgba, w, h);
      return im;
    }
    if (photo === 0) for (let i = 0; i < n; i++) v[i] = 1 - v[i]; // WhiteIsZero
    return finishImage(v, w, h, depth, rawMax);
  }

  // ---------- polarity ----------
  function detectDarkBands(img) {
    const { w, h, v } = img, s = [];
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 150000)));
    for (let y = Math.floor(h * 0.2); y < h * 0.8; y += step)
      for (let x = Math.floor(w * 0.2); x < w * 0.8; x += step) s.push(v[y * w + x]);
    const m = percentile(s, 50), lo = percentile(s, 0.3), hi = percentile(s, 99.7);
    return (m - lo) > (hi - m);
  }
  function makeSignal(img, dark) {
    const S = new Float32Array(img.v.length);
    if (dark) for (let i = 0; i < S.length; i++) S[i] = 1 - img.v[i];
    else S.set(img.v);
    return S;
  }

  // ---------- layout detection ----------
  function rowProfile(S, w, h, x0, x1) {
    const p = new Float64Array(h), step = Math.max(1, Math.floor((x1 - x0) / 600));
    for (let y = 0; y < h; y++) {
      let s = 0, c = 0;
      const o = y * w;
      for (let x = x0; x < x1; x += step) { s += S[o + x]; c++; }
      p[y] = s / c;
    }
    return p;
  }

  /** Wells show up with the opposite polarity to bands (empty slots), as narrow horizontal stripes. */
  function wellScoreProfile(S, w, h, x0, x1) {
    const p = rowProfile(S, w, h, x0, x1);
    const med = medianFilter(p, odd(h / 16));
    const sc = Float64Array.from(p, (x, i) => med[i] - x);
    return gaussSmooth(sc, Math.max(1, h / 1000));
  }

  function detectRows(S, w, h, opt) {
    opt = opt || {};
    const x0 = Math.floor(w * 0.06), x1 = Math.ceil(w * 0.94);
    const sc = wellScoreProfile(S, w, h, x0, x1);
    const noise = mad(sc) || 1e-6;
    let peaks = findPeaks(sc, Math.max(10, h / 14), 0);
    peaks = peaks.filter(i => i > h * 0.01 && i < h * 0.97);
    let rows;
    if (opt.rows) {
      rows = peaks.slice().sort((a, b) => sc[b] - sc[a]).slice(0, opt.rows).sort((a, b) => a - b);
    } else {
      const top = Math.max(0, ...peaks.map(i => sc[i]));
      rows = peaks.filter(i => sc[i] >= Math.max(0.22 * top, 5 * noise));
    }
    if (!rows.length) rows = [Math.round(h * 0.05)];

    // well thickness (FWHM) from the global profile
    const fw = rows.map(i => {
      const half = sc[i] / 2; let a = i, b = i;
      while (a > 0 && sc[a] > half) a--;
      while (b < h - 1 && sc[b] > half) b++;
      return b - a;
    });
    const fwhm = clamp(median(fw), 4, h / 20);

    // tilt: locate each well line in the left and right thirds of the gel
    const span = x1 - x0;
    const scL = wellScoreProfile(S, w, h, x0, x0 + Math.floor(span * 0.3));
    const scR = wellScoreProfile(S, w, h, x1 - Math.floor(span * 0.3), x1);
    const xL = x0 + span * 0.15, xR = x1 - span * 0.15, win = Math.max(5, Math.round(h / 40));
    const out = rows.map(yc => {
      const loc = (arr) => {
        let bi = yc, bv = -Infinity;
        for (let y = Math.max(0, yc - win); y <= Math.min(h - 1, yc + win); y++) if (arr[y] > bv) { bv = arr[y]; bi = y; }
        return parabolic(arr, bi);
      };
      const yl = loc(scL), yr = loc(scR);
      let slope = (yr - yl) / (xR - xL);
      if (!isFinite(slope) || Math.abs(slope) > 0.05) slope = 0;
      return { yc: parabolic(sc, yc), xc: w / 2, slope, fwhm };
    });
    // use a common slope (gel rotation affects all rows equally) — median is robust
    const ms = median(out.map(r => r.slope));
    out.forEach(r => { r.slope = ms; });
    return out;
  }

  /** y of the well line at x */
  const wellY = (row, x) => row.yc + row.slope * (x - row.xc);

  /** length (px) of the migration region below each row's wells */
  function rowLengths(rows, h) {
    const ys = rows.map(r => r.yc);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]);
    const typical = gaps.length ? median(gaps) : h - ys[0];
    return rows.map((r, i) => {
      const lim = i < rows.length - 1 ? ys[i + 1] - ys[i] - r.fwhm * 1.5 - 3 : Math.min(typical - r.fwhm * 0.8, h - 2 - ys[i] - Math.abs(r.slope) * r.xc);
      return Math.max(10, Math.floor(lim));
    });
  }

  function laneColumns(S, w, h, row, len) {
    const d0 = Math.round(row.fwhm * 0.9) + 2, hw = Math.max(2, Math.round(row.fwhm / 2));
    const colBand = new Float64Array(w), colWell = new Float64Array(w);
    const dStep = Math.max(1, Math.floor(len / 150));
    for (let x = 0; x < w; x++) {
      const yw = wellY(row, x);
      let s = 0, c = 0;
      for (let d = d0; d < len; d += dStep) {
        const y = Math.round(yw + d);
        if (y < 0 || y >= h) continue;
        s += S[y * w + x]; c++;
      }
      colBand[x] = c ? s / c : 0;
      s = 0; c = 0;
      for (let d = -hw; d <= hw; d++) {
        const y = Math.round(yw + d);
        if (y < 0 || y >= h) continue;
        s += S[y * w + x]; c++;
      }
      colWell[x] = c ? s / c : 0;
    }
    const win = odd(w / 10);
    const mb = medianFilter(colBand, win), mw = medianFilter(colWell, win);
    return {
      nb: zscore(Float64Array.from(colBand, (x, i) => x - mb[i])),
      nw: zscore(Float64Array.from(colWell, (x, i) => mw[i] - x))
    };
  }

  /** lane pitch shared by all rows (same comb) — summed autocorrelation */
  function lanePitch(cols, w) {
    const minLag = Math.max(8, Math.floor(w / 90)), maxLag = Math.floor(w / 4);
    const ac = new Float64Array(maxLag + 2);
    for (const { nb, nw } of cols) {
      for (let l = minLag; l <= maxLag + 1; l++) {
        let s1 = 0, s2 = 0;
        for (let i = 0; i + l < w; i++) { s1 += nb[i] * nb[i + l]; s2 += nw[i] * nw[i + l]; }
        ac[l] += (s1 + s2) / (w - l);
      }
    }
    const loc = [];
    for (let l = minLag + 1; l <= maxLag; l++) if (ac[l] > ac[l - 1] && ac[l] >= ac[l + 1] && ac[l] > 0) loc.push(l);
    if (!loc.length) return w / 12;
    const bv = Math.max(...loc.map(l => ac[l]));
    // the fundamental is the shortest lag with a strong autocorrelation peak (others are harmonics)
    const bi = loc.find(l => ac[l] >= 0.5 * bv);
    return parabolic(ac, bi);
  }

  function placeLanes(cols, w, P, nLanes) {
    const { nb, nw } = cols;
    const a = gaussSmooth(nb, P / 8), b = gaussSmooth(nw, P / 8);
    const comb = Float64Array.from(a, (x, i) => x + b[i]);
    const at = x => comb[clamp(Math.round(x), 0, w - 1)];
    let bestPhi = 0, bestS = -Infinity;
    for (let phi = 0; phi < P; phi += 0.5) {
      let s = 0;
      for (let x = phi; x < w; x += P) s += at(x);
      if (s > bestS) { bestS = s; bestPhi = phi; }
    }
    const centers = [];
    for (let x = bestPhi; x < w; x += P) if (x >= P * 0.45 && x <= w - P * 0.45) centers.push(x);
    const score = centers.map(c => at(c) - 0.5 * (at(c - P / 2) + at(c + P / 2)));
    let chosen;
    if (nLanes && nLanes <= centers.length) {
      let bs = -Infinity, bi = 0;
      for (let i = 0; i + nLanes <= centers.length; i++) {
        let s = 0; for (let j = i; j < i + nLanes; j++) s += score[j];
        if (s > bs) { bs = s; bi = i; }
      }
      chosen = centers.slice(bi, bi + nLanes);
    } else {
      const top = score.slice().sort((x, y) => y - x);
      const ref = top.length ? median(top.slice(0, Math.max(1, Math.ceil(top.length / 2)))) : 0;
      const okIdx = score.map((s, i) => (s > 0.25 * ref ? i : -1)).filter(i => i >= 0);
      chosen = okIdx.length ? centers.slice(okIdx[0], okIdx[okIdx.length - 1] + 1) : centers;
    }
    return { centers, chosen, nb };
  }

  function refineLanes(chosen, nb, w, P) {
    // refine each centre on its band signal (centroid of positive band columns)
    return chosen.map(c => {
      let s = 0, sx = 0, mx = 0;
      const r = Math.round(P * 0.45);
      for (let x = Math.round(c - r); x <= Math.round(c + r); x++) {
        if (x < 0 || x >= w) continue;
        const val = nb[x];
        if (val > mx) mx = val;
        if (val > 0) { s += val; sx += val * x; }
      }
      let x = c;
      if (mx > 1 && s > 0) x = clamp(sx / s, c - P * 0.2, c + P * 0.2);
      return { x };
    });
  }

  /** detect lanes for every row; returns pitch and fills row.lanes */
  function detectLanes(S, w, h, rows, lens, opt) {
    opt = opt || {};
    const cols = rows.map((r, i) => laneColumns(S, w, h, r, lens[i]));
    const P = opt.pitch || lanePitch(cols, w);
    const placed = cols.map(c => placeLanes(c, w, P, opt.lanes));
    if (!opt.lanes && rows.length > 1) {
      // all rows share one comb: use the consensus lane extent (rescues empty lanes at row ends)
      const firsts = placed.filter(p => p.chosen.length).map(p => p.chosen[0]);
      const lasts = placed.filter(p => p.chosen.length).map(p => p.chosen[p.chosen.length - 1]);
      const xa = median(firsts) - P / 2, xb = median(lasts) + P / 2;
      placed.forEach(p => { p.chosen = p.centers.filter(c => c > xa && c < xb); });
    }
    rows.forEach((r, i) => { r.lanes = refineLanes(placed[i].chosen, placed[i].nb, w, P); });
    return P;
  }

  // ---------- per-lane analysis ----------
  function laneProfile(S, w, h, row, x, len, halfW) {
    const p = new Float64Array(len);
    const y0 = wellY(row, x);
    for (let d = 0; d < len; d++) {
      const y = Math.round(y0 + d);
      if (y < 0 || y >= h) { p[d] = d ? p[d - 1] : 0; continue; }
      const xc = x - row.slope * d;
      let s = 0, c = 0;
      for (let xi = Math.round(xc - halfW); xi <= Math.round(xc + halfW); xi++) {
        if (xi < 0 || xi >= w) continue;
        s += S[y * w + xi]; c++;
      }
      p[d] = c ? s / c : 0;
    }
    return p;
  }

  function analyzeLane(img, S, row, lane, len, P, params) {
    const { w, h } = img;
    const halfW = Math.max(1, Math.round((P * params.laneWidthFrac) / 2));
    const d0 = Math.round(row.fwhm * 0.9) + 2;
    const raw = laneProfile(S, w, h, row, lane.x, len, halfW);
    const p = raw.subarray(d0);
    const bgW = odd(P * params.bgWindowFrac);
    const base = movingAvg(movingMax(movingMin(p, bgW), bgW), Math.max(3, Math.round(bgW / 2)));
    const corr = Float64Array.from(p, (x, i) => x - base[i]);
    const sm = gaussSmooth(corr, Math.max(0.8, P / 50));
    // noise from the quiet part of the lane: 30th percentile of |signal| (= 0.385 σ for Gaussian noise).
    // A plain MAD is inflated in ladder lanes, where most of the lane is signal.
    const noise = Math.max(percentile(Array.from(sm, Math.abs), 30) / 0.385, 1e-5);
    const minDist = Math.max(3, Math.round(P / 14));
    const edge = Math.max(6, Math.round(P / 7)); // ignore the lane end, where it runs into the next row's wells
    const idx = findPeaks(sm, minDist, noise * params.detectSNR).filter(i => i < sm.length - edge);
    const peaks = idx.map(i => bandAt(img, row, lane, corr, sm, i, d0, halfW, noise));
    lane.profile = { raw, base: Float64Array.from({ length: raw.length }, (_, i) => (i < d0 ? NaN : base[i - d0])), corr, sm, d0, halfW, noise };
    lane.peaks = peaks;
    return lane;
  }

  /** build a band record around sample index i (index into corr/sm, i.e. d = i + d0) */
  function bandAt(img, row, lane, corr, sm, i, d0, halfW, noise) {
    const hgt = sm[i];
    const stop = Math.max(0.05 * hgt, noise);
    let a = i, b = i;
    while (a > 0 && sm[a - 1] < sm[a] && sm[a - 1] > stop) a--;
    while (b < sm.length - 1 && sm[b + 1] < sm[b] && sm[b + 1] > stop) b++;
    let area = 0;
    for (let k = a; k <= b; k++) area += Math.max(0, corr[k]);
    const vol = area * (2 * halfW + 1);
    const sat = saturation(img, row, lane.x, a + d0, b + d0, halfW);
    return { d: parabolic(sm, i) + d0, i, h: hgt, a: a + d0, b: b + d0, vol, snr: hgt / noise, sat };
  }

  function saturation(img, row, x, da, db, halfW) {
    const { w, h, v, satLow, satHigh } = img;
    const y0 = wellY(row, x);
    let n = 0, s = 0;
    for (let d = da; d <= db; d++) {
      const y = Math.round(y0 + d); if (y < 0 || y >= h) continue;
      const xc = x - row.slope * d;
      for (let xi = Math.round(xc - halfW); xi <= Math.round(xc + halfW); xi++) {
        if (xi < 0 || xi >= w) continue;
        const val = v[y * w + xi];
        n++; if (val <= satLow || val >= satHigh) s++;
      }
    }
    return n ? s / n : 0;
  }

  /** quantify a band at an arbitrary position d (used when the user clicks somewhere without a detected band) */
  function bandAtD(img, row, lane, d) {
    const pr = lane.profile; if (!pr) return null;
    const i0 = Math.round(d - pr.d0);
    const r = 4;
    let bi = clamp(i0, 0, pr.sm.length - 1);
    for (let i = Math.max(0, i0 - r); i <= Math.min(pr.sm.length - 1, i0 + r); i++) if (pr.sm[i] > pr.sm[bi]) bi = i;
    const b = bandAt(img, row, lane, pr.corr, pr.sm, bi, pr.d0, pr.halfW, pr.noise);
    b.manual = true;
    return b;
  }

  /** integrate the corrected profile over a fixed window (for absent bands at the expected position) */
  function windowVolume(lane, dCenter, halfH) {
    const pr = lane.profile; if (!pr) return 0;
    let s = 0;
    for (let d = Math.round(dCenter - halfH); d <= Math.round(dCenter + halfH); d++) {
      const i = d - pr.d0;
      if (i >= 0 && i < pr.corr.length) s += Math.max(0, pr.corr[i]);
    }
    return s * (2 * pr.halfW + 1);
  }

  // ---------- ladder fitting ----------
  /**
   * Assign ladder sizes to detected ladder peaks.
   * peaks: [{d, h}] ; sizes: bp (any order) ; bright: bp of reference bands (optional)
   * returns { pairs: [{peak, size}], quality }
   */
  function fitLadder(peaks, sizes, bright, manual, prior) {
    const S = sizes.slice().sort((a, b) => b - a);
    const L = S.map(s => Math.log10(s));
    const pk = peaks.slice().sort((a, b) => a.d - b.d);
    const tol = 0.035; // ~8% in size
    if (manual && Object.keys(manual).length >= 2) return fromManual(pk, manual);
    if (pk.length < 2 || S.length < 2) return { pairs: [], quality: -Infinity };
    const maxH = Math.max(...pk.map(p => p.h));
    const strong = pk.filter(p => p.h > 0.04 * maxH);
    const P = strong.length >= 2 ? strong : pk;
    const brightSet = new Set(bright || []);

    function assign(predict) {
      // greedy monotonic assignment: each peak to nearest size within tol, keeping order
      const pairs = []; let lastJ = -1;
      for (const p of P) {
        const ls = predict(p.d);
        let bj = -1, be = Infinity;
        for (let j = lastJ + 1; j < L.length; j++) {
          const e = Math.abs(L[j] - ls);
          if (e < be) { be = e; bj = j; }
        }
        if (bj >= 0 && be < tol) { pairs.push({ peak: p, j: bj, err: be }); lastJ = bj; }
      }
      return pairs;
    }
    function refine(pairs) {
      for (let it = 0; it < 2 && pairs.length >= 4; it++) {
        const q = polyfit(pairs.map(p => p.peak.d), pairs.map(p => L[p.j]), 2);
        if (!q) break;
        const pairs2 = assign(d => q[0] + q[1] * d + q[2] * d * d);
        if (pairs2.length >= pairs.length) pairs = pairs2; else break;
      }
      return pairs;
    }
    function scorePairs(pairs) {
      if (pairs.length < 2) return -Infinity;
      const j0 = pairs[0].j, j1 = pairs[pairs.length - 1].j;
      const dmin = pairs[0].peak.d, dmax = pairs[pairs.length - 1].peak.d;
      let missing = 0, missingBright = 0;
      for (let j = j0; j <= j1; j++) if (!pairs.some(q => q.j === j)) { missing++; if (brightSet.has(S[j])) missingBright++; }
      const unexplained = P.filter(p => p.d > dmin && p.d < dmax && !pairs.some(q => q.peak === p) && p.h > 0.15 * maxH).length;
      let err = 0; for (const q of pairs) err += q.err;
      let sc = pairs.length - 0.5 * missing - 0.7 * unexplained - (err / pairs.length) / tol;
      if (brightSet.size) {
        // reference bands must look brighter than ordinary bands
        const hb = pairs.filter(q => brightSet.has(S[q.j])).map(q => q.peak.h);
        const hn = pairs.filter(q => !brightSet.has(S[q.j])).map(q => q.peak.h);
        const medN = hn.length ? median(hn) : 0;
        hb.forEach(h => { sc += h > 1.2 * medN ? 0.8 : -0.4; });
        if (hb.length) { const top = Math.max(...hb); hn.forEach(h => { if (h > 1.15 * top) sc -= 0.5; }); }
        sc -= 0.6 * missingBright;
      }
      return sc;
    }
    let best = null, bestScore = -Infinity;
    const consider = pairs => { const sc = scorePairs(pairs); if (sc > bestScore) { bestScore = sc; best = pairs; } };
    if (prior) {
      // consensus: reuse the calibration of the best ladder on this gel, allowing for a different run length
      for (let s = 0.8; s <= 1.25; s += 0.005) consider(refine(assign(d => prior.toLog(d * s))));
    } else {
      for (let i = 0; i < P.length; i++) for (let k = i + 1; k < P.length; k++) {
        for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length; b++) {
          const m = (L[b] - L[a]) / (P[k].d - P[i].d);
          const c = L[a] - m * P[i].d;
          consider(refine(assign(d => m * d + c)));
        }
      }
    }
    if (!best) return { pairs: [], quality: -Infinity };
    return { pairs: best.map(q => ({ peak: q.peak, size: S[q.j] })), quality: bestScore };
  }
  function fromManual(pk, manual) {
    const pairs = [];
    for (const p of pk) {
      const key = Math.round(p.d);
      for (const k in manual) if (Math.abs(+k - key) <= 2 && manual[k]) { pairs.push({ peak: p, size: manual[k] }); break; }
    }
    return { pairs, quality: 99, manual: true };
  }

  function polyfit(x, y, deg) {
    const n = deg + 1, A = Array.from({ length: n }, () => new Float64Array(n + 1));
    for (let i = 0; i < x.length; i++) {
      const pw = [1]; for (let k = 1; k < 2 * n; k++) pw.push(pw[k - 1] * x[i]);
      for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += pw[r + c]; A[r][n] += pw[r] * y[i]; }
    }
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map((r, i) => r[n] / r[i]);
  }

  /** calibration: piecewise-linear interpolation of log10(size) vs d through the matched ladder bands */
  function makeCalibration(pairs) {
    const pts = pairs.map(p => [p.peak.d, Math.log10(p.size)]).sort((a, b) => a[0] - b[0]);
    // enforce strictly decreasing log size
    const clean = [];
    for (const p of pts) if (!clean.length || (p[1] < clean[clean.length - 1][1] && p[0] > clean[clean.length - 1][0])) clean.push(p);
    if (clean.length < 2) return null;
    const n = clean.length;
    const toLog = d => {
      let i = 0;
      if (d <= clean[0][0]) i = 0;
      else if (d >= clean[n - 1][0]) i = n - 2;
      else while (i < n - 2 && d > clean[i + 1][0]) i++;
      const [x0, y0] = clean[i], [x1, y1] = clean[i + 1];
      return y0 + ((y1 - y0) * (d - x0)) / (x1 - x0);
    };
    const toD = ls => {
      let i = 0;
      if (ls >= clean[0][1]) i = 0;
      else if (ls <= clean[n - 1][1]) i = n - 2;
      else while (i < n - 2 && ls < clean[i + 1][1]) i++;
      const [x0, y0] = clean[i], [x1, y1] = clean[i + 1];
      return x0 + ((ls - y0) * (x1 - x0)) / (y1 - y0);
    };
    // fit quality: residuals of a quadratic through the points (shows a band that was mis-assigned)
    let r2 = null;
    if (n >= 4) {
      const q = polyfit(clean.map(p => p[0]), clean.map(p => p[1]), 2);
      if (q) {
        const ys = clean.map(p => p[1]), m = ys.reduce((a, b) => a + b, 0) / n;
        let ssr = 0, sst = 0;
        clean.forEach(([x, y]) => { const f = q[0] + q[1] * x + q[2] * x * x; ssr += (y - f) ** 2; sst += (y - m) ** 2; });
        r2 = 1 - ssr / sst;
      }
    }
    return { toLog, toD, points: clean, r2, dMin: clean[0][0], dMax: clean[n - 1][0] };
  }

  global.GelCore = {
    clamp, median, mad, percentile, gaussSmooth, findPeaks,
    fromRGBA, fromTIFF, detectDarkBands, makeSignal,
    detectRows, detectLanes, rowLengths, wellY,
    analyzeLane, bandAtD, windowVolume, fitLadder, makeCalibration
  };
})(typeof window !== 'undefined' ? window : globalThis);
