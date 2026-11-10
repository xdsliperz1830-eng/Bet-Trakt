/* Bet-Trakt UI. Depends on window.BetCalc (js/calc.js). */
(function () {
  'use strict';
  const C = window.BetCalc;
  const STORAGE_KEY = 'bettrakt:v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const DEFAULT_SETTINGS = {
    startingBankroll: 1000,
    unitPct: 2,
    unitBasis: 'current',
    kellyMultiplier: 0.25,
    maxUnits: 3,
    oddsFormat: 'american',
    configured: false,
  };

  let firstVisit = false;
  let state = load();
  if (firstVisit) state.bets = sampleBets(); // first visit: show a working example
  let breakdownKey = 'sport';
  let confidence = 2;
  let lastReco = null;

  /* ---------------- Storage ---------------- */

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        return {
          settings: Object.assign({}, DEFAULT_SETTINGS, data.settings),
          bets: Array.isArray(data.bets) ? data.bets : [],
        };
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    firstVisit = true;
    return { settings: Object.assign({}, DEFAULT_SETTINGS), bets: [] };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      if (!cloud.ready) toast('Could not save. Your browser is blocking storage, so download a backup.');
    }
    syncCloud();
  }

  /*
   * Cloud sync (only when the page runs as a claude.ai artifact with the db
   * capability). Bets live under the viewer's private data/users/<id>/ path:
   *   data/users/<id>/settings              one document
   *   data/users/<id>/ledger/bets/<betId>   one document per bet
   * Writes are diffed against what was last synced and sent one at a time.
   */
  const cloud = { ready: false, db: null, uid: null, synced: { settings: null, bets: new Map() }, queue: Promise.resolve(), failed: false };

  function cloudPaths() {
    const base = 'data/users/' + cloud.uid;
    return { settings: base + '/settings', bets: base + '/ledger/bets' };
  }

  function plain(obj) {
    const out = {};
    for (const k in obj) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
  }

  function syncCloud() {
    if (!cloud.ready) return;
    const paths = cloudPaths();
    const ops = [];
    const settingsJson = JSON.stringify(state.settings);
    if (settingsJson !== cloud.synced.settings) {
      cloud.synced.settings = settingsJson;
      ops.push(() => cloud.db.doc(paths.settings).set(plain(state.settings)));
    }
    const seen = new Set();
    for (const b of state.bets) {
      seen.add(b.id);
      const j = JSON.stringify(b);
      if (cloud.synced.bets.get(b.id) !== j) {
        cloud.synced.bets.set(b.id, j);
        const data = plain(b);
        ops.push(() => cloud.db.collection(paths.bets).doc(b.id).set(data));
      }
    }
    for (const id of Array.from(cloud.synced.bets.keys())) {
      if (!seen.has(id)) {
        cloud.synced.bets.delete(id);
        ops.push(() => cloud.db.collection(paths.bets).doc(id).delete());
      }
    }
    ops.forEach((op) => {
      cloud.queue = cloud.queue.then(() => runWithRetry(op)).catch((err) => {
        if (!cloud.failed) {
          cloud.failed = true;
          toast(err && err.code === 'quota_exceeded'
            ? 'Your cloud storage is full. Delete some bets or download a backup.'
            : 'Could not save to your account. Your bets are kept in this browser for now.');
          renderStorageNote();
        }
      });
    });
  }

  function runWithRetry(op) {
    return op().catch((err) => {
      if (err && err.code === 'unavailable') {
        return new Promise((r) => setTimeout(r, 400 + Math.random() * 600)).then(op);
      }
      throw err;
    });
  }

  async function connectCloud() {
    const api = window.claude && typeof window.claude.use === 'function' ? window.claude : null;
    if (!api) return;
    try {
      const [db, user] = await Promise.all([api.use('db'), api.use('user')]);
      if (!db || !user) return;
      const uid = await user.id();
      if (!uid) return;
      cloud.db = db;
      cloud.uid = uid;
      const paths = cloudPaths();
      const [settingsSnap, betsSnap] = await Promise.all([
        db.doc(paths.settings).get(),
        db.collection(paths.bets).get(),
      ]);
      const cloudBets = betsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      if (settingsSnap.exists || cloudBets.length) {
        // The account already has data: it wins over this browser's copy.
        state = {
          settings: Object.assign({}, DEFAULT_SETTINGS, settingsSnap.exists ? settingsSnap.data() : {}),
          bets: cloudBets,
        };
        cloud.synced.settings = settingsSnap.exists ? JSON.stringify(state.settings) : null;
        cloudBets.forEach((b) => cloud.synced.bets.set(b.id, JSON.stringify(b)));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* cache only */ }
        fillSettings();
        resetForm();
        renderAll();
      }
      cloud.ready = true;
      syncCloud(); // first visit on this account: upload what this browser has
      renderStorageNote();
    } catch (e) {
      cloud.ready = false;
      renderStorageNote();
    }
  }

  function renderStorageNote() {
    const el = $('#storage-note');
    if (!el) return;
    el.textContent = cloud.ready && !cloud.failed
      ? 'Your bets are saved to your Claude account in a private space only you can see, so they follow you to other devices.'
      : 'Your bets are stored in this browser only. Download a backup regularly, and use it to move your bets to another device.';
  }

  /* ---------------- In-page confirmation ---------------- */

  function askConfirm(message, confirmLabel, danger) {
    return new Promise((resolve) => {
      const box = $('#confirm');
      $('#confirm-msg').textContent = message;
      const yes = $('#confirm-yes');
      const no = $('#confirm-no');
      yes.textContent = confirmLabel || 'OK';
      yes.classList.toggle('danger-fill', !!danger);
      const prevFocus = document.activeElement;
      box.hidden = false;
      no.focus();
      function done(v) {
        box.hidden = true;
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        box.removeEventListener('keydown', onKey);
        box.removeEventListener('click', onBackdrop);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(v);
      }
      const onYes = () => done(true);
      const onNo = () => done(false);
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      const onBackdrop = (e) => { if (e.target === box) done(false); };
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      box.addEventListener('keydown', onKey);
      box.addEventListener('click', onBackdrop);
    });
  }

  /* ---------------- Helpers ---------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyShort = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function money(n, signed) {
    if (!Number.isFinite(n)) return '—';
    const s = moneyFmt.format(Math.abs(n));
    if (signed) return (n > 0.004 ? '+' : n < -0.004 ? '−' : '') + s;
    return n < 0 ? '−' + s : s;
  }
  function units(n, signed) {
    if (!Number.isFinite(n)) return '—';
    const v = Math.abs(n).toFixed(2).replace(/\.?0+$/, '') || '0';
    const sign = signed ? (n > 0.004 ? '+' : n < -0.004 ? '−' : '') : n < 0 ? '−' : '';
    return sign + v + 'u';
  }
  function pct(n, signed, places) {
    if (!Number.isFinite(n)) return '—';
    const v = (Math.abs(n) * 100).toFixed(places == null ? 1 : places);
    const sign = signed ? (n > 0.0004 ? '+' : n < -0.0004 ? '−' : '') : n < 0 ? '−' : '';
    return sign + v + '%';
  }
  function tone(n) { return n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function today() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function svg(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function currentBankroll() { return C.bankrollSeries(state.settings.startingBankroll, state.bets).current; }
  function currentUnit() { return C.unitSize(state.settings, currentBankroll()); }

  /* ---------------- Tabs ---------------- */

  function showTab(name) {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    try { sessionStorage.setItem('bettrakt:tab', name); } catch (e) { /* ignore */ }
    if (name === 'dashboard') renderCharts();
  }

  /* ---------------- Dashboard ---------------- */

  function renderHeader() {
    const br = currentBankroll();
    $('#header-bankroll').innerHTML = 'Bankroll<strong>' + money(br) + '</strong>1u = ' + money(currentUnit());
  }

  function renderStats() {
    const s = C.summarize(state.bets);
    const series = C.bankrollSeries(state.settings.startingBankroll, state.bets);
    const start = Number(state.settings.startingBankroll) || 0;
    const streak = s.currentStreak
      ? (s.currentStreak.type === 'won' ? 'W' : 'L') + s.currentStreak.length + ' current streak'
      : 'No streak yet';
    const tiles = [
      { label: 'Profit / loss', value: money(s.profit, true), cls: tone(s.profit), meta: 'on ' + money(s.staked) + ' staked' },
      { label: 'Units won', value: units(s.units, true), cls: tone(s.units), meta: s.graded + ' graded bet' + (s.graded === 1 ? '' : 's') },
      { label: 'ROI', value: pct(s.roi, true), cls: tone(s.roi), meta: 'profit ÷ amount staked' },
      { label: 'Win rate', value: s.wins + s.losses ? pct(s.winRate, false) : '—', meta: s.wins + '-' + s.losses + (s.pushes ? '-' + s.pushes : '') + ' · ' + streak },
      { label: 'Bankroll', value: money(series.current), cls: '', meta: (start ? pct((series.current - start) / start, true) + ' since start' : 'Set a bankroll') + ' · max drawdown ' + pct(series.maxDrawdownPct, false, 0) },
      { label: 'Pending', value: money(s.pendingStake), meta: s.pending + ' open bet' + (s.pending === 1 ? '' : 's') },
    ];
    $('#stats').innerHTML = tiles.map((t) =>
      '<div class="card stat"><div class="label">' + t.label + '</div><div class="value ' + (t.cls || '') + '">' + t.value +
      '</div><div class="meta">' + t.meta + '</div></div>'
    ).join('');
  }

  function renderUnitPanel() {
    const st = state.settings;
    const br = currentBankroll();
    const unit = currentUnit();
    const rows = Object.keys(C.CONFIDENCE_UNITS).map((k) => {
      const u = Math.min(C.CONFIDENCE_UNITS[k], Number(st.maxUnits) || 3);
      return '<tr><td>' + k + ' ' + '★'.repeat(Number(k)) + '</td><td>' + units(u) + '</td><td>' + money(u * unit) + '</td></tr>';
    }).join('');
    $('#unit-panel').innerHTML =
      '<div class="unit-callout">' +
        '<div><div class="label">1 unit</div><div class="value">' + money(unit) + '</div></div>' +
        '<div><div class="label">Unit size</div><div class="value">' + st.unitPct + '%</div></div>' +
        '<div><div class="label">Based on</div><div class="value">' + (st.unitBasis === 'current' ? money(br) : money(Number(st.startingBankroll))) + '</div></div>' +
        '<div><div class="label">Max bet</div><div class="value">' + money(unit * st.maxUnits) + '</div></div>' +
      '</div>' +
      '<table class="ladder"><thead><tr><th>Confidence</th><th>Units</th><th>Stake</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderAdvice() {
    const advice = C.unitAdvice(state.settings, state.bets);
    const msgs = advice.messages.slice();
    if (!state.settings.configured) {
      msgs.unshift({ level: 'info', text: 'You are using the default $1,000 bankroll. Enter your real bankroll in Settings.' });
    }
    const labels = { good: 'Good', info: 'Tip', warning: 'Watch', serious: 'Action', critical: 'Risk' };
    $('#advice').innerHTML = msgs.map((m) =>
      '<li><span class="badge ' + m.level + '">' + labels[m.level] + '</span><span>' + esc(m.text) + '</span></li>'
    ).join('');
  }

  /* ---------------- Charts ---------------- */

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { ticks, lo, hi };
  }

  function positionTooltip(container, tip, x, y) {
    const cw = container.clientWidth;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > cw) left = x - tw - 14;
    left = Math.max(0, left);
    let top = y - th - 10;
    if (top < 0) top = y + 14;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function renderBankrollChart() {
    const host = $('#bankroll-chart');
    const width = host.clientWidth;
    if (!width) return; // hidden tab; rendered when shown
    const start = Number(state.settings.startingBankroll) || 0;
    const series = C.bankrollSeries(start, state.bets);
    const pts = series.points;
    host.innerHTML = '';
    if (pts.length < 2) {
      host.innerHTML = '<div class="empty">Settle a bet to see your bankroll chart.</div>';
      return;
    }

    const height = 260, m = { t: 12, r: 12, b: 26, l: 64 };
    const iw = width - m.l - m.r, ih = height - m.t - m.b;
    const vals = pts.map((p) => p.bankroll).concat([start]);
    const y = niceTicks(Math.min.apply(null, vals), Math.max.apply(null, vals), 4);
    const n = pts.length - 1;
    const sx = (i) => m.l + (i / n) * iw;
    const sy = (v) => m.t + ih - ((v - y.lo) / (y.hi - y.lo)) * ih;

    const root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Bankroll after each settled bet, from ' + money(start) + ' to ' + money(series.current) });
    y.ticks.forEach((v) => {
      svg('line', { class: 'gridline', x1: m.l, x2: width - m.r, y1: sy(v), y2: sy(v) }, root);
      const t = svg('text', { class: 'tick', x: m.l - 8, y: sy(v) + 4, 'text-anchor': 'end' }, root);
      t.textContent = moneyShort.format(v);
    });
    svg('line', { class: 'baseline', x1: m.l, x2: width - m.r, y1: m.t + ih, y2: m.t + ih }, root);
    svg('line', { class: 'ref', x1: m.l, x2: width - m.r, y1: sy(start), y2: sy(start) }, root);

    // x ticks: bet numbers
    const xt = niceTicks(0, n, Math.min(6, n));
    xt.ticks.filter((v) => v >= 0 && v <= n && Number.isInteger(v)).forEach((v) => {
      const t = svg('text', { class: 'tick', x: sx(v), y: height - 6, 'text-anchor': 'middle' }, root);
      t.textContent = v === 0 ? 'Start' : '#' + v;
    });

    const d = pts.map((p, i) => (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(p.bankroll).toFixed(1)).join(' ');
    svg('path', { class: 'area', d: d + ' L' + sx(n) + ' ' + (m.t + ih) + ' L' + sx(0) + ' ' + (m.t + ih) + ' Z' }, root);
    svg('path', { class: 'line', d: d }, root);

    // End-point direct label
    const last = pts[n];
    svg('circle', { class: 'dot', cx: sx(n), cy: sy(last.bankroll), r: 4 }, root);

    const cross = svg('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' }, root);
    const hoverDot = svg('circle', { class: 'dot', r: 5, visibility: 'hidden' }, root);
    const overlay = svg('rect', { x: m.l, y: 0, width: iw, height: height, fill: 'transparent' }, root);
    host.appendChild(root);

    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    host.appendChild(tip);

    function onMove(ev) {
      const rect = root.getBoundingClientRect();
      const scale = width / rect.width;
      const px = (ev.clientX - rect.left) * scale;
      const i = Math.max(0, Math.min(n, Math.round(((px - m.l) / iw) * n)));
      const p = pts[i];
      const cx = sx(i), cy = sy(p.bankroll);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', cx); hoverDot.setAttribute('cy', cy); hoverDot.setAttribute('visibility', 'visible');
      if (p.bet) {
        const pl = C.betProfit(p.bet);
        tip.innerHTML = '<div class="t-title">Bet #' + i + ' · ' + esc(fmtDate(p.bet.date)) + '</div>' +
          '<div style="margin:2px 0 4px;color:var(--text-2)">' + esc(p.bet.event || '') + (p.bet.selection ? ' · ' + esc(p.bet.selection) : '') + '</div>' +
          '<div class="t-row">Result <b>' + esc(p.bet.status) + ' ' + money(pl, true) + '</b></div>' +
          '<div class="t-row">Bankroll <b>' + money(p.bankroll) + '</b></div>';
      } else {
        tip.innerHTML = '<div class="t-title">Start</div><div class="t-row">Bankroll <b>' + money(p.bankroll) + '</b></div>';
      }
      positionTooltip(host, tip, cx / scale, cy / scale);
    }
    function onLeave() {
      cross.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    }
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerdown', onMove);
    overlay.addEventListener('pointerleave', onLeave);
  }

  function breakdownGroups() {
    const groups = C.groupSummary(state.bets.filter(C.isGraded), breakdownKey);
    const MAX = 10;
    if (groups.length <= MAX) return groups;
    const keep = groups.slice(0, MAX - 1);
    const rest = groups.slice(MAX - 1);
    const restNames = new Set(rest.map((g) => g.name));
    const restBets = state.bets.filter((b) => C.isGraded(b) && restNames.has((b[breakdownKey] && String(b[breakdownKey]).trim()) || 'Other'));
    keep.push(Object.assign({ name: 'Other (' + rest.length + ')' }, C.summarize(restBets)));
    return keep;
  }

  function renderBreakdown() {
    const host = $('#breakdown-chart');
    const groups = breakdownGroups();
    const table = $('#breakdown-table');
    if (!groups.length) {
      host.innerHTML = '<div class="empty">No settled bets yet.</div>';
      table.innerHTML = '';
      return;
    }

    table.innerHTML = '<thead><tr><th>' + { sport: 'Sport', type: 'Bet type', book: 'Sportsbook' }[breakdownKey] +
      '</th><th class="num">Record</th><th class="num">Staked</th><th class="num">Profit</th><th class="num">Units</th><th class="num">ROI</th></tr></thead><tbody>' +
      groups.map((g) => '<tr><td>' + esc(g.name) + '</td><td class="num">' + g.wins + '-' + g.losses + (g.pushes ? '-' + g.pushes : '') +
        '</td><td class="num">' + money(g.staked) + '</td><td class="num ' + tone(g.profit) + '">' + money(g.profit, true) +
        '</td><td class="num ' + tone(g.units) + '">' + units(g.units, true) + '</td><td class="num ' + tone(g.roi) + '">' + pct(g.roi, true) + '</td></tr>').join('') +
      '</tbody>';

    const width = host.clientWidth;
    if (!width) return;
    host.innerHTML = '';
    const rowH = 30, labelW = Math.min(130, width * 0.3), valueW = 84;
    const height = groups.length * rowH + 8;
    const maxAbs = Math.max.apply(null, groups.map((g) => Math.abs(g.profit))) || 1;
    const hasNeg = groups.some((g) => g.profit < 0);
    const hasPos = groups.some((g) => g.profit > 0);
    const plotL = labelW + (hasNeg ? valueW : 8);
    const plotR = width - (hasPos ? valueW : 8);
    const plotW = Math.max(40, plotR - plotL);
    const zeroX = hasNeg && hasPos ? plotL + plotW / 2 : hasNeg ? plotR : plotL;
    const half = hasNeg && hasPos ? plotW / 2 : plotW;
    const root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Profit by ' + breakdownKey + '. Full figures in the table below.' });
    svg('line', { class: 'baseline', x1: zeroX, x2: zeroX, y1: 0, y2: height }, root);

    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;

    groups.forEach((g, i) => {
      const yMid = 4 + i * rowH + rowH / 2;
      const len = (Math.abs(g.profit) / maxAbs) * half;
      const row = svg('g', { class: 'bar-row' }, root);
      const lab = svg('text', { class: 'cat-label', x: 0, y: yMid + 4 }, row);
      lab.textContent = g.name.length > 18 ? g.name.slice(0, 17) + '…' : g.name;
      const barH = 14;
      const x = g.profit >= 0 ? zeroX : zeroX - len;
      if (len > 0.5) {
        // Rounded at the data end only; square against the zero line.
        const r = Math.min(4, len / 2);
        const yTop = yMid - barH / 2;
        const path = g.profit >= 0
          ? 'M' + x + ' ' + yTop + ' H' + (x + len - r) + ' Q' + (x + len) + ' ' + yTop + ' ' + (x + len) + ' ' + (yTop + r) + ' V' + (yTop + barH - r) + ' Q' + (x + len) + ' ' + (yTop + barH) + ' ' + (x + len - r) + ' ' + (yTop + barH) + ' H' + x + ' Z'
          : 'M' + (x + len) + ' ' + yTop + ' H' + (x + r) + ' Q' + x + ' ' + yTop + ' ' + x + ' ' + (yTop + r) + ' V' + (yTop + barH - r) + ' Q' + x + ' ' + (yTop + barH) + ' ' + (x + r) + ' ' + (yTop + barH) + ' H' + (x + len) + ' Z';
        svg('path', { class: 'bar ' + (g.profit >= 0 ? 'bar-pos' : 'bar-neg'), d: path }, row);
      }
      const vl = svg('text', {
        class: 'bar-label',
        x: g.profit >= 0 ? zeroX + len + 6 : zeroX - len - 6,
        y: yMid + 4,
        'text-anchor': g.profit >= 0 ? 'start' : 'end',
      }, row);
      vl.textContent = money(g.profit, true);
      const hit = svg('rect', { class: 'hit', x: 0, y: yMid - rowH / 2, width: width, height: rowH }, row);
      const show = () => {
        tip.innerHTML = '<div class="t-title">' + esc(g.name) + '</div>' +
          '<div class="t-row">Record <b>' + g.wins + '-' + g.losses + (g.pushes ? '-' + g.pushes : '') + '</b></div>' +
          '<div class="t-row">Profit <b>' + money(g.profit, true) + '</b></div>' +
          '<div class="t-row">Units <b>' + units(g.units, true) + '</b></div>' +
          '<div class="t-row">ROI <b>' + pct(g.roi, true) + '</b></div>';
        const rect = root.getBoundingClientRect();
        const scale = width / rect.width;
        positionTooltip(host, tip, (g.profit >= 0 ? zeroX + len : zeroX - len) / scale, yMid / scale);
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerdown', show);
      hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    });
    host.appendChild(root);
    host.appendChild(tip);
  }

  function renderCharts() {
    renderBankrollChart();
    renderBreakdown();
  }

  /* ---------------- Bets table ---------------- */

  function renderFilters() {
    const sports = Array.from(new Set(state.bets.map((b) => (b.sport || '').trim()).filter(Boolean))).sort();
    const books = Array.from(new Set(state.bets.map((b) => (b.book || '').trim()).filter(Boolean))).sort();
    const sel = $('#filter-sport');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All sports</option>' + sports.map((s) => '<option>' + esc(s) + '</option>').join('');
    sel.value = sports.includes(cur) ? cur : '';
    $('#sport-list').innerHTML = sports.map((s) => '<option value="' + esc(s) + '">').join('');
    $('#book-list').innerHTML = books.map((s) => '<option value="' + esc(s) + '">').join('');
  }

  function filteredBets() {
    const q = $('#filter-text').value.trim().toLowerCase();
    const status = $('#filter-status').value;
    const sport = $('#filter-sport').value;
    return state.bets.filter((b) => {
      if (status && b.status !== status) return false;
      if (sport && (b.sport || '').trim() !== sport) return false;
      if (q && ![b.event, b.selection, b.notes, b.sport, b.type, b.book].join(' ').toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => -C.byDate(a, b));
  }

  function renderBetsTable() {
    const list = filteredBets();
    const s = C.summarize(list);
    $('#bets-summary').textContent = list.length
      ? list.length + ' bet' + (list.length === 1 ? '' : 's') + ' · ' + money(s.profit, true) + ' · ' + units(s.units, true) + ' · ROI ' + pct(s.roi, true)
      : '';
    const table = $('#bets-table');
    if (!state.bets.length) {
      table.innerHTML = '<tbody><tr><td class="empty">No bets yet. Add your first bet above, or load sample bets in Settings.</td></tr></tbody>';
      return;
    }
    if (!list.length) {
      table.innerHTML = '<tbody><tr><td class="empty">No bets match these filters.</td></tr></tbody>';
      return;
    }
    const fmt = state.settings.oddsFormat;
    table.innerHTML =
      '<thead><tr><th>Date</th><th>Event</th><th>Sport</th><th class="num">Odds</th><th class="num">Stake</th><th>Result</th><th class="num">P/L</th><th class="num"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>' +
      list.map((b) => {
        const pl = C.betProfit(b);
        const settle = b.status === 'pending'
          ? '<button class="btn small" data-act="won" data-id="' + b.id + '" title="Mark won">W</button>' +
            '<button class="btn small" data-act="lost" data-id="' + b.id + '" title="Mark lost">L</button>' +
            '<button class="btn small" data-act="push" data-id="' + b.id + '" title="Mark push">P</button>'
          : '';
        return '<tr>' +
          '<td>' + esc(fmtDate(b.date)) + '</td>' +
          '<td class="event">' + esc(b.event) + (b.selection ? '<div class="sel">' + esc(b.selection) + (b.type ? ' · ' + esc(b.type) : '') + '</div>' : (b.type ? '<div class="sel">' + esc(b.type) + '</div>' : '')) + '</td>' +
          '<td>' + esc(b.sport || '') + '</td>' +
          '<td class="num">' + C.formatOdds(Number(b.odds), fmt) + '</td>' +
          '<td class="num">' + money(Number(b.stake)) + '<div class="sel" style="color:var(--muted);font-size:12px">' + units(Number(b.units)) + '</div></td>' +
          '<td><span class="status ' + b.status + '">' + (b.status === 'cashout' ? 'Cashed out' : b.status) + '</span></td>' +
          '<td class="num ' + tone(pl) + '">' + (b.status === 'pending' ? '<span style="color:var(--muted)">to win ' + money(Number(b.stake) * (Number(b.odds) - 1)) + '</span>' : money(pl, true)) + '</td>' +
          '<td><div class="row-actions">' + settle +
            '<button class="btn small" data-act="edit" data-id="' + b.id + '">Edit</button>' +
            '<button class="btn small danger" data-act="delete" data-id="' + b.id + '" aria-label="Delete bet">✕</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody>';
  }

  /* ---------------- Bet form ---------------- */

  const form = $('#bet-form');

  function oddsFromForm() {
    return C.parseOdds(form.odds.value, state.settings.oddsFormat);
  }

  function stakeDollarsFromForm(unitAtEntry) {
    const v = Number(form.stake.value);
    if (!(v >= 0)) return NaN;
    return $('#f-stake-mode').value === 'units' ? v * unitAtEntry : v;
  }

  function editingBet() {
    const id = form.id.value;
    return id ? state.bets.find((b) => b.id === id) : null;
  }

  /** Unit value used for this form: the bet's original unit when editing, otherwise the current unit. */
  function formUnit() {
    const b = editingBet();
    if (b && Number(b.units) > 0 && Number(b.stake) > 0) return Number(b.stake) / Number(b.units);
    return currentUnit();
  }

  function updateFormHints() {
    const odds = oddsFromForm();
    const fmt = state.settings.oddsFormat;
    $('#odds-label').textContent = 'Odds (' + (fmt === 'decimal' ? 'decimal' : 'American') + ')';
    form.odds.placeholder = fmt === 'decimal' ? '1.91' : '-110';
    $('#odds-hint').textContent = Number.isFinite(odds)
      ? 'Break-even ' + pct(C.impliedProbability(odds), false) + ' · ' + C.formatOdds(odds, fmt === 'decimal' ? 'american' : 'decimal')
      : form.odds.value ? 'Invalid odds' : ' ';
    $('#confidence-hint').textContent = C.CONFIDENCE_UNITS[confidence] + 'u at confidence ' + confidence;

    const unit = formUnit();
    const dollars = stakeDollarsFromForm(unit);
    if (form.stake.value && Number.isFinite(dollars) && unit > 0) {
      const toWin = Number.isFinite(odds) ? ' · to win ' + money(dollars * (odds - 1)) : '';
      $('#stake-hint').textContent = ($('#f-stake-mode').value === 'units' ? money(dollars) : units(dollars / unit)) + toWin;
    } else {
      $('#stake-hint').textContent = '1u = ' + money(unit);
    }
    $('#cashout-field').hidden = form.status.value !== 'cashout';
    updateReco();
  }

  function updateReco() {
    const box = $('#reco');
    const odds = oddsFromForm();
    const wp = form.winProb.value === '' ? null : Number(form.winProb.value) / 100;
    const r = C.recommendStake({
      bankroll: currentBankroll(),
      unit: currentUnit(),
      odds,
      winProb: wp,
      confidence,
      kellyMultiplier: state.settings.kellyMultiplier,
      maxUnits: state.settings.maxUnits,
    });
    lastReco = r;
    box.classList.toggle('pass', r.pass);
    if (!r.method) {
      const html = '<div class="why">' + esc(r.reasons[0]) + '</div>';
      if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
      return;
    }
    const html =
      '<div><div style="font-size:12px;color:var(--text-2)">Recommended stake</div><div class="big">' +
        (r.pass ? 'Pass' : units(r.units) + ' · ' + money(r.stake)) + '</div></div>' +
      '<div class="why">' + r.reasons.map((t) => '<div>' + esc(t) + '</div>').join('') + '</div>' +
      (r.pass ? '' : '<button type="button" class="btn" data-use-reco>Use this stake</button>');
    // Only touch the DOM when the content changes, so the button survives blur-triggered updates.
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  function useReco() {
    if (!lastReco || lastReco.pass || !(lastReco.stake > 0)) return;
    $('#f-stake-mode').value = 'dollars';
    form.stake.value = lastReco.stake.toFixed(2);
    updateFormHints();
  }

  function setConfidence(v) {
    confidence = v;
    $$('#confidence button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v)));
  }

  function resetForm() {
    form.reset();
    form.id.value = '';
    form.date.value = today();
    $('#f-stake-mode').value = 'dollars';
    setConfidence(2);
    $('#form-title').textContent = 'Add a bet';
    $('#save-btn').textContent = 'Add bet';
    $('#cancel-edit').hidden = true;
    updateFormHints();
  }

  function startEdit(id) {
    const b = state.bets.find((x) => x.id === id);
    if (!b) return;
    showTab('bets');
    form.id.value = b.id;
    form.date.value = b.date || today();
    form.sport.value = b.sport || '';
    form.type.value = b.type || '';
    form.book.value = b.book || '';
    form.event.value = b.event || '';
    form.selection.value = b.selection || '';
    form.odds.value = C.formatOdds(Number(b.odds), state.settings.oddsFormat);
    form.winProb.value = b.winProb ? (b.winProb * 100).toFixed(1).replace(/\.0$/, '') : '';
    form.stake.value = Number(b.stake).toFixed(2);
    $('#f-stake-mode').value = 'dollars';
    form.status.value = b.status;
    form.cashout.value = b.cashout != null ? b.cashout : '';
    form.notes.value = b.notes || '';
    setConfidence(Number(b.confidence) || 2);
    $('#form-title').textContent = 'Edit bet';
    $('#save-btn').textContent = 'Save changes';
    $('#cancel-edit').hidden = false;
    updateFormHints();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function submitBet(ev) {
    ev.preventDefault();
    const odds = oddsFromForm();
    if (!Number.isFinite(odds)) {
      toast(state.settings.oddsFormat === 'decimal' ? 'Enter decimal odds above 1.00, like 1.91.' : 'Enter American odds like -110 or +150.');
      form.odds.focus();
      return;
    }
    const existing = editingBet();
    const unit = formUnit();
    const stake = C.round(stakeDollarsFromForm(unit), 2);
    if (!(stake > 0)) {
      toast('Enter a stake above zero.');
      form.stake.focus();
      return;
    }
    if (form.status.value === 'cashout' && form.cashout.value === '') {
      toast('Enter the cash-out amount.');
      form.cashout.focus();
      return;
    }
    const wp = form.winProb.value === '' ? null : Number(form.winProb.value) / 100;
    const bet = {
      id: existing ? existing.id : uid(),
      createdAt: existing ? existing.createdAt : Date.now(),
      date: form.date.value || today(),
      sport: form.sport.value.trim(),
      type: form.type.value.trim(),
      book: form.book.value.trim(),
      event: form.event.value.trim(),
      selection: form.selection.value.trim(),
      odds,
      stake,
      units: unit > 0 ? C.round(stake / unit, 4) : 0,
      status: form.status.value,
      cashout: form.status.value === 'cashout' ? Number(form.cashout.value) : null,
      confidence,
      winProb: wp,
      notes: form.notes.value.trim(),
    };
    if (existing) Object.assign(existing, bet);
    else state.bets.push(bet);
    save();
    toast(existing ? 'Bet updated.' : 'Bet added: ' + units(bet.units) + ' on ' + (bet.selection || bet.event) + '.');
    resetForm();
    renderAll();
  }

  /* ---------------- Settings ---------------- */

  const sForm = $('#settings-form');

  function fillSettings() {
    const s = state.settings;
    sForm.startingBankroll.value = s.startingBankroll;
    sForm.unitPct.value = s.unitPct;
    sForm.unitBasis.value = s.unitBasis;
    sForm.kellyMultiplier.value = String(s.kellyMultiplier);
    sForm.maxUnits.value = s.maxUnits;
    sForm.oddsFormat.value = s.oddsFormat;
    syncPresets();
  }

  function syncPresets() {
    const v = Number(sForm.unitPct.value);
    let note = ' ';
    $$('#risk-presets button').forEach((b) => {
      const p = C.RISK_PROFILES[b.dataset.profile];
      const on = p.unitPct === v;
      b.setAttribute('aria-pressed', String(on));
      if (on) note = p.note;
    });
    const br = Number(sForm.startingBankroll.value) || 0;
    if (note === ' ' && v) note = 'Custom: ' + v + '% of ' + money(br) + ' = ' + money(br * v / 100) + ' per unit.';
    else if (v) note += ' ' + money(br * v / 100) + ' per unit.';
    $('#risk-note').textContent = note;
  }

  function submitSettings(ev) {
    ev.preventDefault();
    const s = state.settings;
    s.startingBankroll = Math.max(0, Number(sForm.startingBankroll.value) || 0);
    s.unitPct = Math.max(0.1, Number(sForm.unitPct.value) || 2);
    s.unitBasis = sForm.unitBasis.value;
    s.kellyMultiplier = Number(sForm.kellyMultiplier.value) || 0.25;
    s.maxUnits = Math.max(0.5, Number(sForm.maxUnits.value) || 3);
    s.oddsFormat = sForm.oddsFormat.value;
    s.configured = true;
    save();
    renderAll();
    updateFormHints();
    toast('Settings saved. 1 unit = ' + money(currentUnit()) + '.');
  }

  /* ---------------- Import / export ---------------- */

  async function download(name, text, type) {
    const api = window.claude && typeof window.claude.use === 'function' ? window.claude : null;
    const downloads = api ? await api.use('downloads').catch(() => null) : null;
    if (downloads) {
      try {
        await downloads.save({ filename: name, data: text });
        toast('Saved ' + name + '.');
      } catch (err) {
        if (err && err.code === 'declined') return;
        toast(err && err.code === 'rate_limited' ? 'A save is already waiting for you. Finish that one first.' : 'Saving files is not available here.');
      }
      return;
    }
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.bets)) throw new Error('bad file');
        const bets = data.bets.filter((b) => b && Number(b.odds) > 1 && Number(b.stake) >= 0 && C.STATUSES.includes(b.status))
          .map((b) => Object.assign({ id: uid(), createdAt: Date.now() }, b));
        askConfirm('Replace your ' + state.bets.length + ' current bets with the ' + bets.length + ' bets in this backup?', 'Replace bets', true).then((ok) => {
          if (!ok) return;
          state = { settings: Object.assign({}, DEFAULT_SETTINGS, data.settings), bets };
          save();
          fillSettings();
          resetForm();
          renderAll();
          toast('Restored ' + bets.length + ' bets.');
        });
      } catch (e) {
        toast('That file is not a Bet-Trakt backup.');
      }
    };
    reader.readAsText(file);
  }

  function sampleBets() {
    // Deterministic pseudo-random sample so the demo looks the same every time.
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const picks = [
      ['NFL', 'Spread', 'Chiefs vs Bills', 'Chiefs -2.5', -110],
      ['NFL', 'Total', 'Eagles vs Cowboys', 'Over 47.5', -105],
      ['NBA', 'Moneyline', 'Celtics vs Knicks', 'Knicks ML', 145],
      ['NBA', 'Spread', 'Nuggets vs Suns', 'Nuggets -4', -110],
      ['NBA', 'Prop', 'Lakers vs Warriors', 'Curry o4.5 threes', 120],
      ['NHL', 'Moneyline', 'Rangers vs Bruins', 'Bruins ML', -125],
      ['NCAAF', 'Spread', 'Georgia vs Alabama', 'Alabama +6.5', -110],
      ['Soccer', 'Moneyline', 'Arsenal vs Chelsea', 'Arsenal', 110],
      ['NFL', 'Parlay', '3-leg parlay', 'Ravens / 49ers / Lions ML', 260],
      ['NBA', 'Total', 'Bucks vs Heat', 'Under 221.5', -110],
    ];
    const books = ['DraftKings', 'FanDuel', 'BetMGM'];
    const out = [];
    const unit = C.unitSize(state.settings, state.settings.startingBankroll);
    const start = new Date();
    start.setDate(start.getDate() - 60);
    for (let i = 0; i < 42; i++) {
      const p = picks[Math.floor(rnd() * picks.length)];
      const d = new Date(start);
      d.setDate(start.getDate() + Math.floor(i * 1.4));
      const conf = 1 + Math.floor(rnd() * 4);
      const u = C.CONFIDENCE_UNITS[conf];
      const odds = C.americanToDecimal(p[4]);
      const winChance = Math.min(0.8, 1 / odds + 0.015);
      const r = rnd();
      const status = i >= 39 ? 'pending' : r < 0.04 ? 'push' : r < 0.04 + winChance * 0.96 ? 'won' : 'lost';
      out.push({
        id: uid(), createdAt: Date.now() + i, date: d.toISOString().slice(0, 10),
        sport: p[0], type: p[1], event: p[2], selection: p[3], book: books[Math.floor(rnd() * books.length)],
        odds, stake: C.round(u * unit, 2), units: u, status, cashout: null, confidence: conf, winProb: null, notes: 'Sample bet', sample: true,
      });
    }
    return out;
  }

  /* ---------------- Wire up ---------------- */

  function renderDemoBanner() {
    const n = state.bets.filter((b) => b.sample).length;
    $$('.demo-banner').forEach((el) => {
      el.hidden = n === 0;
      const c = el.querySelector('[data-sample-count]');
      if (c) c.textContent = n;
    });
  }

  function renderAll() {
    renderDemoBanner();
    renderHeader();
    renderStats();
    renderUnitPanel();
    renderAdvice();
    renderFilters();
    renderBetsTable();
    renderCharts();
  }

  function init() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    $$('#breakdown-key button').forEach((b) => b.addEventListener('click', () => {
      breakdownKey = b.dataset.key;
      $$('#breakdown-key button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderBreakdown();
    }));

    $$('#confidence button').forEach((b) => b.addEventListener('click', () => {
      setConfidence(Number(b.dataset.v));
      updateFormHints();
    }));

    ['input', 'change'].forEach((evt) => form.addEventListener(evt, (e) => {
      if (e.target.closest('#confidence')) return;
      updateFormHints();
    }));
    form.addEventListener('submit', submitBet);
    $('#cancel-edit').addEventListener('click', resetForm);
    $('#reco').addEventListener('click', (e) => { if (e.target.closest('[data-use-reco]')) useReco(); });

    $('#bets-table').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const bet = state.bets.find((b) => b.id === btn.dataset.id);
      if (!bet) return;
      const act = btn.dataset.act;
      if (act === 'edit') return startEdit(bet.id);
      if (act === 'delete') {
        askConfirm('Delete "' + (bet.selection || bet.event) + '"? This cannot be undone.', 'Delete bet', true).then((ok) => {
          if (!ok) return;
          state.bets = state.bets.filter((b) => b !== bet);
          if (form.id.value === bet.id) resetForm();
          save();
          renderAll();
          toast('Bet deleted.');
        });
        return;
      } else {
        bet.status = act;
        toast('Marked ' + act + ': ' + money(C.betProfit(bet), true) + '.');
      }
      save();
      renderAll();
    });

    ['#filter-text', '#filter-status', '#filter-sport'].forEach((s) => $(s).addEventListener('input', renderBetsTable));

    sForm.addEventListener('submit', submitSettings);
    sForm.addEventListener('input', syncPresets);
    $$('#risk-presets button').forEach((b) => b.addEventListener('click', () => {
      sForm.unitPct.value = C.RISK_PROFILES[b.dataset.profile].unitPct;
      syncPresets();
    }));

    $('#export-csv').addEventListener('click', () => {
      if (!state.bets.length) return toast('No bets to export.');
      download('bet-trakt-' + today() + '.csv', C.toCSV(state.bets), 'text/csv');
    });
    $('#export-json').addEventListener('click', () => {
      download('bet-trakt-backup-' + today() + '.json', JSON.stringify(state, null, 2), 'application/json');
    });
    $('#import-json').addEventListener('change', (e) => {
      if (e.target.files[0]) importBackup(e.target.files[0]);
      e.target.value = '';
    });
    $('#load-sample').addEventListener('click', async () => {
      if (state.bets.some((b) => b.sample)) return toast('Sample bets are already loaded.');
      if (state.bets.length && !(await askConfirm('Add 42 sample bets alongside your ' + state.bets.length + ' bets? You can remove them in one click later.', 'Add samples'))) return;
      state.bets = state.bets.concat(sampleBets());
      save();
      renderAll();
      toast('Loaded 42 sample bets.');
    });
    $('#clear-all').addEventListener('click', async () => {
      if (!state.bets.length) return toast('No bets to delete.');
      if (!(await askConfirm('Delete all ' + state.bets.length + ' bets? Download a backup first if you might want them back.', 'Delete all bets', true))) return;
      state.bets = [];
      save();
      resetForm();
      renderAll();
      toast('All bets deleted.');
    });
    $$('[data-remove-samples]').forEach((b) => b.addEventListener('click', () => {
      const n = state.bets.filter((x) => x.sample).length;
      state.bets = state.bets.filter((x) => !x.sample);
      save();
      resetForm();
      renderAll();
      toast('Removed ' + n + ' sample bets.');
      if (!state.settings.configured) showTab('settings');
    }));

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderCharts, 120);
    });

    fillSettings();
    resetForm();
    renderAll();
    renderStorageNote();
    let tab = 'dashboard';
    try { tab = sessionStorage.getItem('bettrakt:tab') || tab; } catch (e) { /* ignore */ }
    if (!state.settings.configured && !state.bets.length) tab = 'settings';
    showTab(tab);
    connectCloud();
  }

  init();
})();
