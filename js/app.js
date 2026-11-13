/* app.js — UI for Gel Lane Analyzer */
(function () {
  'use strict';
  const G = window.GelCore;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const LADDER_RE = /^(ladder|marker|mw|dna ladder|l|m|lad|mkr)\b/i;
  const fmtBp = s => (s == null || !isFinite(s) ? '' : s >= 10000 ? (s / 1000).toFixed(1) + ' kb' : Math.round(s) + '');
  /** "550, 320" / "550;320" / 550 → [550, 320] */
  const parseSizes = v => (String(v == null ? '' : v).match(/\d+(\.\d+)?/g) || []).map(Number).filter(x => x > 0);
  const fmtList = a => (a && a.length ? a.join(', ') : '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = {
    img: null, S: null, dark: true, name: '',
    rows: [], lens: [], P: 0,
    labels: [],              // [{label, expected}]
    ladders: [], defaultLadder: 'neb-100bp',
    sel: null,               // {r, l, band}
    ref: null,               // {r, l} reference lane for relative intensity
    zoom: 1, edit: false, drag: null,
    disp: null,              // offscreen canvas with display image
    margins: { l: 0, r: 0, t: 0, b: 0 },
    style: { size: 100, lane: null, ladder: null, band: null, bold: true, onBand: false }
  };
  const params = () => ({
    tol: +$('#tol').value || 10,
    minSNR: +$('#minSNR').value || 6,
    minRel: +$('#minRel').value || 0,
    faintSNR: +$('#faintSNR').value || 3,
    dimerBp: +$('#dimerBp').value || 0,
    laneWidthFrac: (+$('#laneWidth').value || 60) / 100,
    bgWindowFrac: +$('#bgWin').value || 1,
    detectSNR: 3,
    expected: parseSizes($('#expected').value)
  });

  // ================= Ladder database =================
  const LS_LADDERS = 'gla.ladders.v1', LS_PREFS = 'gla.prefs.v1';
  let labLadders = [];
  function readLS(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  function mergeLadders() {
    const user = readLS(LS_LADDERS, { ladders: [], deleted: [] });
    const map = new Map();
    for (const l of window.BUILTIN_LADDERS) map.set(l.id, { ...l, source: 'built-in' });
    for (const l of labLadders) map.set(l.id, { ...l, source: 'lab' });
    for (const l of user.ladders) map.set(l.id, { ...l, source: map.has(l.id) ? 'edited' : 'custom' });
    for (const id of user.deleted || []) map.delete(id);
    state.ladders = Array.from(map.values());
  }
  function saveUserLadder(l) {
    const user = readLS(LS_LADDERS, { ladders: [], deleted: [] });
    user.ladders = user.ladders.filter(x => x.id !== l.id).concat([{ id: l.id, name: l.name, catalog: l.catalog, sizes: l.sizes, bright: l.bright }]);
    user.deleted = (user.deleted || []).filter(id => id !== l.id);
    writeLS(LS_LADDERS, user);
    mergeLadders();
  }
  function deleteUserLadder(id) {
    const user = readLS(LS_LADDERS, { ladders: [], deleted: [] });
    user.ladders = user.ladders.filter(x => x.id !== id);
    if (window.BUILTIN_LADDERS.some(l => l.id === id) || labLadders.some(l => l.id === id)) user.deleted = (user.deleted || []).concat([id]);
    writeLS(LS_LADDERS, user);
    mergeLadders();
  }
  const getLadder = id => state.ladders.find(l => l.id === id) || state.ladders[0];
  function ladderOptions(sel, includeDefault) {
    return (includeDefault ? `<option value="">(default)</option>` : '') +
      state.ladders.map(l => `<option value="${esc(l.id)}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  }
  function renderLadderSelect() {
    if (!state.ladders.some(l => l.id === state.defaultLadder) && state.ladders.length) state.defaultLadder = state.ladders[0].id;
    $('#ladderSel').innerHTML = ladderOptions(state.defaultLadder);
    previewLadder($('#ladderPreview'), getLadder(state.defaultLadder));
  }
  function previewLadder(el, l) {
    if (!l) { el.innerHTML = ''; return; }
    const b = new Set(l.bright || []);
    el.innerHTML = l.sizes.slice().sort((a, c) => c - a).map(s => `<span class="${b.has(s) ? 'b' : ''}">${fmtBp(s)}</span>`).join('');
  }

  // ---- ladder dialog ----
  let dlgSel = null;
  function openLadderDlg() { dlgSel = state.defaultLadder; renderDlg(); $('#ladderDlg').showModal(); }
  function renderDlg() {
    $('#ladderList').innerHTML = state.ladders.map(l =>
      `<li data-id="${esc(l.id)}" class="${l.id === dlgSel ? 'on' : ''}">${esc(l.name)}<small>${esc(l.catalog || '')} · ${l.sizes.length} bands · ${l.source}</small></li>`).join('');
    const l = getLadder(dlgSel) || { name: '', catalog: '', sizes: [], bright: [] };
    $('#ldName').value = l.name; $('#ldCat').value = l.catalog || '';
    $('#ldSizes').value = l.sizes.slice().sort((a, b) => b - a).join(', ');
    $('#ldBright').value = (l.bright || []).join(', ');
    $('#ldSrc').textContent = l.source === 'built-in' ? 'Built-in ladder (values from the manufacturer datasheet). Saving creates your edited copy.' :
      l.source === 'lab' ? 'From lab-ladders.json in the website repo.' : l.source === 'edited' ? 'Your edited version of a built-in/lab ladder.' : 'Your custom ladder.';
    previewLadder($('#ldPreview'), l);
  }
  const parseNums = s => (s.match(/\d+(\.\d+)?/g) || []).map(Number).filter(x => x > 0);
  function dlgSave(asNew) {
    const sizes = Array.from(new Set(parseNums($('#ldSizes').value))).sort((a, b) => b - a);
    if (sizes.length < 2) return toast('A ladder needs at least 2 band sizes.');
    const name = $('#ldName').value.trim() || 'Custom ladder';
    const id = asNew || !dlgSel ? 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36) : dlgSel;
    saveUserLadder({ id, name, catalog: $('#ldCat').value.trim(), sizes, bright: parseNums($('#ldBright').value) });
    dlgSel = id; renderDlg(); renderLadderSelect(); reanalyze(); toast('Ladder saved');
  }

  // ================= Image loading =================
  async function loadImageFile(file) {
    try {
      toast('Loading ' + file.name + '…', 60000);
      let img;
      if (/\.tiff?$/i.test(file.name) || file.type === 'image/tiff') {
        img = G.fromTIFF(await file.arrayBuffer());
      } else {
        const bmp = await createImageBitmap(file);
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0);
        img = G.fromRGBA(cx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      }
      state.img = img; state.name = file.name.replace(/\.[^.]+$/, '');
      state.sel = null; state.ref = null;
      $('#imgInfo').innerHTML = `${esc(file.name)} · ${img.w}×${img.h} · ${img.bitDepth}-bit` +
        (img.binned ? ` · averaged ${img.binned}× from ${img.origW}×${img.origH}` : '') +
        (img.bitDepth === 8 ? ' · <span class="warn">8-bit export: fine for sizing and calls; for quantification export the raw 16-bit TIFF</span>' : '');
      setupSignal();
      detectLayout();
      $('#emptyState').hidden = true; $('#canvas').hidden = false;
      $$('#exportPng,#exportCsv,#exportXlsx').forEach(b => (b.disabled = false));
      fitZoom();
      toast(`Found ${state.rows.length} row(s) × ${state.rows[0] ? state.rows[0].lanes.length : 0} lanes`);
    } catch (e) {
      console.error(e); toast('Could not read image: ' + e.message, 6000);
    }
  }
  function setupSignal() {
    const pol = $('#polarity').value;
    state.dark = pol === 'auto' ? G.detectDarkBands(state.img) : pol === 'dark';
    state.S = G.makeSignal(state.img, state.dark);
    buildDisplay();
  }
  function buildDisplay() {
    const { w, h, v } = state.img;
    const sample = []; const st = Math.max(1, Math.floor(v.length / 200000));
    for (let i = 0; i < v.length; i += st) sample.push(v[i]);
    const lo = G.percentile(sample, 0.2), hi = G.percentile(sample, 99.8);
    const inv = $('#invertDisp').checked;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d'); const id = cx.createImageData(w, h);
    const k = 255 / Math.max(1e-6, hi - lo);
    for (let i = 0, j = 0; i < v.length; i++, j += 4) {
      let g = (v[i] - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g; if (inv) g = 255 - g;
      id.data[j] = id.data[j + 1] = id.data[j + 2] = g; id.data[j + 3] = 255;
    }
    cx.putImageData(id, 0, 0);
    state.disp = c;
  }

  // ================= Layout =================
  function combLanes() { const c = +$('#comb').value; return c || +$('#nLanes').value || null; }
  function detectLayout() {
    const { w, h } = state.img;
    const rows = G.detectRows(state.S, w, h, { rows: +$('#nRows').value || null });
    const lens = G.rowLengths(rows, h);
    state.P = G.detectLanes(state.S, w, h, rows, lens, { lanes: combLanes() });
    rows.forEach(r => { r.expected = null; r.ladderId = ''; r.lanes.forEach(l => { l.ladderOverride = undefined; }); });
    state.rows = rows;
    reanalyze();
  }
  function sortLayout() {
    state.rows.sort((a, b) => a.yc - b.yc);
    state.rows.forEach(r => r.lanes.sort((a, b) => a.x - b.x));
    state.lens = G.rowLengths(state.rows, state.img.h);
  }
  function assignLabelsAndLadders() {
    let k = 0;
    const mode = $('#ladderPos').value;
    const fromLabels = mode === 'auto' && state.labels.some(x => LADDER_RE.test(x.label));
    state.rows.forEach((r, ri) => {
      const grid = state.labelGrid;
      r.lanes.forEach((l, li) => {
        const lab = grid ? (grid[ri] || [])[li] : state.labels[k];
        k++;
        l.label = l.labelEdited ? l.label : (lab ? lab.label : '');
        l.expected = l.expectedEdited ? l.expected : (lab && lab.expected && lab.expected.length ? lab.expected : null);
        let isL;
        if (fromLabels) isL = LADDER_RE.test(l.label || '');
        else if (mode === 'auto') isL = null; // decided from the band pattern after analysis
        else if (mode === 'first') isL = li === 0;
        else if (mode === 'last') isL = li === r.lanes.length - 1;
        else if (mode === 'both') isL = li === 0 || li === r.lanes.length - 1;
        else isL = false;
        l.ladderScore = null;
        l.isLadder = l.ladderOverride !== undefined ? l.ladderOverride : isL;
      });
    });
  }

  // ================= Analysis =================
  function laneLogAt(r, lane, d) {
    if (lane.isLadder && lane.cal) return lane.cal.toLog(d);
    const lads = r.lanes.filter(l => l.isLadder && l.cal);
    if (!lads.length) return null;
    let left = null, right = null;
    for (const l of lads) {
      if (l.x <= lane.x && (!left || l.x > left.x)) left = l;
      if (l.x >= lane.x && (!right || l.x < right.x)) right = l;
    }
    if (left && right && left !== right) {
      const t = (lane.x - left.x) / (right.x - left.x);
      return (1 - t) * left.cal.toLog(d) + t * right.cal.toLog(d);
    }
    return (left || right).cal.toLog(d);
  }
  function laneDAt(r, lane, logS) {
    // laneLogAt is monotone decreasing in d — bisection
    let a = -state.P, b = state.lens[state.rows.indexOf(r)] * 2;
    const fa = laneLogAt(r, lane, a);
    if (fa == null) return null;
    for (let i = 0; i < 50; i++) {
      const m = (a + b) / 2;
      if (laneLogAt(r, lane, m) > logS) a = m; else b = m;
    }
    return (a + b) / 2;
  }

  function reanalyze() {
    if (!state.img) return;
    sortLayout();
    assignLabelsAndLadders();
    const p = params(), { img, S, P } = state;
    const tolLog = Math.log10(1 + p.tol / 100);
    state.rows.forEach((r, ri) => {
      const len = state.lens[ri];
      r.lanes.forEach(l => G.analyzeLane(img, S, r, l, len, P, p));
      // auto mode: a ladder lane has many bands spread down the lane; sample lanes have 1–3
      const undecided = r.lanes.filter(l => l.isLadder === null);
      if (undecided.length) {
        const score = l => {
          const mx = Math.max(1e-9, ...l.peaks.map(q => q.h));
          const pk = l.peaks.filter(q => q.h >= 0.1 * mx && q.snr >= 4);
          return pk.length >= 2 && pk[pk.length - 1].d - pk[0].d >= 0.15 * len ? pk.length : Math.min(pk.length, 1);
        };
        r.lanes.forEach(l => { l.ladderScore = score(l); });
        const typical = G.median(r.lanes.map(l => l.ladderScore));
        // a ladder lane has clearly more bands than a typical sample lane in the same row
        undecided.forEach(l => { l.isLadder = l.ladderScore >= 4 && l.ladderScore >= typical + 2; });
        if (!r.lanes.some(l => l.isLadder)) {
          // nothing ladder-like: fall back to the most ladder-like lane, else the first lane
          const best = undecided.slice().sort((a, b) => b.ladderScore - a.ladderScore)[0];
          (best && best.ladderScore >= 4 ? best : r.lanes[0]).isLadder = true;
        }
      }
      const rowMax = Math.max(1e-9, ...r.lanes.flatMap(l => l.peaks.map(q => q.h)));
      r.lanes.forEach(l => {
        const laneMax = Math.max(1e-9, ...l.peaks.map(q => q.h));
        l.peaks = l.peaks.filter(q => (l.isLadder ? q.h >= 0.03 * laneMax : q.h >= 0.02 * rowMax));
      });
      // ladders: independent fit first
      r.lanes.forEach(l => {
        l.fit = null; l.cal = null; l.calRejected = false;
        if (!l.isLadder) return;
        const lad = getLadder(l.ladderId || r.ladderId || state.defaultLadder);
        l.ladder = lad;
        l.fit = G.fitLadder(l.peaks, lad.sizes, lad.bright, l.manualMap);
        // fewer than 4 matched bands is not a ladder (e.g. an empty lane at the end of a row)
        l.cal = l.fit.manual || l.fit.pairs.length >= 4 ? G.makeCalibration(l.fit.pairs) : null;
        l.noBands = !l.cal && !l.fit.manual;
      });
    });
    // auto-detected ladders must look like the other ladders on the gel: their top band starts at a similar distance
    const autoL = state.rows.flatMap(r => r.lanes.filter(l => l.isLadder && l.ladderScore != null && l.ladderOverride === undefined && l.peaks.length));
    const firstD = l => { const mx = Math.max(...l.peaks.map(q => q.h)); return l.peaks.find(q => q.h >= 0.1 * mx).d; };
    if (autoL.length >= 3) {
      const m = G.median(autoL.map(firstD));
      autoL.forEach(l => { if (Math.abs(firstD(l) / m - 1) > 0.25) { l.isLadder = false; l.fit = null; l.cal = null; } });
    }
    // consensus across the gel: ladders of the same type should agree. Re-fit the weaker ones using the
    // best-scoring ladder as a template; keep the template-guided fit unless it is clearly worse.
    const allLads = state.rows.flatMap(r => r.lanes.filter(l => l.isLadder && l.fit));
    const byType = new Map();
    allLads.forEach(l => (byType.get(l.ladder.id) || byType.set(l.ladder.id, []).get(l.ladder.id)).push(l));
    byType.forEach(group => {
      const best = group.filter(l => l.cal && !l.fit.manual).sort((a, b) => b.fit.quality - a.fit.quality)[0];
      if (!best) return;
      group.forEach(l => {
        if (l === best || l.fit.manual || l.noBands) return;
        const f2 = G.fitLadder(l.peaks, l.ladder.sizes, l.ladder.bright, null, best.cal);
        if (f2.pairs.length >= 3 && (f2.quality >= l.fit.quality - 1.5 || f2.pairs.length >= 0.8 * l.fit.pairs.length)) {
          const c2 = G.makeCalibration(f2.pairs);
          if (c2) { l.fit = f2; l.fit.consensus = true; l.cal = c2; }
        }
      });
    });
    // two ladders in one row must agree; if they don't, trust only the better-fitting one
    state.rows.forEach(r => {
      r.ladderConflict = null;
      const cals = r.lanes.filter(l => l.isLadder && l.cal);
      if (cals.length < 2) return;
      const bestL = cals.slice().sort((a, b) => (b.fit.manual ? 1e9 : b.fit.quality) - (a.fit.manual ? 1e9 : a.fit.quality))[0];
      cals.forEach(l => {
        if (l === bestL) return;
        // ladders across a row may run further or shorter (smiling), but the same band must sit at a consistent
        // relative distance; inconsistent ratios mean one ladder's bands were mis-assigned
        const dA = new Map(bestL.fit.pairs.map(q => [q.size, q.peak.d]));
        const ratios = l.fit.pairs.filter(q => dA.has(q.size)).map(q => q.peak.d / dA.get(q.size));
        const bad = ratios.length < 2 || Math.max(...ratios) / Math.min(...ratios) > 1.12;
        if (bad) {
          l.calRejected = true; l.cal = null;
          r.ladderConflict = `Ladder lanes ${r.lanes.indexOf(bestL) + 1} and ${r.lanes.indexOf(l) + 1} have inconsistent band assignments. Using lane ${r.lanes.indexOf(bestL) + 1} only; check the other ladder in "Rows & ladder fit".`;
        }
      });
    });
    state.rows.forEach((r, ri) => {
      const len = state.lens[ri];
      // sizes; bands below the primer-dimer cutoff are reported but never used as the target band
      // largest ladder band actually matched in this row: anything far above it is well residue, not product
      const ladMax = Math.max(0, ...r.lanes.filter(l => l.isLadder && l.cal).flatMap(l => l.fit.pairs.map(pr => pr.size)));
      r.lanes.forEach(l => {
        const Es = l.isLadder ? [] : (l.expected && l.expected.length ? l.expected : r.expected && r.expected.length ? r.expected : p.expected);
        l.Es = Es.slice().sort((a, b) => b - a);
        l.E = l.Es[0] || null; // kept for older code paths (first / largest expected size)
        // dimers are discarded unless the user is actually looking for a product in the dimer range
        l.allowSmall = !!(p.dimerBp && l.Es.some(E => E < p.dimerBp));
        l.peaks.forEach(q => {
          const ls = laneLogAt(r, l, q.d); q.size = ls == null ? null : Math.pow(10, ls);
          q.sizeManual = false;
          if (l.sizeOverrides) for (const k in l.sizeOverrides) if (Math.abs(+k - q.d) <= 3) { q.size = l.sizeOverrides[k]; q.sizeManual = true; }
          q.dimer = !l.isLadder && !l.allowSmall && !!(p.dimerBp && q.size && q.size < p.dimerBp);
          q.aboveRange = !l.isLadder && !!(ladMax && q.size && q.size > ladMax * 1.5);
        });
      });
      markDimerFront(r, len, p);
      // spill-over: a faint band level with a much stronger band in the neighbouring lane is light/DNA from that lane
      r.lanes.forEach((l, li) => {
        if (l.isLadder) return;
        const nb = [r.lanes[li - 1], r.lanes[li + 1]].filter(Boolean);
        l.peaks.forEach(q => {
          q.spill = nb.some(n => n.peaks.some(o => Math.abs(o.d - q.d) <= Math.max(4, (o.b - o.a) / 2) && o.h >= 4 * q.h));
        });
      });
      r.lanes.forEach(l => {
        const dm = l.peaks.filter(q => q.dimer);
        l.dimer = dm.length ? dm.reduce((a, b) => (b.vol > a.vol ? b : a)) : null;
      });
      // targets — one per expected size; each expected band is called on its own
      const samples = r.lanes.filter(l => !l.isLadder);
      samples.forEach(l => {
        const real = l.peaks.filter(q => !q.dimer && !q.aboveRange && !q.spill);
        if (l.Es.length) {
          const used = new Set();
          l.targets = l.Es.map(E => {
            const c = real.filter(q => !used.has(q) && q.size && Math.abs(Math.log10(q.size / E)) <= tolLog);
            const band = c.length ? c.reduce((x, y) => (y.h > x.h ? y : x)) : null; // strongest band in this size window
            if (band) used.add(band);
            return { E, band, call: null };
          });
        } else {
          const band = real.length ? real.reduce((x, y) => (y.h > x.h ? y : x)) : null;
          l.targets = [{ E: null, band, call: null }];
        }
      });
      // reference height per expected size (brightest band of that size in the row)
      const keyE = E => (E == null ? 'any' : String(E));
      const refH = {};
      samples.forEach(l => l.targets.forEach(t => { if (t.band) refH[keyE(t.E)] = Math.max(refH[keyE(t.E)] || 1e-9, t.band.h); }));
      const halfs = samples.flatMap(l => l.targets.filter(t => t.band).map(t => (t.band.b - t.band.a) / 2));
      const bandHalf = halfs.length ? G.median(halfs) : P / 6;
      samples.forEach(l => {
        l.targets.forEach(t => {
          const b = t.band;
          if (b) {
            t.call = b.snr >= p.minSNR && b.h >= (p.minRel / 100) * refH[keyE(t.E)] ? 'Present' : b.snr >= p.faintSNR ? 'Faint' : 'Absent';
          } else {
            t.call = 'Absent';
            if (t.E) {
              const dE = laneDAt(r, l, Math.log10(t.E));
              if (dE != null) t.band = { d: dE, a: dE - bandHalf, b: dE + bandHalf, vol: G.windowVolume(l, dE, bandHalf), size: null, absent: true, snr: 0, sat: 0, h: 0 };
            }
          }
        });
        // lane summary (first expected size) for older views
        const t0 = l.targets[0];
        l.target = t0.band; l.call = t0.call;
      });
      // row size labels
      r.sizeLabels = rowSizeLabels(r);
    });
    // relative intensity
    computeRelative();
    render(); renderRows(); renderTable(); renderSelection();
  }

  /**
   * Ladder-independent primer-dimer detection. Dimers form a band that (1) is the furthest-migrating band,
   * (2) recurs in many lanes at the same distance, and (3) is fuzzier than the real products.
   * If calibration exists it must also be small (< 1.5x the cutoff).
   */
  function markDimerFront(r, len, p) {
    r.dimerFront = null;
    if (!p.dimerBp) return;
    const P = state.P, samples = r.lanes.filter(l => !l.isLadder && !l.allowSmall);
    if (samples.length < 3) return;
    const last = samples.map(l => { const ps = l.peaks.filter(q => !q.aboveRange && q.snr >= p.faintSNR); return ps.length ? ps[ps.length - 1] : null; }).filter(Boolean);
    const need = Math.max(3, Math.ceil(samples.length * 0.25));
    if (last.length < need) return;
    const ds = last.map(q => q.d).sort((a, b) => a - b), win = P / 3;
    let bi = 0, bn = 0;
    for (let i = 0; i < ds.length; i++) { let n = 0; for (let j = i; j < ds.length && ds[j] - ds[i] <= win; j++) n++; if (n > bn || (n === bn && ds[i] > ds[bi])) { bn = n; bi = i; } }
    if (bn < need) return;
    const m = G.median(ds.slice(bi, bi + bn));
    const inCl = q => Math.abs(q.d - m) <= win * 0.75;
    const cl = samples.flatMap(l => l.peaks.filter(inCl));
    const others = samples.flatMap(l => l.peaks.filter(q => !inCl(q) && q.d < m - win && !q.aboveRange && q.snr >= p.minSNR));
    const wCl = G.median(cl.map(q => q.b - q.a));
    const diffuse = others.length >= 2 && wCl >= 1.25 * G.median(others.map(q => q.b - q.a));
    const sizes = cl.map(q => q.size).filter(Boolean);
    const sz = sizes.length ? G.median(sizes) : null;
    // subordinate: in most lanes that have this band, a stronger band (the product) runs above it
    const lanesWith = samples.filter(l => l.peaks.some(inCl));
    const sub = lanesWith.filter(l => {
      const c = l.peaks.filter(inCl).reduce((x, y) => (y.h > x.h ? y : x));
      return l.peaks.some(q => q.d < m - win && q.h > c.h && !q.aboveRange);
    }).length >= 0.6 * lanesWith.length;
    // at or below the bottom of the ladder (by position: works even when the ladder fit is wrong)
    const ladLow = Math.max(0, ...r.lanes.filter(l => l.isLadder).flatMap(l => l.peaks.map(q => q.d)));
    const belowLadder = ladLow > 0 && m >= ladLow - P / 6;
    const isDimer = (sz != null && sz < p.dimerBp) || (belowLadder && sz != null && sz < 1.5 * p.dimerBp) || (belowLadder && diffuse) ||
      (sub && ((sz != null && sz < 1.5 * p.dimerBp) || diffuse || belowLadder)) ||
      (sz == null && diffuse && m > 0.55 * len);
    if (!isDimer) return;
    let reach = Math.max(win, 1.5 * wCl, state.P / 2); // dimer zone = the dimer band's own width above its centre, and everything below
    // …but never more than halfway up to the products
    if (others.length >= 2) reach = Math.min(reach, 0.5 * (m - G.median(others.map(q => q.d))));
    r.dimerFront = { d: m, size: sz };
    const tolLog = Math.log10(1 + p.tol / 100);
    samples.forEach(l => l.peaks.forEach(q => {
      const isExpected = q.size && l.Es.some(E => Math.abs(Math.log10(q.size / E)) <= tolLog);
      if (q.d >= m - reach && !isExpected) q.dimer = true;
    }));
    const dimerH = G.median(cl.map(q => q.h));
    // dimer-only lanes (no template / NTC): heavy dimer runs slightly slower; if the lane's only remaining
    // band sits just above the dimer zone with nothing above it, it is dimer too
    samples.forEach(l => {
      const rest = l.peaks.filter(q => !q.dimer && !q.aboveRange);
      if (rest.length !== 1) return;
      const q = rest[0];
      const isExpected = q.size && l.Es.some(E => Math.abs(Math.log10(q.size / E)) <= tolLog);
      // only weak blobs just above the dimer zone (heavy dimer in no-template lanes), never a strong product
      if (!isExpected && q.d >= m - reach && q.h <= 3 * dimerH) q.dimer = true;
    });
  }

  /** does band q have the same size as the reference band? (size if calibrated, else position in the same row) */
  function sameAsRef(q, ri, info) {
    const tolLog = Math.log10(1 + params().tol / 100);
    if (q.size && info.size) return Math.abs(Math.log10(q.size / info.size)) <= tolLog;
    return ri === info.r && Math.abs(q.d - info.d) <= state.P / 6;
  }
  function computeRelative() {
    state.refInfo = null;
    if (state.ref) {
      const rl = state.rows[state.ref.r] && state.rows[state.ref.r].lanes[state.ref.l];
      if (rl) {
        // the reference band is the one chosen when the reference was set (re-found by size/position)
        const pick = rl.peaks.filter(q => sameAsRef(q, state.ref.r, { size: state.ref.size, d: state.ref.d, r: state.ref.r }));
        const band = pick.length ? pick.reduce((x, y) => (y.h > x.h ? y : x)) : null;
        if (band && band.vol > 0) state.refInfo = { size: band.size, d: band.d, vol: band.vol, r: state.ref.r, dimer: band.dimer };
      }
    }
    state.rows.forEach((r, ri) => {
      const mx = Math.max(1e-9, ...r.lanes.filter(l => !l.isLadder && l.target).map(l => l.target.vol));
      // each expected band is compared with the brightest band of the same expected size in the row
      const mxE = {};
      r.lanes.forEach(l => (l.targets || []).forEach(t => { if (t.band && !t.band.absent) mxE[t.E] = Math.max(mxE[t.E] || 1e-9, t.band.vol); }));
      r.lanes.forEach(l => (l.targets || []).forEach(t => { t.rel = t.band && mxE[t.E] ? (100 * t.band.vol) / mxE[t.E] : null; }));
      r.lanes.forEach(l => {
        l.rel = null; l.relBand = null;
        if (l.isLadder) return;
        if (state.refInfo) {
          // only a band of the same size as the reference band counts
          const c = l.peaks.filter(q => (!q.dimer || state.refInfo.dimer) && sameAsRef(q, ri, state.refInfo));
          if (c.length) { l.relBand = c.reduce((x, y) => (y.h > x.h ? y : x)); l.rel = (100 * l.relBand.vol) / state.refInfo.vol; }
        } else if (l.target) {
          l.relBand = l.target; l.rel = (100 * l.target.vol) / mx;
        }
      });
    });
  }

  function rowSizeLabels(r) {
    const samples = r.lanes.filter(l => !l.isLadder);
    const hasE = samples.some(l => l.Es && l.Es.length);
    const out = [];
    if (hasE) {
      const groups = new Map();
      samples.forEach(l => (l.targets || []).forEach(t => {
        if (t.band && !t.band.absent && t.call !== 'Absent' && t.band.size) (groups.get(t.E) || groups.set(t.E, []).get(t.E)).push(t.band);
      }));
      groups.forEach(ts => out.push({ size: G.median(ts.map(t => t.size)), d: G.median(ts.map(t => t.d)), n: ts.length }));
    } else {
      const maxH = Math.max(1e-9, ...samples.flatMap(l => l.peaks.map(q => q.h)));
      const major = samples.flatMap(l => l.peaks.filter(q => q.size && !q.dimer && q.h > 0.25 * maxH));
      major.sort((a, b) => a.size - b.size);
      const cl = [];
      for (const q of major) {
        const c = cl[cl.length - 1];
        if (c && Math.abs(Math.log10(q.size / c[c.length - 1].size)) < 0.025) c.push(q); else cl.push([q]);
      }
      const need = Math.max(2, Math.round(samples.length * 0.15));
      cl.filter(c => c.length >= need).forEach(c => out.push({ size: G.median(c.map(q => q.size)), d: G.median(c.map(q => q.d)), n: c.length }));
    }
    return out;
  }

  // ================= Rendering =================
  const cv = $('#canvas'), ctx = cv.getContext('2d');
  function fontPx() { return Math.max(6, Math.round(G.clamp(state.P * 0.2, 10, 42) * state.style.size / 100)); }
  const fontStr = px => `${state.style.bold ? 600 : 400} ${px}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  function setupCanvas() {
    const P = state.P || 60;
    const k = Math.max(1, state.style.size / 100);
    state.margins = { l: Math.round(P * 1.15 * k), r: Math.round(P * 1.7 * k), t: Math.round(P * 0.3 * k), b: Math.round(P * 0.2) };
    const W = state.img.w + state.margins.l + state.margins.r, H = state.img.h + state.margins.t + state.margins.b;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; applyZoom(); }
  }
  function haloText(t, x, y, color, align, base) {
    ctx.textAlign = align || 'center'; ctx.textBaseline = base || 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, fontPx() * 0.22);
    ctx.strokeStyle = textHalo(); ctx.strokeText(t, x, y);
    ctx.fillStyle = color; ctx.fillText(t, x, y);
  }
  const lightBg = () => state.dark !== $('#invertDisp').checked;
  const textInk = () => (lightBg() ? '#111827' : '#f8fafc');
  const textHalo = () => (lightBg() ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.85)');
  const COL = { Present: '#16a34a', Faint: '#d97706', Absent: '#dc2626', ladder: '#2563eb', sel: '#06b6d4', edit: '#f43f5e' };
  const laneInk = () => state.style.lane || textInk();
  const ladderInk = () => state.style.ladder || COL.ladder;
  const bandInk = () => state.style.band || textInk();

  function render(forExport) {
    if (!state.img) return;
    setupCanvas();
    const m = state.margins, P = state.P, fs = fontPx();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = lightBg() ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(state.disp, m.l, m.t);
    ctx.translate(m.l, m.t);
    ctx.font = fontStr(fs);
    const showLabels = $('#showLabels').checked, showLadder = $('#showLadder').checked,
      showBoxes = $('#showBoxes').checked, showLanes = $('#showLanes').checked || state.edit;

    state.rows.forEach((r, ri) => {
      const len = state.lens[ri];
      r.lanes.forEach((l, li) => {
        const y0 = G.wellY(r, l.x), hw = (l.profile ? l.profile.halfW : P * 0.3);
        const sl = r.slope;
        // lane strip
        if (showLanes) {
          ctx.strokeStyle = l.isLadder ? 'rgba(37,99,235,.7)' : 'rgba(6,182,212,.55)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(l.x - hw, y0); ctx.lineTo(l.x - hw - sl * len, y0 + len);
          ctx.moveTo(l.x + hw, y0); ctx.lineTo(l.x + hw - sl * len, y0 + len);
          ctx.stroke();
        }
        // band boxes
        if (showBoxes && !l.isLadder) (l.targets || []).forEach(tg => {
          const t = tg.band; if (!t) return;
          ctx.strokeStyle = COL[tg.call] || '#999'; ctx.lineWidth = Math.max(1.5, P / 40);
          ctx.setLineDash(t.absent ? [5, 4] : []);
          ctx.strokeRect(l.x - sl * t.d - hw - 2, y0 + t.a - 2, 2 * hw + 4, t.b - t.a + 4);
          ctx.setLineDash([]);
        });
        // optional: size written under each called band
        if (state.style.onBand && !l.isLadder) (l.targets || []).forEach(tg => {
          const t = tg.band;
          if (!t || t.absent || !t.size || tg.call === 'Absent') return;
          ctx.font = fontStr(Math.max(6, Math.round(fs * 0.7)));
          haloText(fmtBp(t.size), l.x - sl * t.b, y0 + t.b + 3, bandInk(), 'center', 'top');
          ctx.font = fontStr(fs);
        });
        // band used for reference comparison (cyan) when it is not the called band
        if (showBoxes && state.refInfo && l.relBand && l.relBand !== l.target) {
          const t = l.relBand;
          ctx.strokeStyle = COL.sel; ctx.lineWidth = Math.max(1.5, P / 40);
          ctx.strokeRect(l.x - sl * t.d - hw - 2, y0 + t.a - 2, 2 * hw + 4, t.b - t.a + 4);
        }
        // primer dimers (grey dashed)
        if (showBoxes && l.dimer) {
          const t = l.dimer;
          ctx.strokeStyle = 'rgba(120,120,120,.9)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          ctx.strokeRect(l.x - sl * t.d - hw, y0 + t.a, 2 * hw, t.b - t.a);
          ctx.setLineDash([]);
        }
        // ladder sizes
        if (showLadder && l.isLadder && l.fit) {
          const sz = Math.round(fs * 0.8);
          ctx.font = fontStr(sz);
          const leftSide = l.x < state.img.w / 2;
          let lastY = -1e9;
          l.fit.pairs.slice().sort((a, b) => a.peak.d - b.peak.d).forEach(pr => {
            const y = y0 + pr.peak.d, xo = -sl * pr.peak.d;
            const xe = leftSide ? l.x + xo - hw - 3 : l.x + xo + hw + 3;
            ctx.strokeStyle = ladderInk(); ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(xe, y); ctx.lineTo(xe + (leftSide ? -6 : 6), y); ctx.stroke();
            if (y - lastY < sz * 0.95) return; // avoid overlapping text
            lastY = y;
            haloText(fmtBp(pr.size), xe + (leftSide ? -8 : 8), y, ladderInk(), leftSide ? 'right' : 'left', 'middle');
          });
          ctx.font = fontStr(fs);
        }
        // lane labels
        if (showLabels) {
          const txt = l.label || (l.isLadder ? 'L' : String(li + 1));
          const ty = y0 - r.fwhm * 0.7 - 3;
          const wTxt = ctx.measureText(txt).width;
          const col = l.isLadder ? ladderInk() : laneInk();
          if (wTxt <= P * 0.95) haloText(txt, l.x, ty, col);
          else {
            ctx.save(); ctx.translate(l.x - P * 0.15, ty); ctx.rotate(-Math.PI / 6);
            const maxW = P * 1.9;
            let t2 = txt; while (ctx.measureText(t2).width > maxW && t2.length > 3) t2 = t2.slice(0, -2) + '…';
            haloText(t2, 0, 0, col, 'left'); ctx.restore();
          }
        }
        // selection
        if (!forExport && state.sel && state.sel.r === ri && state.sel.l === li) {
          ctx.strokeStyle = COL.sel; ctx.lineWidth = 2;
          ctx.strokeRect(l.x - P / 2, y0 - 2, P, len + 2);
          const b = state.sel.band;
          if (b) { ctx.lineWidth = 2.5; ctx.strokeRect(l.x - sl * b.d - hw - 4, y0 + b.a - 4, 2 * hw + 8, b.b - b.a + 8); }
        }
        if (!forExport && state.ref && state.ref.r === ri && state.ref.l === li) {
          haloText('★ ref', l.x, y0 + len - 4, COL.sel);
        }
      });
      // row-end size labels
      if (showLabels && r.lanes.length) {
        const last = r.lanes[r.lanes.length - 1];
        const xr = last.x + P * 0.55;
        let lastY = -1e9;
        r.sizeLabelPos = [];
        rowLabelItems(r).forEach(s => {
          const y = G.wellY(r, xr) + s.d;
          if (y - lastY < fs) return; lastY = y;
          ctx.strokeStyle = bandInk(); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(xr, y); ctx.lineTo(xr + P * 0.15, y); ctx.stroke();
          haloText(s.text, xr + P * 0.2, y, bandInk(), 'left', 'middle');
          r.sizeLabelPos.push({ x: xr, y, w: ctx.measureText(s.text).width + P * 0.2 });
        });
      }
      // edit handles
      if (state.edit && !forExport) {
        const [xa, xb] = rowSpan(r);
        ctx.strokeStyle = COL.edit; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(xa, G.wellY(r, xa)); ctx.lineTo(xb, G.wellY(r, xb)); ctx.stroke();
        ctx.fillStyle = COL.edit;
        for (const x of [xa, xb]) { ctx.beginPath(); ctx.arc(x, G.wellY(r, x), handleR(), 0, 7); ctx.fill(); }
        r.lanes.forEach(l => {
          const y = G.wellY(r, l.x), s = handleR();
          ctx.fillStyle = l.isLadder ? COL.ladder : '#06b6d4';
          ctx.beginPath(); ctx.moveTo(l.x, y - s); ctx.lineTo(l.x + s, y); ctx.lineTo(l.x, y + s); ctx.lineTo(l.x - s, y); ctx.closePath(); ctx.fill();
        });
        haloText('Row ' + (ri + 1), xa - 6, G.wellY(r, xa) - 6, COL.edit, 'right');
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  /** row-end labels: automatic sizes, or the user's own text */
  function rowLabelItems(r) {
    const auto = r.sizeLabels.slice().sort((a, b) => a.d - b.d);
    if (r.sizeLabelText != null && r.sizeLabelText !== '') {
      const ts = r.lanes.filter(l => !l.isLadder && l.target && !l.target.absent).map(l => l.target.d);
      const d = auto.length ? auto[0].d : ts.length ? G.median(ts) : state.lens[state.rows.indexOf(r)] / 2;
      return [{ d, text: r.sizeLabelText }];
    }
    return auto.map(s => ({ d: s.d, text: '≈ ' + fmtBp(s.size) + (s.size < 10000 ? ' bp' : '') }));
  }
  function rowSpan(r) {
    const P = state.P;
    if (!r.lanes.length) return [P, state.img.w - P];
    return [r.lanes[0].x - P * 0.6, r.lanes[r.lanes.length - 1].x + P * 0.6];
  }
  function cssScale() { const rc = cv.getBoundingClientRect(); return cv.width / Math.max(1, rc.width); }
  function handleR() { return Math.max(5, 7 * cssScale()); }

  // ---- zoom ----
  function fitZoom() { state.zoom = 1; applyZoom(); }
  function applyZoom() {
    const vw = $('#viewer').clientWidth - 2;
    const fitW = Math.min(vw, cv.width);
    cv.style.width = Math.round(fitW * state.zoom) + 'px';
    cv.style.height = 'auto';
  }

  // ================= Interaction =================
  function toImg(e) {
    const rc = cv.getBoundingClientRect(), s = cv.width / rc.width;
    return { x: (e.clientX - rc.left) * s - state.margins.l, y: (e.clientY - rc.top) * s - state.margins.t };
  }
  function hitLane(x, y) {
    const P = state.P;
    for (let ri = 0; ri < state.rows.length; ri++) {
      const r = state.rows[ri], len = state.lens[ri];
      for (let li = 0; li < r.lanes.length; li++) {
        const l = r.lanes[li], y0 = G.wellY(r, l.x), d = y - y0;
        if (d < -r.fwhm || d > len) continue;
        if (Math.abs(x - (l.x - r.slope * d)) <= P / 2) return { ri, li, d };
      }
    }
    return null;
  }
  function onClickSelect(e) {
    const { x, y } = toImg(e);
    const h = hitLane(x, y);
    if (!h) { state.sel = null; render(); renderSelection(); renderTable(); return; }
    selectAt(h.ri, h.li, h.d);
  }
  function selectAt(ri, li, d) {
    const r = state.rows[ri], l = r.lanes[li];
    let band = null;
    if (d != null) {
      band = l.peaks.find(q => d >= q.a - 3 && d <= q.b + 3);
      if (!band && l.profile && d > l.profile.d0) {
        band = G.bandAtD(state.img, r, l, d);
        if (band) { const ls = laneLogAt(r, l, band.d); band.size = ls == null ? null : Math.pow(10, ls); }
      }
    } else band = l.target && !l.target.absent ? l.target : null;
    state.sel = { r: ri, l: li, band };
    render(); renderSelection(); renderTable(true);
  }

  // edit-mode dragging
  function editDown(e) {
    const { x, y } = toImg(e), R = handleR() * 1.6;
    if (e.detail === 2) return; // dblclick handled separately
    for (let ri = 0; ri < state.rows.length; ri++) {
      const r = state.rows[ri];
      for (let li = 0; li < r.lanes.length; li++) {
        const l = r.lanes[li];
        if (Math.hypot(x - l.x, y - G.wellY(r, l.x)) < R) {
          if (e.shiftKey) { r.lanes.splice(li, 1); afterEdit(); return; }
          state.drag = { type: 'lane', r, l }; return;
        }
      }
      const [xa, xb] = rowSpan(r);
      if (Math.hypot(x - xa, y - G.wellY(r, xa)) < R) { state.drag = { type: 'end', r, pivot: xb }; return; }
      if (Math.hypot(x - xb, y - G.wellY(r, xb)) < R) { state.drag = { type: 'end', r, pivot: xa }; return; }
      if (x > xa && x < xb && Math.abs(y - G.wellY(r, x)) < R) {
        if (e.shiftKey) { if (confirm('Delete row ' + (ri + 1) + '?')) { state.rows.splice(ri, 1); afterEdit(); } return; }
        state.drag = { type: 'row', r, y0: y, yc0: r.yc }; return;
      }
    }
  }
  function editMove(e) {
    const d = state.drag; if (!d) return;
    const { x, y } = toImg(e);
    d.moved = true;
    if (d.type === 'lane') d.l.x = G.clamp(x, 0, state.img.w - 1);
    else if (d.type === 'row') { d.r.yc = d.yc0 + (y - d.y0); }
    else if (d.type === 'end') {
      const r = d.r, yp = G.wellY(r, d.pivot);
      if (Math.abs(x - d.pivot) > 20) {
        r.slope = G.clamp((y - yp) / (x - d.pivot), -0.2, 0.2);
        r.yc = yp + r.slope * (r.xc - d.pivot);
      }
    }
    render();
  }
  function editUp() { if (state.drag && state.drag.moved) afterEdit(); state.drag = null; }
  function editDbl(e) {
    const { x, y } = toImg(e), P = state.P;
    for (const r of state.rows) {
      const [xa, xb] = rowSpan(r);
      if (Math.abs(y - G.wellY(r, x)) < P * 0.4 && x > xa - P && x < xb + P) {
        r.lanes.push({ x }); afterEdit(); return;
      }
    }
    // new row: copy lane positions from the nearest row
    const near = state.rows.slice().sort((a, b) => Math.abs(a.yc - y) - Math.abs(b.yc - y))[0];
    const fwhm = near ? near.fwhm : 10, slope = near ? near.slope : 0;
    state.rows.push({
      yc: y + slope * (state.img.w / 2 - x), xc: state.img.w / 2, slope, fwhm, expected: null, ladderId: '',
      lanes: near ? near.lanes.map(l => ({ x: l.x })) : [{ x }]
    });
    afterEdit();
  }
  function afterEdit() { reanalyze(); }

  /** double-click (outside layout-edit mode): rename a lane label, edit a row-end label, or set a band's size */
  function dblEdit(e) {
    const { x, y } = toImg(e), P = state.P, fs = fontPx();
    for (const r of state.rows) for (const p of r.sizeLabelPos || []) {
      if (x >= p.x - 4 && x <= p.x + p.w + 4 && Math.abs(y - p.y) <= fs) {
        const v = prompt('Row label (leave empty for the automatic size):', r.sizeLabelText || rowLabelItems(r).map(s => s.text).join(', '));
        if (v === null) return;
        r.sizeLabelText = v.trim() || null; renderRows(); render(); return;
      }
    }
    for (const r of state.rows) for (const l of r.lanes) {
      const y0 = G.wellY(r, l.x), ty = y0 - r.fwhm * 0.7 - 3;
      if (Math.abs(x - l.x) <= P / 2 && y <= y0 + 2 && y >= ty - fs * 2) {
        const v = prompt('Lane label:', l.label || '');
        if (v === null) return;
        l.label = v; l.labelEdited = true; reanalyze(); return;
      }
    }
    const h = hitLane(x, y);
    if (!h) return;
    const r = state.rows[h.ri], l = r.lanes[h.li];
    const b = l.peaks.find(q => h.d >= q.a - 3 && h.d <= q.b + 3);
    if (!b) return toast('No detected band here: click a band to edit its size');
    const v = prompt('Band size in bp (leave empty to go back to the ladder-based size):', b.size ? Math.round(b.size) : '');
    if (v === null) return;
    selectAt(h.ri, h.li, b.d);
    setBandSize(l, b, +v || null);
  }

  // ================= Panels =================
  function renderSelection() {
    const box = $('#selInfo');
    const s = state.sel;
    if (!s || !state.rows[s.r] || !state.rows[s.r].lanes[s.l]) { box.innerHTML = 'Click a band (or any spot in a lane) on the gel.'; drawProfile(null); return; }
    const r = state.rows[s.r], l = r.lanes[s.l], b = s.band;
    const ref = state.ref ? state.rows[state.ref.r] && state.rows[state.ref.r].lanes[state.ref.l] : null;
    let rel = '';
    if (b) {
      if (state.refInfo) {
        rel = sameAsRef(b, s.r, state.refInfo)
          ? ((100 * b.vol) / state.refInfo.vol).toFixed(1) + '% of the ★ reference band'
          : `<span class="muted">not compared: different size from the ★ reference band (${fmtBp(state.refInfo.size) || 'n/a'} bp)</span>`;
      } else {
        const mx = Math.max(1e-9, ...r.lanes.filter(x => !x.isLadder && x.target).map(x => x.target.vol));
        rel = ((100 * b.vol) / mx).toFixed(1) + '% of brightest target in row';
      }
    }
    box.innerHTML = `
      <dl class="kv">
        <dt>Lane</dt><dd>Row ${s.r + 1} · lane ${s.l + 1}${l.label ? ' · <b>' + esc(l.label) + '</b>' : ''} ${l.isLadder ? '<span class="pill Ladder">ladder</span>' : (l.targets || []).map(tg => `<span class="pill ${tg.call}">${l.targets.length > 1 ? tg.E + ': ' : ''}${tg.call}</span>`).join(' ')}</dd>
        ${b ? `
        <dt>Band size</dt><dd>${b.size ? '<b>' + fmtBp(b.size) + ' bp</b>' : '<span class="muted">no ladder calibration</span>'}${b.manual ? ' <span class="muted">(clicked position)</span>' : ''}</dd>
        <dt>Volume</dt><dd>${b.vol.toFixed(1)} a.u. (background-subtracted)</dd>
        <dt>Relative</dt><dd>${rel}</dd>
        <dt>Signal/noise</dt><dd>${b.snr.toFixed(1)}</dd>
        <dt>Saturation</dt><dd>${b.sat > 0.005 ? `<span class="warn">⚠ ${(100 * b.sat).toFixed(1)}% of pixels saturated: volume is underestimated</span>` : 'none'}</dd>
        <dt>Position</dt><dd>${b.d.toFixed(1)} px from well</dd>` : '<dt>Band</dt><dd class="muted">No band here</dd>'}
        <dt>Other bands</dt><dd>${l.peaks.filter(q => q !== b).map(q => fmtBp(q.size) || Math.round(q.d) + 'px').join(', ') || '—'}</dd>
      </dl>
      <div class="edit-grid">
        <label for="eLabel">Label</label><input id="eLabel" value="${esc(l.label || '')}" placeholder="${l.isLadder ? 'L' : 'lane ' + (s.l + 1)}"><span></span>
        ${b && !b.manual ? `<label for="eSize">Band size (bp)</label><input id="eSize" type="number" min="1" value="${b.size ? Math.round(b.size) : ''}"><button class="btn ghost" id="eSizeReset" ${b.sizeManual ? '' : 'disabled'}>Auto</button>` : ''}
      </div>
      ${b && b.sizeManual ? '<div class="manual">size entered manually</div>' : ''}
      <div class="row-btns">
        ${!l.isLadder ? `<button class="btn" id="setRef">${state.ref && state.ref.r === s.r && state.ref.l === s.l ? 'Clear reference' : 'Use as reference lane (100%)'}</button>` : ''}
        <button class="btn ghost" id="toggleLadder">${l.isLadder ? 'Not a ladder lane' : 'Mark as ladder lane'}</button>
      </div>`;
    const sr = $('#setRef');
    if (sr) sr.onclick = () => {
      if (state.ref && state.ref.r === s.r && state.ref.l === s.l) state.ref = null;
      else {
        const band = s.band || (l.target && !l.target.absent ? l.target : null);
        if (!band) return toast('Click the band you want as the reference first');
        state.ref = { r: s.r, l: s.l, size: band.size, d: band.d };
      }
      computeRelative(); render(); renderSelection(); renderTable();
    };
    $('#toggleLadder').onclick = () => { l.ladderOverride = !l.isLadder; reanalyze(); };
    $('#eLabel').onchange = e => { l.label = e.target.value; l.labelEdited = true; reanalyze(); };
    const es = $('#eSize');
    if (es) {
      const key = Math.round(b.d);
      es.onchange = e => { setBandSize(l, b, +e.target.value || null); };
      $('#eSizeReset').onclick = () => setBandSize(l, b, null);
    }
    drawProfile(r, l, b);
  }

  function setBandSize(l, b, bp) {
    l.sizeOverrides = l.sizeOverrides || {};
    for (const k in l.sizeOverrides) if (Math.abs(+k - b.d) <= 3) delete l.sizeOverrides[k];
    if (bp) l.sizeOverrides[Math.round(b.d)] = bp;
    const keep = state.sel, d = b.d;
    reanalyze();
    if (keep) selectAt(keep.r, keep.l, d);
  }

  function drawProfile(r, l, b) {
    const c = $('#profile'), dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth || 400, H = 180;
    c.width = W * dpr; c.height = H * dpr;
    const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement);
    const ink = cs.getPropertyValue('--muted').trim() || '#888', line = cs.getPropertyValue('--line').trim() || '#ddd';
    if (!l || !l.profile) { return; }
    const pr = l.profile, n = pr.raw.length, pad = { l: 8, r: 8, t: 10, b: 24 };
    let mn = Infinity, mx = -Infinity;
    for (let i = pr.d0; i < n; i++) { mn = Math.min(mn, pr.raw[i], pr.base[i]); mx = Math.max(mx, pr.raw[i]); }
    const X = d => pad.l + ((d - pr.d0) / Math.max(1, n - 1 - pr.d0)) * (W - pad.l - pad.r);
    const Y = v => H - pad.b - ((v - mn) / Math.max(1e-9, mx - mn)) * (H - pad.t - pad.b);
    // selected band shading
    if (b) {
      x.fillStyle = 'rgba(6,182,212,.25)';
      x.beginPath(); x.moveTo(X(b.a), Y(pr.base[Math.round(b.a)]));
      for (let d = Math.round(b.a); d <= Math.round(b.b); d++) x.lineTo(X(d), Y(pr.raw[d]));
      for (let d = Math.round(b.b); d >= Math.round(b.a); d--) x.lineTo(X(d), Y(pr.base[d]));
      x.closePath(); x.fill();
    }
    // baseline
    x.setLineDash([4, 3]); x.strokeStyle = ink; x.lineWidth = 1;
    x.beginPath(); for (let d = pr.d0; d < n; d++) d === pr.d0 ? x.moveTo(X(d), Y(pr.base[d])) : x.lineTo(X(d), Y(pr.base[d])); x.stroke();
    x.setLineDash([]);
    // profile
    x.strokeStyle = l.isLadder ? '#2563eb' : '#0891b2'; x.lineWidth = 1.6;
    x.beginPath(); for (let d = pr.d0; d < n; d++) d === pr.d0 ? x.moveTo(X(d), Y(pr.raw[d])) : x.lineTo(X(d), Y(pr.raw[d])); x.stroke();
    // axis + peak labels
    x.strokeStyle = line; x.beginPath(); x.moveTo(pad.l, H - pad.b + 0.5); x.lineTo(W - pad.r, H - pad.b + 0.5); x.stroke();
    x.fillStyle = ink; x.font = '11px system-ui, sans-serif'; x.textAlign = 'center';
    l.peaks.forEach(q => {
      x.beginPath(); x.moveTo(X(q.d), H - pad.b); x.lineTo(X(q.d), H - pad.b + 4); x.stroke();
      if (q.size) x.fillText(fmtBp(q.size), X(q.d), H - 8);
    });
    x.textAlign = 'left'; x.fillText('well →', pad.l, H - 8 - 12);
    x.textAlign = 'right'; x.fillText('migration (px) →  bp at peaks', W - pad.r, pad.t);
    c.onclick = ev => {
      const rc = c.getBoundingClientRect(), px = ev.clientX - rc.left;
      const d = pr.d0 + ((px - pad.l) / (W - pad.l - pad.r)) * (n - 1 - pr.d0);
      selectAt(state.sel.r, state.sel.l, d);
    };
  }

  function renderRows() {
    const box = $('#rowsInfo');
    if (!state.rows.length) { box.textContent = '—'; return; }
    box.innerHTML = state.rows.map((r, ri) => {
      const lads = r.lanes.map((l, li) => ({ l, li })).filter(o => o.l.isLadder);
      return `<div class="rowblock">
        <div class="rowhead"><b>Row ${ri + 1}</b>
          <label class="small">Ladder <select data-row="${ri}" class="rowLadder">${ladderOptions(r.ladderId, true)}</select></label>
          <label class="small">Expected bp <input type="text" data-row="${ri}" class="rowExp" value="${esc(fmtList(r.expected))}" placeholder="${esc(fmtList(params().expected)) || 'e.g. 550, 320'}"></label>
          <label class="small">Size label <input type="text" data-row="${ri}" class="rowLbl" value="${esc(r.sizeLabelText || '')}" placeholder="auto"></label>
          <span class="muted small">${r.lanes.length} lanes</span>
        </div>
        ${r.ladderConflict ? `<div class="fit warn">⚠ ${esc(r.ladderConflict)}</div>` : ''}
        ${lads.length ? lads.map(({ l, li }) => ladderFitHtml(r, ri, l, li)).join('') : '<div class="fit warn">No ladder lane in this row: sizes unavailable. Mark one (click lane → “Mark as ladder lane”).</div>'}
      </div>`;
    }).join('');
    $$('.rowLadder').forEach(s => (s.onchange = () => { const r = state.rows[+s.dataset.row]; r.ladderId = s.value; r.lanes.forEach(l => { l.manualMap = null; }); reanalyze(); }));
    $$('.rowExp').forEach(s => (s.onchange = () => { const v = parseSizes(s.value); state.rows[+s.dataset.row].expected = v.length ? v : null; reanalyze(); }));
    $$('.rowLbl').forEach(s => (s.onchange = () => { state.rows[+s.dataset.row].sizeLabelText = s.value.trim() || null; render(); }));
    $$('.fitSel').forEach(s => (s.onchange = () => {
      const l = state.rows[+s.dataset.row].lanes[+s.dataset.lane];
      const map = {};
      $$(`.fitSel[data-row="${s.dataset.row}"][data-lane="${s.dataset.lane}"]`).forEach(o => {
        if (o !== s && o.value === s.value) o.value = '0'; // a size can only be used once
        if (+o.value) map[o.dataset.d] = +o.value;
      });
      l.manualMap = map; reanalyze();
    }));
    $$('.fitReset').forEach(b => (b.onclick = () => { state.rows[+b.dataset.row].lanes[+b.dataset.lane].manualMap = null; reanalyze(); }));
    $$('.fitLadder').forEach(s => (s.onchange = () => { const l = state.rows[+s.dataset.row].lanes[+s.dataset.lane]; l.ladderId = s.value; l.manualMap = null; reanalyze(); }));
  }
  function ladderFitHtml(r, ri, l, li) {
    const lad = l.ladder, f = l.fit;
    const n = f ? f.pairs.length : 0;
    const r2 = l.cal && l.cal.r2 != null ? ` · fit R² ${l.cal.r2.toFixed(4)}` : '';
    const status = l.noBands ? '<span class="warn">no ladder bands found in this lane (empty?) – not used</span>' : l.calRejected ? '<span class="warn">⚠ not used: disagrees with the other ladder in this row</span>' : !l.cal ? '<span class="warn">⚠ could not calibrate: assign sizes manually below</span>' : `${n}/${lad.sizes.length} bands matched${r2}${f.manual ? ' · manual' : ''}`;
    const assigned = new Map((f ? f.pairs : []).map(p => [p.peak, p.size]));
    const opts = sel => `<option value="0">—</option>` + lad.sizes.slice().sort((a, b) => b - a).map(s => `<option value="${s}" ${s === sel ? 'selected' : ''}>${fmtBp(s)}</option>`).join('');
    return `<details class="fit"><summary>Lane ${li + 1}${l.label ? ' (' + esc(l.label) + ')' : ''}: ${status}</summary>
      <label class="small">Ladder for this lane <select class="fitLadder" data-row="${ri}" data-lane="${li}">${ladderOptions(l.ladderId, true)}</select></label>
      <table><tr><th>Band</th><th>px from well</th><th>Height</th><th>Size</th></tr>
      ${l.peaks.slice().sort((a, b) => a.d - b.d).map((q, k) => `<tr><td>${k + 1}</td><td>${q.d.toFixed(1)}</td><td>${q.h.toFixed(3)}</td>
        <td><select class="fitSel" data-row="${ri}" data-lane="${li}" data-d="${Math.round(q.d)}">${opts(assigned.get(q))}</select></td></tr>`).join('')}
      </table>
      <button class="btn ghost fitReset" data-row="${ri}" data-lane="${li}">Reset to automatic</button>
    </details>`;
  }

  /** one line per lane; lanes with several expected sizes list each band's values separated by "; " */
  function resultRows() {
    const out = [];
    state.rows.forEach((r, ri) => r.lanes.forEach((l, li) => {
      const ts = l.isLadder ? [] : (l.targets || []), multi = ts.length > 1;
      const v = f => (l.isLadder || !ts.length ? '' : multi ? ts.map(f).map(x => (x === '' ? '—' : x)).join('; ') : f(ts[0]));
      const real = t => t.band && !t.band.absent;
      out.push({
        Row: ri + 1, Lane: li + 1, Label: l.label || '', Type: l.isLadder ? 'Ladder' : 'Sample',
        Expected_bp: l.isLadder ? '' : l.Es.join('; '),
        Call: v(t => (multi ? `${t.E}: ${t.call}` : t.call || '')),
        Band_bp: v(t => (real(t) && t.band.size ? Math.round(t.band.size) : '')),
        Size_manual: ts.some(t => real(t) && t.band.sizeManual) ? 'yes' : '',
        Volume: v(t => (t.band ? +t.band.vol.toFixed(2) : '')),
        Relative_pct: state.refInfo ? (l.isLadder || l.rel == null ? '' : +l.rel.toFixed(1)) : v(t => (t.rel != null ? +t.rel.toFixed(1) : '')),
        Relative_band_bp: !l.isLadder && state.refInfo && l.relBand && l.relBand.size ? Math.round(l.relBand.size) : '',
        SNR: v(t => (real(t) ? +t.band.snr.toFixed(1) : '')),
        Saturated_pct: v(t => (real(t) ? +(100 * t.band.sat).toFixed(1) : '')),
        Primer_dimer: l.isLadder ? '' : l.dimer ? 'yes' : 'no',
        Dimer_volume: !l.isLadder && l.dimer ? +l.dimer.vol.toFixed(2) : '',
        All_bands_bp: l.peaks.map(q => (q.size ? Math.round(q.size) : '?') + (q.dimer ? ' (dimer)' : q.aboveRange ? ' (well/above ladder)' : q.spill ? ' (spill from next lane)' : '')).join('; '),
        Ladder: l.isLadder && l.ladder ? l.ladder.name : '',
        Lane_x_px: Math.round(l.x)
      });
    }));
    return out;
  }
  /** one line per expected band (long format, best for analysing multi-band gels) */
  function bandRows() {
    const out = [];
    state.rows.forEach((r, ri) => r.lanes.forEach((l, li) => {
      if (l.isLadder) return;
      (l.targets || []).forEach(t => {
        const real = t.band && !t.band.absent;
        out.push({
          Row: ri + 1, Lane: li + 1, Label: l.label || '', Expected_bp: t.E || '', Call: t.call || '',
          Band_bp: real && t.band.size ? Math.round(t.band.size) : '', Size_manual: real && t.band.sizeManual ? 'yes' : '',
          Volume: t.band ? +t.band.vol.toFixed(2) : '', Relative_pct_in_row: t.rel != null ? +t.rel.toFixed(1) : '',
          SNR: real ? +t.band.snr.toFixed(1) : '', Saturated_pct: real ? +(100 * t.band.sat).toFixed(1) : ''
        });
      });
    }));
    return out;
  }

  function renderTable(keepScroll) {
    const t = $('#results');
    if (!state.rows.length) { t.innerHTML = ''; $('#summary').textContent = ''; return; }
    const rows = resultRows();
    const counts = { Present: 0, Faint: 0, Absent: 0 };
    const nb = bandRows(); nb.forEach(b => { if (counts[b.Call] != null) counts[b.Call]++; });
    const multi = state.rows.some(r => r.lanes.some(l => (l.targets || []).length > 1));
    $('#summary').textContent = `${state.rows.length} rows · ${rows.length} lanes · ${multi ? nb.length + ' expected bands: ' : ''}${counts.Present} present · ${counts.Faint} faint · ${counts.Absent} absent` + (state.refInfo ? ` · Rel % = same-size band (${fmtBp(state.refInfo.size) || '?'} bp) vs ★ reference` : ' · Rel % vs brightest target band in row');
    t.innerHTML = `<thead><tr><th>Row</th><th>Lane</th><th>Label</th><th>Ladder</th><th>Expected bp</th><th>Call</th><th>Band bp</th><th>Volume</th><th>Rel %</th><th>S/N</th><th>Sat %</th><th>Dimer</th><th>All bands (bp)</th></tr></thead><tbody>` +
      rows.map((o, i) => {
        const ri = o.Row - 1, li = o.Lane - 1, l = state.rows[ri].lanes[li];
        const sel = state.sel && state.sel.r === ri && state.sel.l === li;
        return `<tr data-r="${ri}" data-l="${li}" class="${sel ? 'sel' : ''} ${li === 0 && ri > 0 ? 'rowsep' : ''}">
          <td>${o.Row}</td><td>${o.Lane}</td>
          <td><input type="text" class="tLabel" value="${esc(o.Label)}"></td>
          <td><input type="checkbox" class="tLad" ${l.isLadder ? 'checked' : ''}></td>
          <td>${l.isLadder ? '' : `<input type="text" class="tExp" value="${esc(fmtList(l.expected))}" placeholder="${esc(fmtList(l.Es))}">`}</td>
          <td>${l.isLadder ? '<span class="pill Ladder">ladder</span>' : (l.targets || []).length ? l.targets.map(tg => `<span class="pill ${tg.call}">${l.targets.length > 1 ? tg.E + ': ' : ''}${tg.call}</span>`).join(' ') : '<span class="pill na">—</span>'}</td>
          <td>${o.Band_bp}${o.Size_manual ? ' <span class="manual" title="entered manually">✎</span>' : ''}</td><td>${o.Volume}</td><td>${o.Relative_pct === '' && state.refInfo && !l.isLadder ? '<span class="muted" title="no band of the reference size">—</span>' : o.Relative_pct}</td><td>${o.SNR}</td>
          <td>${o.Saturated_pct !== '' && o.Saturated_pct > 0.5 ? `<span class="warn">⚠ ${o.Saturated_pct}</span>` : o.Saturated_pct}</td>
          <td>${o.Primer_dimer === 'yes' ? '<span class="warn">yes</span>' : o.Primer_dimer}</td>
          <td class="muted">${esc(o.All_bands_bp)}</td></tr>`;
      }).join('') + '</tbody>';
    t.querySelectorAll('tbody tr').forEach(tr => {
      const ri = +tr.dataset.r, li = +tr.dataset.l, l = state.rows[ri].lanes[li];
      tr.onclick = e => { if (e.target.tagName === 'INPUT') return; selectAt(ri, li, null); };
      tr.querySelector('.tLabel').onchange = e => { l.label = e.target.value; l.labelEdited = true; reanalyze(); };
      tr.querySelector('.tLad').onchange = e => { l.ladderOverride = e.target.checked; reanalyze(); };
      const ex = tr.querySelector('.tExp');
      if (ex) ex.onchange = e => { const v = parseSizes(e.target.value); l.expected = v.length ? v : null; l.expectedEdited = true; reanalyze(); };
    });
    if (!keepScroll && state.sel) {
      const tr = t.querySelector('tr.sel'); if (tr) tr.scrollIntoView({ block: 'nearest' });
    }
  }

  // ================= Labels (Excel / CSV / paste) =================
  async function loadSheet(file) {
    try {
      if (!window.XLSX) throw new Error('Excel reader failed to load (check internet connection).');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
      applyTable(aoa, file.name);
    } catch (e) { console.error(e); toast('Could not read sheet: ' + e.message, 6000); }
  }
  function applyTable(aoa, src) {
    aoa = aoa.filter(r => r.some(c => String(c).trim() !== ''));
    if (!aoa.length) return toast('Sheet is empty');
    const head = aoa[0].map(c => String(c).toLowerCase());
    if (head.some(c => /label|sample|name|lane|expected|size/.test(c)) && !LADDER_RE.test(String(aoa[0][0]))) aoa = aoa.slice(1);
    let layout = $('#sheetLayout').value;
    if (layout === 'auto') {
      const wide = aoa.filter(r => r.filter(c => String(c).trim() !== '').length > 2).length;
      layout = wide >= Math.max(1, aoa.length * 0.6) && aoa.length <= 12 ? 'grid' : 'list';
    }
    state.labelGrid = null;
    if (layout === 'grid') {
      state.labelGrid = aoa.map(r => r.map(c => ({ label: String(c).trim(), expected: null })));
      state.labels = state.labelGrid.flat();
    } else {
      state.labels = aoa.map(r => ({ label: String(r[0]).trim(), expected: parseSizes(r.slice(1).join(';')) }));
    }
    state.rows.forEach(r => r.lanes.forEach(l => { l.labelEdited = false; l.expectedEdited = false; }));
    updateLabelInfo(src, layout);
    reanalyze();
  }
  function updateLabelInfo(src, layout) {
    const n = state.labels.length, lanes = state.rows.reduce((a, r) => a + r.lanes.length, 0);
    const nl = state.labels.filter(x => LADDER_RE.test(x.label)).length;
    $('#labelInfo').innerHTML = `${esc(src)}: ${n} labels (${layout}${nl ? `, ${nl} ladder` : ''})` +
      (lanes && n !== lanes && !state.labelGrid ? ` · <span class="warn">gel has ${lanes} lanes</span>` : '');
  }

  // ================= Export =================
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportPng() { render(true); cv.toBlob(b => { download(b, state.name + '_annotated.png'); render(); }, 'image/png'); }
  function exportCsv() {
    const multi = state.rows.some(r => r.lanes.some(l => (l.targets || []).length > 1));
    const rows = multi ? bandRows() : resultRows(), keys = Object.keys(rows[0] || {});
    const q = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    download(new Blob([[keys.join(','), ...rows.map(r => keys.map(k => q(r[k])).join(','))].join('\n')], { type: 'text/csv' }), state.name + '_results.csv');
  }
  function exportXlsx() {
    if (!window.XLSX) return toast('Excel writer not loaded');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultRows()), 'Results');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bandRows()), 'Band calls');
    const fit = [];
    state.rows.forEach((r, ri) => r.lanes.forEach((l, li) => {
      if (!l.isLadder || !l.fit) return;
      const m = new Map(l.fit.pairs.map(p => [p.peak, p.size]));
      l.peaks.forEach(q => fit.push({ Row: ri + 1, Lane: li + 1, Ladder: l.ladder.name, Band_px_from_well: +q.d.toFixed(1), Height: +q.h.toFixed(4), Assigned_bp: m.get(q) || '', Fit_R2: l.cal && l.cal.r2 != null ? +l.cal.r2.toFixed(5) : '' }));
    }));
    if (fit.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fit), 'Ladder fit');
    const p = params();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Image', state.name], ['Size', `${state.img.w}x${state.img.h}`], ['Bit depth', state.img.bitDepth], ['Bands', state.dark ? 'dark on light' : 'bright on dark'],
      ['Default ladder', getLadder(state.defaultLadder).name], ['Tolerance %', p.tol], ['Present if S/N >=', p.minSNR], ['and >= % of row max', p.minRel],
      ['Faint if S/N >=', p.faintSNR], ['Primer-dimer cutoff bp', p.dimerBp], ['Lane width % of pitch', p.laneWidthFrac * 100], ['Background window x pitch', p.bgWindowFrac], ['Lane pitch px', +state.P.toFixed(1)],
      ['Volume', 'sum of background-subtracted signal over the band (rolling-minimum baseline) x strip width; arbitrary units'],
      ['Generated', new Date().toISOString()]
    ]), 'Settings');
    XLSX.writeFile(wb, state.name + '_results.xlsx');
  }

  // ================= misc =================
  let toastT;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms || 2200);
  }
  function savePrefs() {
    const prefs = readLS(LS_PREFS, {});
    prefs.defaultLadder = state.defaultLadder;
    ['polarity', 'ladderPos', 'tol', 'minSNR', 'minRel', 'faintSNR', 'dimerBp', 'laneWidth', 'bgWin', 'expected', 'gelSize', 'comb', 'sheetLayout'].forEach(id => (prefs[id] = $('#' + id).value));
    prefs.style = state.style;
    prefs.rowsBySize = prefs.rowsBySize || {};
    if ($('#gelSize').value) prefs.rowsBySize[$('#gelSize').value] = $('#nRows').value;
    writeLS(LS_PREFS, prefs);
  }
  function loadPrefs() {
    const prefs = readLS(LS_PREFS, {});
    if (prefs.defaultLadder) state.defaultLadder = prefs.defaultLadder;
    if (prefs.style) state.style = Object.assign(state.style, prefs.style);
    ['polarity', 'ladderPos', 'tol', 'minSNR', 'minRel', 'faintSNR', 'dimerBp', 'laneWidth', 'bgWin', 'expected', 'gelSize', 'comb', 'sheetLayout'].forEach(id => { if (prefs[id] != null) $('#' + id).value = prefs[id]; });
    if ($('#gelSize').value && prefs.rowsBySize) $('#nRows').value = prefs.rowsBySize[$('#gelSize').value] || '';
    syncComb();
  }
  function syncComb() {
    const c = $('#comb').value, n = $('#nLanes');
    if (c) { n.value = c; n.dataset.fromComb = '1'; }
    else if (n.dataset.fromComb) { n.value = ''; delete n.dataset.fromComb; }
    n.disabled = !!c;
  }

  // ================= wiring =================
  function wire() {
    const fi = $('#fileInput');
    fi.onchange = () => fi.files[0] && loadImageFile(fi.files[0]);
    const sheetIn = $('#sheetInput');
    sheetIn.onchange = () => sheetIn.files[0] && loadSheet(sheetIn.files[0]);
    // drag & drop anywhere
    const isSheet = f => /\.(xlsx|xls|csv|tsv|txt)$/i.test(f.name);
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.remove('over'); }));
    document.addEventListener('drop', e => {
      const fs = Array.from(e.dataTransfer.files || []);
      const sheet = fs.find(isSheet), image = fs.find(f => !isSheet(f));
      (async () => { if (image) await loadImageFile(image); if (sheet) await loadSheet(sheet); })();
    });

    $('#polarity').onchange = () => { savePrefs(); if (state.img) { setupSignal(); detectLayout(); } };
    $('#ladderSel').onchange = e => { state.defaultLadder = e.target.value; previewLadder($('#ladderPreview'), getLadder(state.defaultLadder)); savePrefs(); state.rows.forEach(r => r.lanes.forEach(l => (l.manualMap = null))); reanalyze(); };
    $('#ladderPos').onchange = () => { savePrefs(); state.rows.forEach(r => r.lanes.forEach(l => (l.ladderOverride = undefined))); reanalyze(); };
    $('#gelSize').onchange = () => {
      const prefs = readLS(LS_PREFS, {});
      const n = prefs.rowsBySize && prefs.rowsBySize[$('#gelSize').value];
      if (n != null) $('#nRows').value = n;
      savePrefs(); if (state.img) detectLayout();
    };
    $('#comb').onchange = () => { syncComb(); savePrefs(); if (state.img) detectLayout(); };
    $('#nRows').onchange = () => { savePrefs(); if (state.img) detectLayout(); };
    $('#nLanes').onchange = () => { if (state.img) detectLayout(); };
    $('#redetect').onclick = () => state.img && detectLayout();
    $('#editMode').onchange = e => { state.edit = e.target.checked; $('#editHint').hidden = !state.edit; $('#viewer').classList.toggle('editing', state.edit); render(); };
    ['tol', 'minSNR', 'minRel', 'faintSNR', 'dimerBp', 'laneWidth', 'bgWin', 'expected'].forEach(id => ($('#' + id).onchange = () => { savePrefs(); reanalyze(); }));
    ['showLabels', 'showLadder', 'showBoxes', 'showLanes'].forEach(id => ($('#' + id).onchange = () => render()));
    $('#invertDisp').onchange = () => { if (state.img) { buildDisplay(); render(); } };
    const styleSync = () => {
      $('#stSize').value = state.style.size; $('#stSizeOut').textContent = state.style.size + '%';
      $('#stLane').value = state.style.lane || '#111827'; $('#stLadder').value = state.style.ladder || COL.ladder;
      $('#stBand').value = state.style.band || '#111827'; $('#stBold').checked = state.style.bold; $('#stOnBand').checked = state.style.onBand;
    };
    const styleSet = (k, v) => { state.style[k] = v; styleSync(); savePrefs(); render(); };
    $('#stSize').oninput = e => styleSet('size', +e.target.value);
    $('#stLane').oninput = e => styleSet('lane', e.target.value);
    $('#stLadder').oninput = e => styleSet('ladder', e.target.value);
    $('#stBand').oninput = e => styleSet('band', e.target.value);
    $('#stBold').onchange = e => styleSet('bold', e.target.checked);
    $('#stOnBand').onchange = e => styleSet('onBand', e.target.checked);
    $('#stReset').onclick = () => { state.style = { size: 100, lane: null, ladder: null, band: null, bold: true, onBand: false }; styleSync(); savePrefs(); render(); };
    styleSync();
    $('#sheetLayout').onchange = () => savePrefs();
    $('#applyPaste').onclick = () => {
      const lines = $('#pasteLabels').value.split(/\r?\n/).filter(s => s.trim());
      applyTable(lines.map(s => s.split(/\t|,(?=\s*\d+\s*$)/)), 'pasted');
    };
    $('#zoomIn').onclick = () => { state.zoom = Math.min(8, state.zoom * 1.4); applyZoom(); };
    $('#zoomOut').onclick = () => { state.zoom = Math.max(0.3, state.zoom / 1.4); applyZoom(); };
    $('#zoomFit').onclick = fitZoom;
    window.addEventListener('resize', () => { if (state.img) applyZoom(); if (state.sel) renderSelection(); });

    cv.addEventListener('pointerdown', e => { if (state.edit) { editDown(e); if (state.drag) cv.setPointerCapture(e.pointerId); } });
    cv.addEventListener('pointermove', e => { if (state.edit) editMove(e); });
    cv.addEventListener('pointerup', () => { if (state.edit) editUp(); });
    cv.addEventListener('click', e => { if (!state.edit) onClickSelect(e); });
    cv.addEventListener('dblclick', e => { if (state.edit) editDbl(e); else dblEdit(e); });

    $('#exportPng').onclick = exportPng; $('#exportCsv').onclick = exportCsv; $('#exportXlsx').onclick = exportXlsx;

    // ladder dialog
    $('#manageLadders').onclick = openLadderDlg;
    $('#ladderList').onclick = e => { const li = e.target.closest('li'); if (li) { dlgSel = li.dataset.id; renderDlg(); } };
    $('#ldSizes').oninput = () => previewLadder($('#ldPreview'), { sizes: parseNums($('#ldSizes').value), bright: parseNums($('#ldBright').value) });
    $('#ldBright').oninput = $('#ldSizes').oninput;
    $('#ldSave').onclick = () => dlgSave(false);
    $('#ldNew').onclick = () => { dlgSel = null; $('#ldName').value = 'New ladder'; $('#ldCat').value = ''; $('#ldSizes').value = ''; $('#ldBright').value = ''; $('#ldSrc').textContent = 'New custom ladder: enter sizes, then Save.'; previewLadder($('#ldPreview'), null); $$('#ladderList li').forEach(li => li.classList.remove('on')); };
    $('#ldDup').onclick = () => { $('#ldName').value = $('#ldName').value + ' (copy)'; dlgSave(true); };
    $('#ldDel').onclick = () => { if (!dlgSel) return; const l = getLadder(dlgSel); if (!confirm(`Remove “${l.name}” from your ladder list?`)) return; deleteUserLadder(dlgSel); dlgSel = state.ladders[0] && state.ladders[0].id; renderDlg(); renderLadderSelect(); reanalyze(); };
    $('#ldExport').onclick = () => {
      const data = { ladders: state.ladders.map(({ id, name, catalog, sizes, bright }) => ({ id, name, catalog, sizes, bright })) };
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'lab-ladders.json');
    };
    $('#ldImport').onclick = () => $('#ldImportFile').click();
    $('#ldImportFile').onchange = async e => {
      try {
        const f = e.target.files[0]; if (!f) return;
        const j = JSON.parse(await f.text()); const arr = Array.isArray(j) ? j : j.ladders || [];
        let n = 0;
        arr.forEach(l => { if (l && l.id && Array.isArray(l.sizes) && l.sizes.length >= 2) { saveUserLadder({ id: String(l.id), name: String(l.name || l.id), catalog: String(l.catalog || ''), sizes: l.sizes.map(Number).filter(x => x > 0), bright: (l.bright || []).map(Number) }); n++; } });
        renderDlg(); renderLadderSelect(); reanalyze(); toast(`Imported ${n} ladder(s)`);
      } catch (err) { toast('Invalid JSON: ' + err.message, 5000); }
      e.target.value = '';
    };
    $('#ldReset').onclick = () => { if (!confirm('Discard all your ladder edits and custom ladders in this browser?')) return; writeLS(LS_LADDERS, { ladders: [], deleted: [] }); mergeLadders(); dlgSel = state.defaultLadder; renderDlg(); renderLadderSelect(); reanalyze(); };
  }

  async function init() {
    loadPrefs();
    mergeLadders(); renderLadderSelect();
    wire();
    try {
      const r = await fetch('lab-ladders.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); labLadders = (Array.isArray(j) ? j : j.ladders || []).filter(l => l && l.id && Array.isArray(l.sizes)); mergeLadders(); renderLadderSelect(); }
    } catch (e) { /* opened from file:// or no lab file */ }
  }
  init();
  window.__gla = state; // for debugging in the console
})();
