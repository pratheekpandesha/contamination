/* app.js — UI for Gel Lane Analyzer */
(function () {
  'use strict';
  const G = window.GelCore;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const LADDER_RE = /^(ladder|marker|mw|dna ladder|l|m|lad|mkr)\b/i;
  const fmtBp = s => (s == null || !isFinite(s) ? '' : s >= 10000 ? (s / 1000).toFixed(1) + ' kb' : Math.round(s) + '');
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
    margins: { l: 0, r: 0, t: 0, b: 0 }
  };
  const params = () => ({
    tol: +$('#tol').value || 10,
    minSNR: +$('#minSNR').value || 6,
    minRel: +$('#minRel').value || 0,
    faintSNR: +$('#faintSNR').value || 3,
    laneWidthFrac: (+$('#laneWidth').value || 60) / 100,
    bgWindowFrac: +$('#bgWin').value || 1,
    detectSNR: 3,
    expected: +$('#expected').value || null
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
        (img.bitDepth === 8 && !/\.tiff?$/i.test(file.name) ? ' · <span class="warn">compressed/8-bit: fine for sizing, use raw TIFF for quantification</span>' : '');
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
        l.expected = l.expectedEdited ? l.expected : (lab && lab.expected ? lab.expected : null);
        let isL;
        if (fromLabels) isL = LADDER_RE.test(l.label || '');
        else if (mode === 'auto' || mode === 'first') isL = li === 0;
        else if (mode === 'last') isL = li === r.lanes.length - 1;
        else if (mode === 'both') isL = li === 0 || li === r.lanes.length - 1;
        else isL = false;
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
      const rowMax = Math.max(1e-9, ...r.lanes.flatMap(l => l.peaks.map(q => q.h)));
      r.lanes.forEach(l => { l.peaks = l.peaks.filter(q => q.h >= 0.02 * rowMax); });
      // ladders: independent fit first
      r.lanes.forEach(l => {
        l.fit = null; l.cal = null;
        if (!l.isLadder) return;
        const lad = getLadder(l.ladderId || r.ladderId || state.defaultLadder);
        l.ladder = lad;
        l.fit = G.fitLadder(l.peaks, lad.sizes, lad.bright, l.manualMap);
        l.cal = G.makeCalibration(l.fit.pairs);
      });
    });
    // consensus across the gel: ladders of the same type should agree. Re-fit the weaker ones using the
    // best-scoring ladder as a template; keep the template-guided fit unless it is clearly worse.
    const allLads = state.rows.flatMap(r => r.lanes.filter(l => l.isLadder && l.fit));
    const byType = new Map();
    allLads.forEach(l => (byType.get(l.ladder.id) || byType.set(l.ladder.id, []).get(l.ladder.id)).push(l));
    byType.forEach(group => {
      const best = group.filter(l => l.cal && !l.fit.manual).sort((a, b) => b.fit.quality - a.fit.quality)[0];
      if (!best) return;
      group.forEach(l => {
        if (l === best || l.fit.manual) return;
        const f2 = G.fitLadder(l.peaks, l.ladder.sizes, l.ladder.bright, null, best.cal);
        if (f2.pairs.length >= 2 && f2.quality >= l.fit.quality - 1.5) {
          const c2 = G.makeCalibration(f2.pairs);
          if (c2) { l.fit = f2; l.fit.consensus = true; l.cal = c2; }
        }
      });
    });
    state.rows.forEach((r, ri) => {
      // sizes
      r.lanes.forEach(l => l.peaks.forEach(q => { const ls = laneLogAt(r, l, q.d); q.size = ls == null ? null : Math.pow(10, ls); }));
      // targets — pass 1: detected bands in the window
      const samples = r.lanes.filter(l => !l.isLadder);
      samples.forEach(l => {
        const E = l.expected || r.expected || p.expected;
        l.E = E || null; l.target = null; l.call = null;
        if (E) {
          const c = l.peaks.filter(q => q.size && Math.abs(Math.log10(q.size / E)) <= tolLog);
          if (c.length) l.target = c.reduce((a, b) => (b.h > a.h ? b : a));
        } else if (l.peaks.length) {
          l.target = l.peaks.reduce((a, b) => (b.h > a.h ? b : a));
        }
      });
      const refH = Math.max(1e-9, ...samples.filter(l => l.target).map(l => l.target.h));
      const halfs = samples.filter(l => l.target).map(l => (l.target.b - l.target.a) / 2);
      const bandHalf = halfs.length ? G.median(halfs) : P / 6;
      // pass 2: calls
      samples.forEach(l => {
        const t = l.target;
        if (t) {
          l.call = t.snr >= p.minSNR && t.h >= (p.minRel / 100) * refH ? 'Present' : t.snr >= p.faintSNR ? 'Faint' : 'Absent';
        } else if (l.E) {
          l.call = 'Absent';
          const dE = laneDAt(r, l, Math.log10(l.E));
          if (dE != null) l.target = { d: dE, a: dE - bandHalf, b: dE + bandHalf, vol: G.windowVolume(l, dE, bandHalf), size: null, absent: true, snr: 0, sat: 0, h: 0 };
        } else {
          l.call = 'Absent';
        }
      });
      // row size labels
      r.sizeLabels = rowSizeLabels(r);
    });
    // relative intensity
    computeRelative();
    render(); renderRows(); renderTable(); renderSelection();
  }

  function computeRelative() {
    let refVol = null;
    if (state.ref) {
      const rl = state.rows[state.ref.r] && state.rows[state.ref.r].lanes[state.ref.l];
      if (rl && rl.target && rl.target.vol > 0) refVol = rl.target.vol;
    }
    state.rows.forEach(r => {
      const mx = Math.max(1e-9, ...r.lanes.filter(l => !l.isLadder && l.target).map(l => l.target.vol));
      r.lanes.forEach(l => { if (l.target) l.rel = (100 * l.target.vol) / (refVol || mx); });
    });
  }

  function rowSizeLabels(r) {
    const samples = r.lanes.filter(l => !l.isLadder);
    const hasE = samples.some(l => l.E);
    const out = [];
    if (hasE) {
      const groups = new Map();
      samples.forEach(l => { if (l.target && !l.target.absent && l.call !== 'Absent' && l.target.size) { const k = l.E; (groups.get(k) || groups.set(k, []).get(k)).push(l.target); } });
      groups.forEach(ts => out.push({ size: G.median(ts.map(t => t.size)), d: G.median(ts.map(t => t.d)), n: ts.length }));
    } else {
      const maxH = Math.max(1e-9, ...samples.flatMap(l => l.peaks.map(q => q.h)));
      const major = samples.flatMap(l => l.peaks.filter(q => q.size && q.h > 0.25 * maxH));
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
  function fontPx() { return Math.round(G.clamp(state.P * 0.2, 10, 42)); }
  function setupCanvas() {
    const P = state.P || 60;
    state.margins = { l: Math.round(P * 1.15), r: Math.round(P * 1.7), t: Math.round(P * 0.3), b: Math.round(P * 0.2) };
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

  function render(forExport) {
    if (!state.img) return;
    setupCanvas();
    const m = state.margins, P = state.P, fs = fontPx();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = lightBg() ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(state.disp, m.l, m.t);
    ctx.translate(m.l, m.t);
    ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
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
        if (showBoxes && !l.isLadder && l.target) {
          const t = l.target, col = COL[l.call] || '#999';
          ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, P / 40);
          ctx.setLineDash(t.absent ? [5, 4] : []);
          const xo = -sl * t.d;
          ctx.strokeRect(l.x + xo - hw - 2, y0 + t.a - 2, 2 * hw + 4, t.b - t.a + 4);
          ctx.setLineDash([]);
        }
        // ladder sizes
        if (showLadder && l.isLadder && l.fit) {
          const sz = Math.round(fs * 0.8);
          ctx.font = `600 ${sz}px system-ui, sans-serif`;
          const leftSide = l.x < state.img.w / 2;
          let lastY = -1e9;
          l.fit.pairs.slice().sort((a, b) => a.peak.d - b.peak.d).forEach(pr => {
            const y = y0 + pr.peak.d, xo = -sl * pr.peak.d;
            const xe = leftSide ? l.x + xo - hw - 3 : l.x + xo + hw + 3;
            ctx.strokeStyle = COL.ladder; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(xe, y); ctx.lineTo(xe + (leftSide ? -6 : 6), y); ctx.stroke();
            if (y - lastY < sz * 0.95) return; // avoid overlapping text
            lastY = y;
            haloText(fmtBp(pr.size), xe + (leftSide ? -8 : 8), y, COL.ladder, leftSide ? 'right' : 'left', 'middle');
          });
          ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        }
        // lane labels
        if (showLabels) {
          const txt = l.label || (l.isLadder ? 'L' : String(li + 1));
          const ty = y0 - r.fwhm * 0.7 - 3;
          const wTxt = ctx.measureText(txt).width;
          const col = l.isLadder ? COL.ladder : textInk();
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
        r.sizeLabels.slice().sort((a, b) => a.d - b.d).forEach(s => {
          const y = G.wellY(r, xr) + s.d;
          if (y - lastY < fs) return; lastY = y;
          ctx.strokeStyle = textInk(); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(xr, y); ctx.lineTo(xr + P * 0.15, y); ctx.stroke();
          haloText('≈ ' + fmtBp(s.size) + (s.size < 10000 ? ' bp' : ''), xr + P * 0.2, y, textInk(), 'left', 'middle');
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

  // ================= Panels =================
  function renderSelection() {
    const box = $('#selInfo');
    const s = state.sel;
    if (!s || !state.rows[s.r] || !state.rows[s.r].lanes[s.l]) { box.innerHTML = 'Click a band (or any spot in a lane) on the gel.'; drawProfile(null); return; }
    const r = state.rows[s.r], l = r.lanes[s.l], b = s.band;
    const ref = state.ref ? state.rows[state.ref.r] && state.rows[state.ref.r].lanes[state.ref.l] : null;
    let rel = '';
    if (b) {
      const refVol = ref && ref.target ? ref.target.vol : Math.max(1e-9, ...r.lanes.filter(x => !x.isLadder && x.target).map(x => x.target.vol));
      rel = ((100 * b.vol) / refVol).toFixed(1) + '% of ' + (ref ? 'reference lane' : 'brightest target in row');
    }
    box.innerHTML = `
      <dl class="kv">
        <dt>Lane</dt><dd>Row ${s.r + 1} · lane ${s.l + 1}${l.label ? ' · <b>' + esc(l.label) + '</b>' : ''} ${l.isLadder ? '<span class="pill Ladder">ladder</span>' : l.call ? `<span class="pill ${l.call}">${l.call}</span>` : ''}</dd>
        ${b ? `
        <dt>Band size</dt><dd>${b.size ? '<b>' + fmtBp(b.size) + ' bp</b>' : '<span class="muted">no ladder calibration</span>'}${b.manual ? ' <span class="muted">(clicked position)</span>' : ''}</dd>
        <dt>Volume</dt><dd>${b.vol.toFixed(1)} a.u. (background-subtracted)</dd>
        <dt>Relative</dt><dd>${rel}</dd>
        <dt>Signal/noise</dt><dd>${b.snr.toFixed(1)}</dd>
        <dt>Saturation</dt><dd>${b.sat > 0.005 ? `<span class="warn">⚠ ${(100 * b.sat).toFixed(1)}% of pixels saturated: volume is underestimated</span>` : 'none'}</dd>
        <dt>Position</dt><dd>${b.d.toFixed(1)} px from well</dd>` : '<dt>Band</dt><dd class="muted">No band here</dd>'}
        <dt>Other bands</dt><dd>${l.peaks.filter(q => q !== b).map(q => fmtBp(q.size) || Math.round(q.d) + 'px').join(', ') || '—'}</dd>
      </dl>
      <div class="row-btns">
        ${!l.isLadder ? `<button class="btn" id="setRef">${state.ref && state.ref.r === s.r && state.ref.l === s.l ? 'Clear reference' : 'Use as reference lane (100%)'}</button>` : ''}
        <button class="btn ghost" id="toggleLadder">${l.isLadder ? 'Not a ladder lane' : 'Mark as ladder lane'}</button>
      </div>`;
    const sr = $('#setRef');
    if (sr) sr.onclick = () => { state.ref = state.ref && state.ref.r === s.r && state.ref.l === s.l ? null : { r: s.r, l: s.l }; computeRelative(); render(); renderSelection(); renderTable(); };
    $('#toggleLadder').onclick = () => { l.ladderOverride = !l.isLadder; reanalyze(); };
    drawProfile(r, l, b);
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
          <label class="small">Expected bp <input type="number" data-row="${ri}" class="rowExp" value="${r.expected || ''}" placeholder="${params().expected || '—'}"></label>
          <span class="muted small">${r.lanes.length} lanes</span>
        </div>
        ${lads.length ? lads.map(({ l, li }) => ladderFitHtml(r, ri, l, li)).join('') : '<div class="fit warn">No ladder lane in this row: sizes unavailable. Mark one (click lane → “Mark as ladder lane”).</div>'}
      </div>`;
    }).join('');
    $$('.rowLadder').forEach(s => (s.onchange = () => { const r = state.rows[+s.dataset.row]; r.ladderId = s.value; r.lanes.forEach(l => { l.manualMap = null; }); reanalyze(); }));
    $$('.rowExp').forEach(s => (s.onchange = () => { state.rows[+s.dataset.row].expected = +s.value || null; reanalyze(); }));
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
    const status = !l.cal ? '<span class="warn">⚠ could not calibrate: assign sizes manually below</span>' : `${n}/${lad.sizes.length} bands matched${r2}${f.manual ? ' · manual' : ''}`;
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

  function resultRows() {
    const out = [];
    state.rows.forEach((r, ri) => r.lanes.forEach((l, li) => {
      const t = l.target;
      out.push({
        Row: ri + 1, Lane: li + 1, Label: l.label || '', Type: l.isLadder ? 'Ladder' : 'Sample',
        Expected_bp: l.isLadder ? '' : (l.E || ''),
        Call: l.isLadder ? '' : (l.call || ''),
        Band_bp: !l.isLadder && t && !t.absent && t.size ? Math.round(t.size) : '',
        Volume: !l.isLadder && t ? +t.vol.toFixed(2) : '',
        Relative_pct: !l.isLadder && t && l.rel != null ? +l.rel.toFixed(1) : '',
        SNR: !l.isLadder && t && !t.absent ? +t.snr.toFixed(1) : '',
        Saturated_pct: !l.isLadder && t && !t.absent ? +(100 * t.sat).toFixed(1) : '',
        All_bands_bp: l.peaks.map(q => (q.size ? Math.round(q.size) : '?')).join('; '),
        Ladder: l.isLadder && l.ladder ? l.ladder.name : '',
        Lane_x_px: Math.round(l.x)
      });
    }));
    return out;
  }

  function renderTable(keepScroll) {
    const t = $('#results');
    if (!state.rows.length) { t.innerHTML = ''; $('#summary').textContent = ''; return; }
    const rows = resultRows();
    const counts = { Present: 0, Faint: 0, Absent: 0 };
    rows.forEach(r => { if (counts[r.Call] != null) counts[r.Call]++; });
    $('#summary').textContent = `${state.rows.length} rows · ${rows.length} lanes · ${counts.Present} present · ${counts.Faint} faint · ${counts.Absent} absent` + (state.ref ? ' · relative to ★ reference lane' : ' · relative to brightest band in row');
    t.innerHTML = `<thead><tr><th>Row</th><th>Lane</th><th>Label</th><th>Ladder</th><th>Expected bp</th><th>Call</th><th>Band bp</th><th>Volume</th><th>Rel %</th><th>S/N</th><th>Sat %</th><th>All bands (bp)</th></tr></thead><tbody>` +
      rows.map((o, i) => {
        const ri = o.Row - 1, li = o.Lane - 1, l = state.rows[ri].lanes[li];
        const sel = state.sel && state.sel.r === ri && state.sel.l === li;
        return `<tr data-r="${ri}" data-l="${li}" class="${sel ? 'sel' : ''} ${li === 0 && ri > 0 ? 'rowsep' : ''}">
          <td>${o.Row}</td><td>${o.Lane}</td>
          <td><input type="text" class="tLabel" value="${esc(o.Label)}"></td>
          <td><input type="checkbox" class="tLad" ${l.isLadder ? 'checked' : ''}></td>
          <td>${l.isLadder ? '' : `<input type="number" class="tExp" value="${l.expectedEdited || l.expected ? l.expected || '' : ''}" placeholder="${l.E || ''}">`}</td>
          <td>${l.isLadder ? '<span class="pill Ladder">ladder</span>' : o.Call ? `<span class="pill ${o.Call}">${o.Call}</span>` : '<span class="pill na">—</span>'}</td>
          <td>${o.Band_bp}</td><td>${o.Volume}</td><td>${o.Relative_pct}</td><td>${o.SNR}</td>
          <td>${o.Saturated_pct !== '' && o.Saturated_pct > 0.5 ? `<span class="warn">⚠ ${o.Saturated_pct}</span>` : o.Saturated_pct}</td>
          <td class="muted">${esc(o.All_bands_bp)}</td></tr>`;
      }).join('') + '</tbody>';
    t.querySelectorAll('tbody tr').forEach(tr => {
      const ri = +tr.dataset.r, li = +tr.dataset.l, l = state.rows[ri].lanes[li];
      tr.onclick = e => { if (e.target.tagName === 'INPUT') return; selectAt(ri, li, null); };
      tr.querySelector('.tLabel').onchange = e => { l.label = e.target.value; l.labelEdited = true; reanalyze(); };
      tr.querySelector('.tLad').onchange = e => { l.ladderOverride = e.target.checked; reanalyze(); };
      const ex = tr.querySelector('.tExp');
      if (ex) ex.onchange = e => { l.expected = +e.target.value || null; l.expectedEdited = true; reanalyze(); };
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
      state.labels = aoa.map(r => ({ label: String(r[0]).trim(), expected: parseFloat(r[1]) || null }));
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
    const rows = resultRows(), keys = Object.keys(rows[0] || {});
    const q = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    download(new Blob([[keys.join(','), ...rows.map(r => keys.map(k => q(r[k])).join(','))].join('\n')], { type: 'text/csv' }), state.name + '_results.csv');
  }
  function exportXlsx() {
    if (!window.XLSX) return toast('Excel writer not loaded');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultRows()), 'Results');
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
      ['Faint if S/N >=', p.faintSNR], ['Lane width % of pitch', p.laneWidthFrac * 100], ['Background window x pitch', p.bgWindowFrac], ['Lane pitch px', +state.P.toFixed(1)],
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
    ['polarity', 'ladderPos', 'tol', 'minSNR', 'minRel', 'faintSNR', 'laneWidth', 'bgWin', 'expected', 'gelSize', 'comb', 'sheetLayout'].forEach(id => (prefs[id] = $('#' + id).value));
    prefs.rowsBySize = prefs.rowsBySize || {};
    if ($('#gelSize').value) prefs.rowsBySize[$('#gelSize').value] = $('#nRows').value;
    writeLS(LS_PREFS, prefs);
  }
  function loadPrefs() {
    const prefs = readLS(LS_PREFS, {});
    if (prefs.defaultLadder) state.defaultLadder = prefs.defaultLadder;
    ['polarity', 'ladderPos', 'tol', 'minSNR', 'minRel', 'faintSNR', 'laneWidth', 'bgWin', 'expected', 'gelSize', 'comb', 'sheetLayout'].forEach(id => { if (prefs[id] != null) $('#' + id).value = prefs[id]; });
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
    ['tol', 'minSNR', 'minRel', 'faintSNR', 'laneWidth', 'bgWin', 'expected'].forEach(id => ($('#' + id).onchange = () => { savePrefs(); reanalyze(); }));
    ['showLabels', 'showLadder', 'showBoxes', 'showLanes'].forEach(id => ($('#' + id).onchange = () => render()));
    $('#invertDisp').onchange = () => { if (state.img) { buildDisplay(); render(); } };
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
    cv.addEventListener('dblclick', e => { if (state.edit) editDbl(e); });

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
