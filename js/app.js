/* Bet-Trakt UI. Depends on window.BetCalc (js/calc.js). */
(function () {
  'use strict';
  const C = window.BetCalc;
  const STORAGE_KEY = 'bettrakt:v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BOOKS = ['FanDuel', 'DraftKings', 'Sleeper', 'Chalkboard'];

  const DEFAULT_SETTINGS = {
    startingBankroll: 1000,
    unitPct: 2,
    unitBasis: 'current',
    kellyMultiplier: 0.25,
    maxUnits: 3,
    oddsFormat: 'american',
    configured: false,
    // Optional bet-form fields. Off by default: keep the form to what most people track.
    fields: { confidence: true, sport: false, selection: false, winProb: false, notes: false },
  };

  function normalizeSettings(s) {
    const out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    out.fields = Object.assign({}, DEFAULT_SETTINGS.fields, (s && s.fields) || {});
    return out;
  }

  let state = load();
  let breakdownKey = 'format';
  let betFormat = 'Single';
  let confidence = 2;
  let lastReco = null;

  /* ---------------- Storage ---------------- */

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        return {
          settings: normalizeSettings(data.settings),
          bets: Array.isArray(data.bets) ? data.bets : [],
        };
      }
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    return { settings: normalizeSettings(), bets: [] };
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
          settings: normalizeSettings(settingsSnap.exists ? settingsSnap.data() : {}),
          bets: cloudBets,
        };
        cloud.synced.settings = settingsSnap.exists ? JSON.stringify(state.settings) : null;
        cloudBets.forEach((b) => cloud.synced.bets.set(b.id, JSON.stringify(b)));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* cache only */ }
        applyFields();
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
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = true;
    void t.offsetWidth; // restart the entrance animation
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function currentBankroll() { return C.bankrollSeries(state.settings.startingBankroll, state.bets).current; }
  function currentUnit() { return C.unitSize(state.settings, currentBankroll()); }

  /* ---------------- Motion ---------------- */

  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const lastShown = new Map(); // data-key -> last number shown, so counters animate from there
  const FORMATTERS = {
    money: (v) => money(v),
    moneySigned: (v) => money(v, true),
    unitsSigned: (v) => units(v, true),
    pctSigned: (v) => pct(v, true),
    pct: (v) => pct(v, false),
  };

  /** Count numbers up/down to their new value: <span data-count="123.4" data-fmt="money" data-key="x">. */
  function animateNumbers(root) {
    $$('[data-count]', root).forEach((el) => {
      const to = Number(el.dataset.count);
      const fmt = FORMATTERS[el.dataset.fmt] || FORMATTERS.money;
      const key = el.dataset.key;
      const from = lastShown.has(key) ? lastShown.get(key) : 0;
      lastShown.set(key, to);
      if (reduceMotion() || from === to || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
      const t0 = performance.now(), dur = 700;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmt(from + (to - from) * e);
        if (k < 1) requestAnimationFrame(step);
      };
      el.textContent = fmt(from);
      requestAnimationFrame(step);
    });
  }

  /** A little burst of confetti from a point on screen, for wins. */
  function celebrate(x, y) {
    if (reduceMotion()) return;
    const colors = ['#12b76a', '#2f6bff', '#f5a524', '#34d399', '#5b8cff'];
    for (let i = 0; i < 22; i++) {
      const p = document.createElement('i');
      p.className = 'burst';
      const angle = (Math.PI * 2 * i) / 22 + Math.random() * 0.4;
      const dist = 50 + Math.random() * 70;
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist - 20 + 'px');
      p.style.setProperty('--rot', Math.round(Math.random() * 540 - 270) + 'deg');
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 900);
    }
  }

  function celebrateFrom(el) {
    const r = el.getBoundingClientRect();
    celebrate(r.left + r.width / 2, r.top + r.height / 2);
  }

  let chartAnim = true; // animate charts when the data changes, not on every resize

  /* ---------------- Device & display mode ---------------- */

  // device:  'phone' | 'desktop'  -> layout (bottom tab bar and bet cards on phones)
  // display: 'app'   | 'browser'  -> opened from the home screen / installed, or in a browser tab
  const env = { device: 'desktop', display: 'browser', ios: false, android: false };
  // The GitHub Pages build ships a web app manifest; the claude.ai artifact build does not.
  const isSite = !!document.querySelector('link[rel="manifest"]');
  const INSTALL_DISMISS_KEY = 'bettrakt:install-dismissed';
  let installPrompt = null;

  function detectEnv() {
    const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
    const ua = navigator.userAgent || '';
    env.ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    env.android = /Android/i.test(ua);
    const shortSide = Math.min(screen.width || Infinity, screen.height || Infinity);
    const touchPhone = mm('(pointer: coarse)') && shortSide < 600;
    env.device = touchPhone || mm('(max-width: 700px)') || /iPhone|iPod|Android.+Mobile/.test(ua) ? 'phone' : 'desktop';
    env.display = mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)') ||
      navigator.standalone === true ? 'app' : 'browser';
    document.documentElement.dataset.device = env.device;
    document.documentElement.dataset.display = env.display;
  }
  detectEnv();

  function installDismissed() {
    try { return localStorage.getItem(INSTALL_DISMISS_KEY) === '1'; } catch (e) { return false; }
  }

  function installSteps() {
    if (installPrompt) return 'It opens full screen like an app and works offline.';
    if (env.ios) return 'Tap the Share button, then "Add to Home Screen".';
    if (env.android) return 'Open your browser menu (⋮), then tap "Add to Home screen" or "Install app".';
    return '';
  }

  function renderDeviceInfo() {
    const phone = env.device === 'phone';
    const where = env.display === 'app'
      ? (phone ? 'opened from your home screen' : 'running as an installed app')
      : (isSite ? 'open in a browser tab' : 'open inside Claude');
    let text = (phone ? 'Phone' : 'Computer') + ', ' + where + '. ';
    if (env.display === 'app') {
      text += 'You are all set.';
      if (env.ios) text += ' Bets saved here are kept separately from Safari, so keep using the home-screen app.';
    } else if (isSite && phone) {
      text += 'Add it to your home screen to open it like an app. ' + installSteps();
    } else if (isSite && installPrompt) {
      text += 'You can install it as an app on this computer.';
    } else {
      text += phone ? 'Using the phone layout.' : 'Using the full layout.';
    }
    $('#device-info').textContent = text;
    $('#device-actions').hidden = !installPrompt;

    const banner = $('#install-banner');
    const steps = installSteps();
    banner.hidden = !(isSite && phone && env.display === 'browser' && steps && !installDismissed());
    $('#install-steps').textContent = steps;
    $('#install-btn').hidden = !installPrompt;
  }

  async function promptInstall() {
    if (!installPrompt) return;
    const p = installPrompt;
    installPrompt = null;
    try {
      p.prompt();
      const choice = await p.userChoice;
      if (choice && choice.outcome === 'accepted') toast('Installing Bet-Trakt.');
    } catch (e) { /* prompt can only be used once */ }
    renderDeviceInfo();
  }

  function wireInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // show our own Install button instead of the browser's mini-bar
      installPrompt = e;
      renderDeviceInfo();
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      toast('Bet-Trakt is on your home screen.');
      renderDeviceInfo();
    });
    $('#install-btn').addEventListener('click', promptInstall);
    $('#install-btn-2').addEventListener('click', promptInstall);
    $('#install-dismiss').addEventListener('click', () => {
      try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
      $('#install-banner').hidden = true;
    });
  }

  function registerServiceWorker() {
    if (!isSite || !('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    // Ask the browser not to clear saved bets under storage pressure (granted silently for installed apps).
    if (env.display === 'app' && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  /* ---------------- Tabs ---------------- */

  function showTab(name) {
    const changed = document.documentElement.dataset.tab !== name;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    document.documentElement.dataset.tab = name;
    try { sessionStorage.setItem('bettrakt:tab', name); } catch (e) { /* ignore */ }
    if (changed) window.scrollTo(0, 0);
    if (name === 'dashboard') { chartAnim = true; renderCharts(); }
  }

  /* ---------------- Dashboard ---------------- */

  function renderHeader() {
    const br = currentBankroll();
    $('#header-bankroll').innerHTML = 'Bankroll<strong data-count="' + br + '" data-fmt="money" data-key="hdr-br">' + money(br) + '</strong>1u = ' + money(currentUnit());
    animateNumbers($('#header-bankroll'));
  }

  function renderStats() {
    const s = C.summarize(state.bets);
    const series = C.bankrollSeries(state.settings.startingBankroll, state.bets);
    const start = Number(state.settings.startingBankroll) || 0;
    const change = start ? (series.current - start) / start : 0;
    const streak = s.currentStreak ? (s.currentStreak.type === 'won' ? 'W' : 'L') + s.currentStreak.length + ' streak' : 'No streak yet';
    const num = (v, fmt, key, cls) => '<span class="' + (cls || '') + '" data-count="' + v + '" data-fmt="' + fmt + '" data-key="' + key + '">' + FORMATTERS[fmt](v) + '</span>';
    const arrowUp = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const arrowDown = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const decided = s.wins + s.losses;
    const breakEven = s.graded && Number.isFinite(s.avgOdds) ? 1 / s.avgOdds : null;

    const hero =
      '<section class="hero" aria-label="Bankroll">' +
        '<div><div class="hero-label">Bankroll</div>' +
        '<div class="hero-value">' + num(series.current, 'money', 'hero-br') + '</div></div>' +
        '<div class="hero-row">' +
          '<span class="hero-chip">' + (series.current >= start ? arrowUp : arrowDown) + num(series.current - start, 'moneySigned', 'hero-chg') +
            (start ? ' (' + pct(change, true) + ')' : '') + '</span>' +
          '<span class="hero-chip">1u = ' + money(currentUnit()) + '</span>' +
          '<span class="hero-chip">Max drawdown ' + pct(series.maxDrawdownPct, false, 0) + '</span>' +
        '</div>' +
      '</section>';

    const tile = (o) =>
      '<div class="card stat ' + (o.tone || '') + '">' +
        '<div class="stat-head"><span class="stat-icon" aria-hidden="true">' + o.icon + '</span><span class="label">' + o.label + '</span></div>' +
        '<div class="value ' + (o.cls || '') + '">' + o.value + '</div>' +
        (o.extra || '') +
        '<div class="meta">' + o.meta + '</div>' +
      '</div>';
    const toneOf = (v) => (v > 0.004 ? 'tone-pos' : v < -0.004 ? 'tone-neg' : '');

    $('#stats').innerHTML = hero +
      tile({ label: 'Profit / loss', icon: '<svg viewBox="0 0 24 24"><path d="M4 17l6-6 4 4 6-7M15 8h5v5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>', tone: toneOf(s.profit), cls: tone(s.profit),
        value: num(s.profit, 'moneySigned', 'pl'), meta: num(s.units, 'unitsSigned', 'units') + ' · ' + money(s.staked) + ' staked' }) +
      tile({ label: 'ROI', icon: '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M8 8.5a1.5 1.5 0 1 0 0-.01M16 15.5a1.5 1.5 0 1 0 0-.01" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>', tone: toneOf(s.roi), cls: tone(s.roi),
        value: num(s.roi, 'pctSigned', 'roi'), meta: s.graded + ' graded bet' + (s.graded === 1 ? '' : 's') }) +
      tile({ label: 'Win rate', icon: '<svg viewBox="0 0 24 24"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>', tone: 'tone-gold',
        value: decided ? num(s.winRate, 'pct', 'wr') : '—',
        extra: '<div class="meter" title="Win rate' + (breakEven ? ' vs break-even ' + pct(breakEven, false) : '') + '"><i style="width:' + (decided ? (s.winRate * 100).toFixed(1) : 0) + '%"></i>' +
          (breakEven ? '<b style="left:' + (breakEven * 100).toFixed(1) + '%"></b>' : '') + '</div>',
        meta: s.wins + '-' + s.losses + (s.pushes ? '-' + s.pushes : '') + ' · ' + streak }) +
      tile({ label: 'Pending', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
        value: num(s.pendingStake, 'money', 'pend'), meta: s.pending + ' open bet' + (s.pending === 1 ? '' : 's') });
    animateNumbers($('#stats'));
  }

  function renderUnitPanel() {
    const st = state.settings;
    const br = currentBankroll();
    const unit = currentUnit();
    const rows = Object.keys(C.CONFIDENCE_UNITS).map((k) => {
      const u = Math.min(C.CONFIDENCE_UNITS[k], Number(st.maxUnits) || 3);
      return '<tr><td>' + k + ' <span class="stars">' + '★'.repeat(Number(k)) + '</span></td><td>' + units(u) + '</td><td>' + money(u * unit) + '</td></tr>';
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
      '<li class="' + m.level + '"><span class="badge ' + m.level + '">' + labels[m.level] + '</span><span>' + esc(m.text) + '</span></li>'
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
    if (chartAnim) root.classList.add('animate');
    const defs = svg('defs', {}, root);
    const lg = svg('linearGradient', { id: 'line-grad', x1: '0', y1: '0', x2: '1', y2: '0' }, defs);
    svg('stop', { offset: '0', style: 'stop-color: var(--accent)' }, lg);
    svg('stop', { offset: '1', style: 'stop-color: var(--accent-2)' }, lg);
    const ag = svg('linearGradient', { id: 'area-grad', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    svg('stop', { offset: '0', style: 'stop-color: var(--accent); stop-opacity: 0.32' }, ag);
    svg('stop', { offset: '1', style: 'stop-color: var(--accent); stop-opacity: 0' }, ag);
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
    const linePath = svg('path', { class: 'line', d: d }, root);

    // End-point direct label
    const last = pts[n];
    svg('circle', { class: 'dot dot-end', cx: sx(n), cy: sy(last.bankroll), r: 5 }, root);

    const cross = svg('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' }, root);
    const hoverDot = svg('circle', { class: 'dot', r: 5, visibility: 'hidden' }, root);
    const overlay = svg('rect', { x: m.l, y: 0, width: iw, height: height, fill: 'transparent' }, root);
    host.appendChild(root);

    try { linePath.style.setProperty('--len', Math.ceil(linePath.getTotalLength()) + 'px'); } catch (e) { root.classList.remove('animate'); }

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
    const graded = state.bets.filter(C.isGraded).map((b) => Object.assign({}, b, { format: C.betFormat(b) }));
    const groups = C.groupSummary(graded, breakdownKey);
    const MAX = 10;
    if (groups.length <= MAX) return groups;
    const keep = groups.slice(0, MAX - 1);
    const rest = groups.slice(MAX - 1);
    const restNames = new Set(rest.map((g) => g.name));
    const restBets = graded.filter((b) => restNames.has((b[breakdownKey] && String(b[breakdownKey]).trim()) || 'Other'));
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

    table.innerHTML = '<thead><tr><th>' + { sport: 'Sport', format: 'Format', book: 'Sportsbook' }[breakdownKey] +
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
    if (chartAnim) root.classList.add('animate');
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
        svg('path', { class: 'bar ' + (g.profit >= 0 ? 'bar-pos' : 'bar-neg'), d: path, style: 'animation-delay:' + i * 60 + 'ms' }, row);
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
    chartAnim = false;
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
    // Keep any book from older bets in the filter so those bets can still be found.
    const allBooks = BOOKS.concat(books.filter((x) => !BOOKS.includes(x)).sort());
    const bookSel = $('#filter-book');
    const curBook = bookSel.value;
    bookSel.innerHTML = '<option value="">All books</option>' + allBooks.map((s) => '<option>' + esc(s) + '</option>').join('');
    bookSel.value = allBooks.includes(curBook) ? curBook : '';
  }

  /** Fill the form's book dropdown; `extra` keeps an older bet's book selectable while editing it. */
  function setBookOptions(extra) {
    const list = extra && !BOOKS.includes(extra) ? BOOKS.concat([extra]) : BOOKS;
    form.book.innerHTML = '<option value="">Choose a book</option>' + list.map((s) => '<option>' + esc(s) + '</option>').join('');
  }

  function filteredBets() {
    const q = $('#filter-text').value.trim().toLowerCase();
    const status = $('#filter-status').value;
    const sport = $('#filter-sport').value;
    const fmtFilter = $('#filter-format').value;
    const book = $('#filter-book').value;
    return state.bets.filter((b) => {
      if (status && b.status !== status) return false;
      if (sport && (b.sport || '').trim() !== sport) return false;
      if (fmtFilter && C.betFormat(b) !== fmtFilter) return false;
      if (book && (b.book || '').trim() !== book) return false;
      if (q && ![b.event, b.selection, b.notes, b.sport, b.book, C.betFormat(b)].join(' ').toLowerCase().includes(q)) return false;
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
    const cards = $('#bets-list');
    const empty = !state.bets.length ? 'No bets yet. Add your first bet above.' : !list.length ? 'No bets match these filters.' : '';
    if (empty) {
      table.innerHTML = env.device === 'phone' ? '' : '<tbody><tr><td class="empty">' + empty + '</td></tr></tbody>';
      cards.innerHTML = env.device === 'phone' ? '<div class="empty">' + empty + '</div>' : '';
      return;
    }
    const fmt = state.settings.oddsFormat;
    const settleButtons = (b) => b.status === 'pending'
      ? '<button class="btn small" data-act="won" data-id="' + b.id + '" title="Mark won">W</button>' +
        '<button class="btn small" data-act="lost" data-id="' + b.id + '" title="Mark lost">L</button>' +
        '<button class="btn small" data-act="push" data-id="' + b.id + '" title="Mark push">P</button>'
      : '';
    const editButtons = (b) => '<button class="btn small" data-act="edit" data-id="' + b.id + '">Edit</button>' +
      '<button class="btn small danger" data-act="delete" data-id="' + b.id + '" aria-label="Delete bet">✕</button>';
    const plText = (b) => b.status === 'pending'
      ? '<span style="color:var(--muted)">to win ' + money(Number(b.stake) * (Number(b.odds) - 1)) + '</span>'
      : money(C.betProfit(b), true);
    const formatTag = (b) => {
      const f = C.betFormat(b);
      return '<span class="format-tag' + (f === 'Parlay' ? ' parlay' : '') + '">' + (f === 'Parlay' && b.legs ? b.legs + '-leg parlay' : f) + '</span>';
    };
    const statusPill = (b) => '<span class="status ' + b.status + '">' + (b.status === 'cashout' ? 'Cashed out' : b.status) + '</span>';

    if (env.device === 'phone') {
      // Phone: one card per bet instead of a wide table.
      table.innerHTML = '';
      cards.innerHTML = list.map((b) => {
        const meta = [fmtDate(b.date), b.book, b.sport, C.formatOdds(Number(b.odds), fmt)].filter(Boolean).map(esc).join(' · ');
        return '<article class="bet-card ' + b.status + '">' +
          '<div class="bc-top"><div class="bc-event">' + esc(b.event) +
            (b.selection ? '<div class="sel">' + esc(b.selection) + '</div>' : '') +
          '</div><div class="bc-pl ' + tone(C.betProfit(b)) + '">' + plText(b) + '</div></div>' +
          '<div class="bc-meta">' + meta + '</div>' +
          '<div class="bc-foot">' + statusPill(b) + formatTag(b) + '<span class="bc-stake">' + money(Number(b.stake)) + ' · ' + units(Number(b.units)) + '</span>' +
            '<div class="row-actions">' + settleButtons(b) + editButtons(b) + '</div></div>' +
        '</article>';
      }).join('');
      return;
    }
    cards.innerHTML = '';
    table.innerHTML =
      '<thead><tr><th>Date</th><th>Bet</th><th>Format</th><th>Book</th><th class="num">Odds</th><th class="num">Stake</th><th>Result</th><th class="num">P/L</th><th class="num"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>' +
      list.map((b) => {
        const pl = C.betProfit(b);
        return '<tr>' +
          '<td>' + esc(fmtDate(b.date)) + '</td>' +
          '<td class="event">' + esc(b.event) + ([b.selection, b.sport].filter(Boolean).length ? '<div class="sel">' + esc([b.selection, b.sport].filter(Boolean).join(' · ')) + '</div>' : '') + '</td>' +
          '<td>' + formatTag(b) + '</td>' +
          '<td>' + (b.book ? esc(b.book) : '<span style="color:var(--muted)">—</span>') + '</td>' +
          '<td class="num">' + C.formatOdds(Number(b.odds), fmt) + '</td>' +
          '<td class="num">' + money(Number(b.stake)) + '<div class="sel" style="color:var(--muted);font-size:12px">' + units(Number(b.units)) + '</div></td>' +
          '<td>' + statusPill(b) + '</td>' +
          '<td class="num ' + tone(pl) + '">' + plText(b) + '</td>' +
          '<td><div class="row-actions">' + settleButtons(b) + editButtons(b) + '</div></td></tr>';
      }).join('') + '</tbody>';
  }

  /* ---------------- Bet form ---------------- */

  const form = $('#bet-form');

  // Sign for American odds, set by the minus / plus buttons. The input itself holds just the number.
  let oddsSign = '-';

  function setOddsSign(sign) {
    oddsSign = sign === '+' ? '+' : '-';
    $$('#odds-sign button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sign === oddsSign)));
  }

  /** Put odds text in the field, moving any leading sign onto the minus / plus buttons. */
  function setOddsValue(text) {
    const v = String(text || '').trim().replace(/^[−–]/, '-');
    const m = v.match(/^([+-])\s*(.*)$/);
    if (m && state.settings.oddsFormat !== 'decimal') {
      setOddsSign(m[1]);
      form.odds.value = m[2];
    } else {
      form.odds.value = v;
    }
  }

  function oddsText() {
    const v = form.odds.value.trim();
    if (state.settings.oddsFormat === 'decimal' || !v) return v;
    return oddsSign + v.replace(/^[+-]/, '');
  }

  function oddsFromForm() {
    return C.parseOdds(oddsText(), state.settings.oddsFormat);
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
    form.odds.placeholder = fmt === 'decimal' ? '1.91' : '110';
    $('#odds-sign').hidden = fmt === 'decimal';
    $('#odds-hint').textContent = Number.isFinite(odds)
      ? (fmt === 'decimal'
        ? C.formatOdds(odds, 'american') + ' · break-even ' + pct(C.impliedProbability(odds), false)
        : C.formatOdds(odds, 'american') + ' · ' + (oddsSign === '-' ? 'favorite' : 'underdog') + ' · break-even ' + pct(C.impliedProbability(odds), false))
      : form.odds.value ? (fmt === 'decimal' ? 'Enter decimal odds above 1.00' : 'Enter 100 or more, like 110 or 150') : ' ';
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
      winProb: state.settings.fields.winProb ? wp : null,
      confidence: state.settings.fields.confidence ? confidence : 2,
      kellyMultiplier: state.settings.kellyMultiplier,
      maxUnits: state.settings.maxUnits,
    });
    if (r.method === 'confidence' && !state.settings.fields.confidence) {
      r.reasons = ['Your standard 1-unit stake. Turn on Confidence in Settings to size bets up or down.'];
    }
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

  function setFormat(f) {
    betFormat = f === 'Parlay' ? 'Parlay' : 'Single';
    $$('#format button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === betFormat)));
    $('#legs-field').hidden = betFormat !== 'Parlay';
  }

  /** Show or hide the optional bet-form fields (and the filters/breakdowns tied to them). */
  function applyFields() {
    const f = state.settings.fields;
    $$('[data-field]').forEach((el) => { el.hidden = !f[el.dataset.field]; });
    $$('#field-toggles [data-toggle]').forEach((cb) => { cb.checked = !!f[cb.dataset.toggle]; });
    if (!f.sport && breakdownKey === 'sport') {
      breakdownKey = 'format';
      $$('#breakdown-key button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.key === 'format')));
    }
    if (!f.sport) $('#filter-sport').value = '';
    $('#form-sub').textContent = f.confidence || f.winProb
      ? 'Pick single or parlay, enter the odds, and get a recommended stake.'
      : 'Pick single or parlay, enter the odds and stake, and mark the result.';
  }

  function setConfidence(v) {
    confidence = v;
    $$('#confidence button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v)));
  }

  function resetForm() {
    setBookOptions();
    form.reset();
    setOddsSign('-');
    setFormat('Single');
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
    setFormat(C.betFormat(b));
    form.legs.value = b.legs || '';
    setBookOptions(b.book);
    form.book.value = b.book || '';
    form.event.value = b.event || '';
    form.selection.value = b.selection || '';
    setOddsValue(C.formatOdds(Number(b.odds), state.settings.oddsFormat));
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
      toast(state.settings.oddsFormat === 'decimal' ? 'Enter decimal odds above 1.00, like 1.91.' : 'Tap − or +, then enter the odds, like 110 or 150.', 'error');
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
    const legs = betFormat === 'Parlay' && Number(form.legs.value) >= 2 ? Math.round(Number(form.legs.value)) : null;
    const label = form.event.value.trim() ||
      (betFormat === 'Parlay' ? (legs ? legs + '-leg parlay' : 'Parlay') : (form.selection.value.trim() || 'Single bet'));
    const bet = {
      id: existing ? existing.id : uid(),
      createdAt: existing ? existing.createdAt : Date.now(),
      date: form.date.value || today(),
      sport: form.sport.value.trim(),
      type: existing ? existing.type || '' : '',
      format: betFormat,
      legs,
      book: form.book.value.trim(),
      event: label,
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
    toast(existing ? 'Bet updated.' : 'Bet added: ' + units(bet.units) + ' on ' + (bet.selection || bet.event) + '.', bet.status === 'won' ? 'win' : '');
    if (bet.status === 'won') celebrateFrom($('#save-btn'));
    resetForm();
    if (BOOKS.includes(bet.book)) form.book.value = bet.book; // most people log several bets at one book
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
          state = { settings: normalizeSettings(data.settings), bets };
          save();
          applyFields();
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

  /* ---------------- Quick add: typed text or a bet-slip screenshot ---------------- */

  // Claude reads text and screenshots when the page runs as a claude.ai artifact
  // (the `sample` capability). Elsewhere, typed text is read by js/parse.js and
  // screenshots by on-device OCR (Tesseract.js, downloaded on first use).
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let drafts = [];
  let claudeSample;      // undefined: not checked yet; null: not available
  let claudeImages = false;

  async function getClaude() {
    if (claudeSample !== undefined) return claudeSample;
    claudeSample = null;
    const api = window.claude && typeof window.claude.use === 'function' ? window.claude : null;
    if (!api) return null;
    try {
      const s = await api.use('sample');
      if (s) {
        claudeSample = s;
        const lim = await s.limits().catch(() => null);
        claudeImages = !!(lim && lim.images);
      }
    } catch (e) { claudeSample = null; }
    return claudeSample;
  }

  function qaStatus(msg, busy) {
    const el = $('#qa-status');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('busy', !!busy);
    $('#qa-read').disabled = !!busy;
  }

  function claudePrompt(text, withImage) {
    return [
      'You read sports bets and return them as JSON for a personal bet tracker.',
      "Today's date is " + today() + '. The user bets at FanDuel, DraftKings, Sleeper and Chalkboard.',
      withImage
        ? 'The attached image is a screenshot from a sportsbook app: a bet slip, or a list of placed or settled bets.'
        : 'The text below is how the user describes one or more bets.',
      'Find every separate bet. A parlay is ONE bet with several legs. Do not invent bets or numbers.',
      'Return ONLY a JSON array. Each item:',
      '{"format":"Single"|"Parlay","legs":number|null,"description":string,"book":"FanDuel"|"DraftKings"|"Sleeper"|"Chalkboard"|null,' +
        '"american_odds":number|null,"stake":number|null,"units":number|null,"to_win":number|null,' +
        '"status":"pending"|"won"|"lost"|"push"|"void"|"cashout","cashout":number|null,"date":"YYYY-MM-DD"|null}',
      'Rules: description is short, like "Chiefs ML" or "Chiefs / Bills / Lions" (team or player names, no odds).',
      'american_odds is the price of the whole bet (for a parlay, the combined parlay odds), negative for favorites.',
      'stake is the dollar amount risked. If the stake is given in units (like "2u"), put that number in units and leave stake null.',
      'to_win is the profit, not including the stake; if only a total payout is shown, subtract the stake.',
      'status is "pending" unless the bet is clearly settled. cashout is the amount received for a cashed-out bet.',
      'Use null for anything not shown.',
      text ? 'User text (between the --- lines):\n---\n' + text.slice(0, 4000) + '\n---' : '',
    ].filter(Boolean).join('\n');
  }

  /** Claude's answer is data from outside the page: keep only well-formed values. */
  function draftsFromClaude(out) {
    const list = Array.isArray(out) ? out : out && Array.isArray(out.bets) ? out.bets : out ? [out] : [];
    return list.filter((x) => x && typeof x === 'object').slice(0, 25).map((x) => {
      const am = Number(x.american_odds);
      let odds = Math.abs(am) >= 100 ? C.americanToDecimal(am) : NaN;
      const stake = Number(x.stake) > 0 ? C.round(Number(x.stake), 2) : null;
      const toWin = Number(x.to_win) > 0 ? Number(x.to_win) : null;
      if (stake && toWin) odds = 1 + toWin / stake;
      const status = C.STATUSES.includes(x.status) ? x.status : 'pending';
      const format = x.format === 'Parlay' ? 'Parlay' : 'Single';
      const unitsGiven = !stake && Number(x.units) > 0 ? Number(x.units) : null;
      const warnings = [];
      if (!(odds > 1)) warnings.push('Odds not found.');
      if (!stake && !unitsGiven) warnings.push('Stake not found.');
      return {
        format,
        legs: format === 'Parlay' && Number(x.legs) >= 2 ? Math.round(Number(x.legs)) : null,
        event: String(x.description || '').slice(0, 80),
        book: BOOKS.includes(x.book) ? x.book : null,
        odds: odds > 1 ? C.round(odds, 4) : null,
        stake,
        units: unitsGiven,
        status,
        cashout: status === 'cashout' && Number(x.cashout) >= 0 ? Number(x.cashout) : null,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? x.date : null,
        warnings,
      };
    });
  }

  function claudeError(e) {
    const code = e && e.code;
    if (code === 'not_granted') return 'Claude access is turned off for this page.';
    if (code === 'rate_limited') return 'Claude is busy or you have hit a usage limit. Try again in a bit.';
    if (code === 'image_rejected') return 'That image type could not be read. Try a PNG or JPG screenshot.';
    if (code === 'invalid_json' || code === 'empty_completion') return 'Claude could not find a bet in that.';
    return 'Claude could not read that right now.';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(el);
    });
  }

  /** Grayscale, upscale small images, and flip dark-mode screenshots to dark-on-light for OCR. */
  async function prepImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(3, Math.max(1, 1400 / bmp.width));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const dark = sum / (d.length / 4) < 128;
    for (let i = 0; i < d.length; i += 4) {
      let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (dark) y = 255 - y;
      y = Math.max(0, Math.min(255, (y - 128) * 1.5 + 128));
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  async function ocrImage(file, onProgress) {
    await loadScript(TESSERACT_URL);
    const canvas = await prepImage(file);
    const worker = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress || 0); },
    });
    try {
      const { data } = await worker.recognize(canvas);
      return data.text || '';
    } finally {
      worker.terminate();
    }
  }

  async function readQuickText() {
    const text = $('#qa-text').value.trim();
    if (!text) {
      toast('Type a bet first, like "$25 on Chiefs -110 at FanDuel".', 'error');
      $('#qa-text').focus();
      return;
    }
    const sample = await getClaude();
    if (sample) {
      qaStatus('Claude is reading your bets…', true);
      try {
        const out = await sample.json(claudePrompt(text, false), { modelTier: 'quick' });
        setDrafts(draftsFromClaude(out));
        qaStatus(drafts.length ? '' : 'Claude did not find a bet in that. Try adding the odds and the amount.');
        return;
      } catch (e) {
        qaStatus(claudeError(e) + ' Read it on this device instead.');
      }
    } else {
      qaStatus('');
    }
    setDrafts(BetParse.parseBets(text, { today: today() }));
  }

  async function readScreenshot(file) {
    $('#qa-paste').hidden = true;
    if (!file || !/^image\//.test(file.type || '')) {
      toast('That file is not an image. Add a screenshot (PNG or JPG).', 'error');
      return;
    }
    const sample = await getClaude();
    if (sample && claudeImages) {
      qaStatus('Claude is reading your screenshot…', true);
      try {
        const out = await sample.json(claudePrompt($('#qa-text').value.trim(), true), { images: [file] });
        setDrafts(draftsFromClaude(out));
        qaStatus(drafts.length ? '' : 'Claude did not find a bet in that screenshot.');
      } catch (e) {
        qaStatus(claudeError(e) + ' You can type the bet instead.');
      }
      return;
    }
    if (!isSite) {
      qaStatus('Reading screenshots is not available here. Type the bet instead.');
      return;
    }
    try {
      qaStatus('Reading your screenshot on this device…', true);
      const text = await ocrImage(file, (p) => qaStatus('Reading your screenshot on this device… ' + Math.round(p * 100) + '%', true));
      $('#qa-text').value = text.replace(/\n{3,}/g, '\n\n').trim();
      setDrafts(BetParse.parseSlip(text, { today: today() }));
      qaStatus(drafts.length
        ? 'Read on this device. Check each bet below. The text it read is in the box above if you want to fix it and tap Read bets.'
        : 'No bet found in that screenshot. Try a closer crop of the bet slip, or type it.');
    } catch (e) {
      qaStatus('Could not read the screenshot. The reader downloads the first time you use it, so check your connection, or type the bet instead.');
    }
  }

  function defaultBook() {
    if (form.book.value) return form.book.value;
    const last = state.bets.slice().sort(C.byDate).pop();
    return last && last.book ? last.book : '';
  }

  function setDrafts(list) {
    drafts = list.map((d) => Object.assign({ id: uid() }, d, { book: d.book || defaultBook() }));
    renderDrafts();
  }

  function draftStake(d) {
    if (d.stake > 0) return d.stake;
    if (d.units > 0) return C.round(d.units * currentUnit(), 2);
    return null;
  }

  function draftCard(d, i) {
    const decimal = state.settings.oddsFormat === 'decimal';
    const am = d.odds > 1 ? C.decimalToAmerican(d.odds) : null;
    const sign = am != null && am > 0 ? '+' : '-';
    const stake = draftStake(d);
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    const books = ['', ...BOOKS].map((b) => opt(b, b || 'Choose a book', d.book || '')).join('');
    const statuses = [['pending', 'Pending'], ['won', 'Won'], ['lost', 'Lost'], ['push', 'Push'], ['void', 'Void'], ['cashout', 'Cashed out']]
      .map(([v, l]) => opt(v, l, d.status)).join('');
    const oddsField = decimal
      ? '<input type="text" inputmode="decimal" data-k="oddsDec" value="' + (d.odds > 1 ? d.odds.toFixed(2) : '') + '" placeholder="1.91" aria-label="Odds">'
      : '<div class="draft-odds"><select data-k="sign" aria-label="Odds sign">' + opt('-', '−', sign) + opt('+', '+', sign) + '</select>' +
        '<input type="text" inputmode="decimal" data-k="oddsAbs" value="' + (am != null ? Math.abs(am) : '') + '" placeholder="110" aria-label="Odds"></div>';
    return '<div class="draft ' + d.status + '" data-id="' + d.id + '">' +
      '<div class="draft-top"><strong>Bet ' + (i + 1) + '</strong>' +
        '<button type="button" class="btn small danger" data-draft-remove="' + d.id + '" aria-label="Remove this bet">✕</button></div>' +
      '<div class="draft-grid">' +
        '<div class="field wide"><label>Bet</label><input type="text" data-k="event" value="' + esc(d.event) + '" placeholder="' + (d.format === 'Parlay' ? 'Parlay' : 'Single bet') + '"></div>' +
        '<div class="field"><label>Format</label><select data-k="format">' + opt('Single', 'Single', d.format) + opt('Parlay', 'Parlay', d.format) + '</select></div>' +
        (d.format === 'Parlay' ? '<div class="field"><label>Legs</label><input type="number" inputmode="numeric" min="2" data-k="legs" value="' + (d.legs || '') + '" placeholder="e.g. 3"></div>' : '') +
        '<div class="field"><label>Sportsbook</label><select data-k="book">' + books + '</select></div>' +
        '<div class="field' + (d.odds > 1 ? '' : ' bad') + '"><label>Odds</label>' + oddsField + '</div>' +
        '<div class="field' + (stake > 0 ? '' : ' bad') + '"><label>Stake ($)</label><input type="number" inputmode="decimal" min="0" step="0.01" data-k="stake" value="' + (stake > 0 ? stake.toFixed(2) : '') + '"></div>' +
        '<div class="field"><label>Result</label><select data-k="status">' + statuses + '</select></div>' +
        (d.status === 'cashout' ? '<div class="field' + (d.cashout >= 0 && d.cashout !== null ? '' : ' bad') + '"><label>Cash-out ($)</label><input type="number" inputmode="decimal" min="0" step="0.01" data-k="cashout" value="' + (d.cashout != null ? d.cashout : '') + '"></div>' : '') +
        '<div class="field"><label>Date</label><input type="date" data-k="date" value="' + esc(d.date || today()) + '"></div>' +
      '</div>' +
      (d.units > 0 && !(d.stake > 0) ? '<div class="draft-note">' + units(d.units) + ' at today\'s unit of ' + money(currentUnit()) + '.</div>' : '') +
      (d.warnings && d.warnings.length ? '<div class="draft-warn">' + d.warnings.map(esc).join(' ') + '</div>' : '') +
    '</div>';
  }

  function renderDrafts() {
    const host = $('#qa-drafts');
    if (!drafts.length) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="drafts-title">Found ' + drafts.length + ' bet' + (drafts.length === 1 ? '' : 's') + '. Check the details, then add.</div>' +
      drafts.map(draftCard).join('') +
      '<div class="actions"><button type="button" class="btn primary" id="qa-add">Add ' + (drafts.length === 1 ? 'bet' : drafts.length + ' bets') + '</button>' +
      '<button type="button" class="btn" id="qa-clear">Clear</button></div>';
  }

  /** Copy an edited draft field back into its draft. */
  function onDraftInput(e) {
    const el = e.target;
    const card = el.closest('.draft');
    if (!card || !el.dataset.k) return;
    const d = drafts.find((x) => x.id === card.dataset.id);
    if (!d) return;
    const k = el.dataset.k;
    const v = el.value.trim();
    if (k === 'sign' || k === 'oddsAbs') {
      const sign = card.querySelector('[data-k="sign"]').value;
      const abs = card.querySelector('[data-k="oddsAbs"]').value.trim().replace(/^[+\-−]/, '');
      const dec = C.parseOdds(sign + abs, 'american');
      d.odds = dec > 1 ? dec : null;
    } else if (k === 'oddsDec') {
      const dec = C.parseOdds(v, 'decimal');
      d.odds = dec > 1 ? dec : null;
    } else if (k === 'stake') {
      d.stake = Number(v) > 0 ? Number(v) : null;
      d.units = null;
    } else if (k === 'legs') {
      d.legs = Number(v) >= 2 ? Math.round(Number(v)) : null;
    } else if (k === 'cashout') {
      d.cashout = v === '' ? null : Number(v);
    } else {
      d[k] = v;
    }
    const field = el.closest('.field');
    if (field && (k === 'oddsAbs' || k === 'sign' || k === 'oddsDec')) field.classList.toggle('bad', !(d.odds > 1));
    if (field && k === 'stake') field.classList.toggle('bad', !(d.stake > 0));
    if (field && k === 'cashout') field.classList.toggle('bad', !(d.cashout >= 0 && d.cashout !== null));
    // Fields that change the card's layout re-render it
    if (e.type === 'change' && (k === 'format' || k === 'status')) renderDrafts();
  }

  function addDrafts() {
    const unit = currentUnit();
    const btnRect = $('#qa-add').getBoundingClientRect();
    const keep = [];
    let added = 0, wins = 0;
    for (const d of drafts) {
      const stake = draftStake(d);
      const cashoutOk = d.status !== 'cashout' || (d.cashout !== null && d.cashout >= 0);
      if (!(d.odds > 1) || !(stake > 0) || !cashoutOk) { keep.push(d); continue; }
      const legs = d.format === 'Parlay' && d.legs >= 2 ? d.legs : null;
      state.bets.push({
        id: uid(),
        createdAt: Date.now() + added,
        date: d.date || today(),
        sport: '',
        type: '',
        format: d.format === 'Parlay' ? 'Parlay' : 'Single',
        legs,
        book: d.book || '',
        event: d.event || (d.format === 'Parlay' ? (legs ? legs + '-leg parlay' : 'Parlay') : 'Single bet'),
        selection: '',
        odds: d.odds,
        stake: C.round(stake, 2),
        units: unit > 0 ? C.round(stake / unit, 4) : 0,
        status: d.status,
        cashout: d.status === 'cashout' ? Number(d.cashout) : null,
        confidence: null,
        winProb: null,
        notes: '',
      });
      added++;
      if (d.status === 'won') wins++;
    }
    drafts = keep;
    if (added) {
      save();
      renderAll();
      toast('Added ' + added + ' bet' + (added === 1 ? '' : 's') + '.', wins ? 'win' : '');
      if (wins) celebrate(btnRect.left + btnRect.width / 2, btnRect.top + btnRect.height / 2);
    }
    if (keep.length) {
      renderDrafts();
      if (!added) toast('Fill in the highlighted odds or stake first.', 'error');
      qaStatus(keep.length + ' bet' + (keep.length === 1 ? ' needs' : 's need') + ' odds or a stake before it can be added.');
    } else {
      $('#qa-text').value = '';
      renderDrafts();
      qaStatus('');
    }
  }

  async function describeQuickAdd() {
    const sample = await getClaude();
    const sub = $('#qa-sub');
    if (sample) {
      sub.textContent = claudeImages
        ? "Type your bets the way you'd say them, or add a screenshot of your bet slip. Claude reads them, and you check each one before it's saved."
        : "Type your bets the way you'd say them. Claude reads them, and you check each one before it's saved.";
      $('#qa-shot').hidden = !claudeImages;
      $('#qa-paste-btn').hidden = !claudeImages;
    } else if (!isSite) {
      sub.textContent = "Type your bets the way you'd say them, and check each one before it's saved.";
      $('#qa-shot').hidden = true;
      $('#qa-paste-btn').hidden = true;
    }
  }

  /** The first image in a paste or drop, from either .files or .items (browsers differ). */
  function imageFromTransfer(dt) {
    if (!dt) return null;
    const f = Array.from(dt.files || []).find((x) => /^image\//.test(x.type));
    if (f) return f;
    const it = Array.from(dt.items || []).find((x) => x.kind === 'file' && /^image\//.test(x.type));
    return it ? it.getAsFile() : null;
  }

  /** Turn an <img> the browser pasted inline into an image Blob (via canvas, which works for data: and blob: URLs). */
  function blobFromImg(img) {
    return new Promise((resolve) => {
      const done = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          if (!c.width || !c.height) return resolve(null);
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob((b) => resolve(b), 'image/png');
        } catch (e) { resolve(null); }
      };
      if (img.complete && img.naturalWidth) done();
      else { img.onload = done; img.onerror = () => resolve(null); }
    });
  }

  function showPasteZone() {
    const zone = $('#qa-paste');
    zone.hidden = false;
    zone.focus({ preventScroll: true });
    zone.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    qaStatus(env.device === 'phone'
      ? 'Long-press the blue box and tap Paste. (Copy the screenshot first: open it, tap Share, then Copy.)'
      : 'Press ' + (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl') + '+V to paste your screenshot.');
  }

  /** "Paste screenshot" button: read the clipboard directly where allowed, else show the paste box. */
  async function pasteScreenshot() {
    if (isSite && navigator.clipboard && navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find((t) => /^image\//.test(t));
          if (type) { $('#qa-paste').hidden = true; return readScreenshot(await it.getType(type)); }
        }
        const txt = items.find((it) => it.types.includes('text/plain'));
        if (txt) {
          const text = (await (await txt.getType('text/plain')).text()).trim();
          if (text) { $('#qa-text').value = text; return readQuickText(); }
        }
        toast('There is no screenshot on your clipboard. Copy one first, then tap Paste screenshot.', 'error');
        return;
      } catch (e) {
        // Not allowed or not supported here: fall back to a normal paste
      }
    }
    showPasteZone();
  }

  function wireQuickAdd() {
    $('#qa-read').addEventListener('click', readQuickText);
    $('#qa-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); readQuickText(); }
    });
    $('#qa-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) readScreenshot(f);
    });
    // Paste a screenshot: into the box, the paste area, or anywhere on the Bets tab
    document.addEventListener('paste', (e) => {
      if ($('#view-bets').hidden) return;
      const img = imageFromTransfer(e.clipboardData);
      if (!img) return;
      e.preventDefault();
      $('#qa-paste').hidden = true;
      readScreenshot(img);
    });
    $('#qa-paste-btn').addEventListener('click', pasteScreenshot);
    // Some phones paste the picture into the box as an <img> instead of handing it over
    const zone = $('#qa-paste');
    zone.addEventListener('input', async () => {
      const img = zone.querySelector('img');
      if (!img) { if (zone.textContent.trim()) { $('#qa-text').value = zone.textContent.trim(); zone.textContent = ''; zone.hidden = true; readQuickText(); } return; }
      const blob = await blobFromImg(img);
      zone.innerHTML = '';
      zone.hidden = true;
      if (blob) readScreenshot(blob);
      else qaStatus('Could not use that pasted image. Try Add screenshot instead.');
    });
    // Or drop one onto the card
    const card = $('#quick-add');
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragging'); });
    card.addEventListener('dragleave', () => card.classList.remove('dragging'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readScreenshot(f);
    });
    const host = $('#qa-drafts');
    host.addEventListener('input', onDraftInput);
    host.addEventListener('change', onDraftInput);
    host.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-draft-remove]');
      if (rm) { drafts = drafts.filter((d) => d.id !== rm.dataset.draftRemove); renderDrafts(); return; }
      if (e.target.closest('#qa-add')) addDrafts();
      if (e.target.closest('#qa-clear')) { drafts = []; renderDrafts(); qaStatus(''); }
    });
    describeQuickAdd();
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
    chartAnim = true;
    renderCharts();
  }

  function init() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    $$('#breakdown-key button').forEach((b) => b.addEventListener('click', () => {
      breakdownKey = b.dataset.key;
      $$('#breakdown-key button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      chartAnim = true;
      renderBreakdown();
      chartAnim = false;
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
    $$('#format button').forEach((b) => b.addEventListener('click', () => {
      setFormat(b.dataset.format);
      if (betFormat === 'Parlay') form.legs.focus({ preventScroll: true });
    }));
    $$('#field-toggles [data-toggle]').forEach((cb) => cb.addEventListener('change', () => {
      state.settings.fields[cb.dataset.toggle] = cb.checked;
      save();
      applyFields();
      renderAll();
      updateFormHints();
      toast((cb.checked ? 'Showing ' : 'Hiding ') + cb.closest('.toggle').querySelector('strong').textContent.toLowerCase() + '.');
    }));
    $$('#odds-sign button').forEach((b) => b.addEventListener('click', () => {
      setOddsSign(b.dataset.sign);
      updateFormHints();
    }));
    // A typed or pasted sign moves onto the buttons, so the field only holds the number.
    form.odds.addEventListener('input', () => {
      if (/^[+\-−–]/.test(form.odds.value) && state.settings.oddsFormat !== 'decimal') {
        setOddsValue(form.odds.value);
        updateFormHints();
      }
    });
    $('#fab-add').addEventListener('click', () => {
      showTab('bets');
      $('#quick-add').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
      setTimeout(() => $('#qa-text').focus({ preventScroll: true }), 350);
    });
    wireQuickAdd();
    $('#reco').addEventListener('click', (e) => { if (e.target.closest('[data-use-reco]')) useReco(); });

    const onBetAction = (e) => {
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
        toast('Marked ' + act + ': ' + money(C.betProfit(bet), true) + '.', act === 'won' ? 'win' : act === 'lost' ? 'loss' : '');
        if (act === 'won') celebrateFrom(btn);
      }
      save();
      renderAll();
    };
    $('#bets-table').addEventListener('click', onBetAction);
    $('#bets-list').addEventListener('click', onBetAction);

    ['#filter-text', '#filter-status', '#filter-sport', '#filter-book', '#filter-format'].forEach((s) => $(s).addEventListener('input', renderBetsTable));

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
      resizeTimer = setTimeout(() => {
        const before = env.device + env.display;
        detectEnv();
        if (env.device + env.display !== before) { renderBetsTable(); renderDeviceInfo(); }
        renderCharts();
      }, 120);
    });
    ['(display-mode: standalone)', '(display-mode: fullscreen)'].forEach((q) => {
      const mq = window.matchMedia && window.matchMedia(q);
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { detectEnv(); renderDeviceInfo(); });
    });
    wireInstall();

    applyFields();
    fillSettings();
    resetForm();
    renderAll();
    renderStorageNote();
    renderDeviceInfo();
    registerServiceWorker();
    let tab = 'dashboard';
    try { tab = sessionStorage.getItem('bettrakt:tab') || tab; } catch (e) { /* ignore */ }
    if (!state.settings.configured && !state.bets.length) tab = 'settings';
    showTab(tab);
    connectCloud();
  }

  init();
})();
