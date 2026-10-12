/* Claudia Boxtimer – einfache Rundenuhr, läuft komplett lokal im Browser. */
(() => {
  'use strict';

  const VERSION = '1.2.0';

  // ------------------------------------------------------------------
  // Speicher (nur lokal auf dem Gerät)
  // ------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* privater Modus o. Ä. */ }
    },
  };

  const DEFAULT_PROFILES = [
    { id: 'p-amateur', name: 'Boxen',    mode: 'equal',   rounds: 3, round: 180, rest: 60, prep: 10, warn: 5 },
    { id: 'p-sparring',name: 'Sparring', mode: 'equal',   rounds: 6, round: 120, rest: 60, prep: 10, warn: 5 },
    { id: 'p-bag',     name: 'Sandsack', mode: 'pyramid', rounds: 9, round: 180, rest: 30, prep: 10, warn: 5,
      pyrStart: 60, pyrStep: 30, pyrPeak: 180 },
    { id: 'p-tabata',  name: 'HIIT',     mode: 'equal',   rounds: 8, round: 20,  rest: 10, prep: 10, warn: 5 },
  ];
  const DEFAULT_SETTINGS = { volume: 90, wakeLock: true, endGong: true };
  const PROFILE_SCHEMA = 2;

  let profiles = store.get('bt.profiles', null);
  if (!Array.isArray(profiles) || profiles.length === 0) {
    profiles = DEFAULT_PROFILES.map(p => ({ ...p }));
  } else if (store.get('bt.schema', 1) < PROFILE_SCHEMA) {
    // Standardprofile auf die neue Auswahl umstellen, eigene Profile bleiben erhalten
    const removed = ['p-pro', 'p-mma', 'p-muaythai'];
    const defaultIds = DEFAULT_PROFILES.map(p => p.id);
    const custom = profiles.filter(p => !defaultIds.includes(p.id) && !removed.includes(p.id));
    profiles = [...DEFAULT_PROFILES.map(p => ({ ...p })), ...custom];
  }
  store.set('bt.schema', PROFILE_SCHEMA);
  let activeId = store.get('bt.activeId', profiles[0].id);
  let settings = { ...DEFAULT_SETTINGS, ...store.get('bt.settings', {}) };

  const saveProfiles = () => store.set('bt.profiles', profiles);
  const saveActive = () => store.set('bt.activeId', activeId);
  const saveSettings = () => store.set('bt.settings', settings);

  const activeProfile = () => profiles.find(p => p.id === activeId) || profiles[0];

  // ------------------------------------------------------------------
  // Hilfsfunktionen
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function fmtLong(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m && s) return `${m} min ${s} s`;
    if (m) return `${m} min`;
    return `${s} s`;
  }
  const isPyramid = p => p.mode === 'pyramid';

  // Rundenzeiten eines Profils, z. B. Pyramide 10, 20, 30, 20, 10
  function roundTimes(p) {
    if (!isPyramid(p)) return Array(p.rounds).fill(p.round);
    const start = p.pyrStart, step = Math.max(1, p.pyrStep), peak = Math.max(p.pyrStart, p.pyrPeak);
    const up = [];
    for (let t = start; t < peak && up.length < 49; t += step) up.push(t);
    return [...up, peak, ...up.slice().reverse()];
  }
  function totalSeconds(p) {
    const times = roundTimes(p);
    return p.prep + times.reduce((a, b) => a + b, 0) + Math.max(0, times.length - 1) * p.rest;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ------------------------------------------------------------------
  // Töne – werden live auf dem Gerät synthetisiert (keine Audiodateien)
  // ------------------------------------------------------------------
  const Sound = {
    ctx: null,
    master: null,

    unlock() {
      try {
        // iOS 17+: Ton auch bei aktiviertem Stummschalter abspielen
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (_) { /* nicht unterstützt */ }
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 10;
        comp.ratio.value = 4;
        comp.attack.value = 0.002;
        comp.release.value = 0.25;
        this.master = this.ctx.createGain();
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.setVolume(settings.volume);
        // stillen Puffer abspielen, um Audio unter iOS freizuschalten
        const buf = this.ctx.createBuffer(1, 1, 22050);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    },

    setVolume(v) {
      if (!this.master) return;
      const g = Math.pow(clamp(v, 0, 100) / 100, 1.6) * 1.6;
      this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
    },

    ready() {
      if (!this.ctx) return false;
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      return true;
    },

    noiseBuffer(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    },

    // Ein einzelnes „Klopfen" wie Holzklapper auf dem Ringboden
    knockOnce(t) {
      const ctx = this.ctx;
      const out = ctx.createGain();
      out.gain.value = 1;
      out.connect(this.master);

      // Holzton (Resonanz)
      [[880, 0.9, 0.07], [1530, 0.45, 0.05], [2450, 0.2, 0.03]].forEach(([f, a, d]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * 1.06, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.02);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(a, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g); g.connect(out);
        o.start(t); o.stop(t + d + 0.02);
      });

      // dumpfer Schlag
      const thump = ctx.createOscillator();
      const tg = ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(220, t);
      thump.frequency.exponentialRampToValueAtTime(90, t + 0.08);
      tg.gain.setValueAtTime(0.0001, t);
      tg.gain.exponentialRampToValueAtTime(0.8, t + 0.003);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      thump.connect(tg); tg.connect(out);
      thump.start(t); thump.stop(t + 0.13);

      // Anschlaggeräusch
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer(0.04);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 1.2;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.7, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
      n.connect(bp); bp.connect(ng); ng.connect(out);
      n.start(t); n.stop(t + 0.04);
    },

    // Klopfsignal: drei schnelle Schläge
    knock() {
      if (!this.ready()) return;
      const t = this.ctx.currentTime + 0.02;
      for (let i = 0; i < 3; i++) this.knockOnce(t + i * 0.16);
    },

    // Gong/Ringglocke mit metallischen Obertönen
    gongOnce(t, base = 392) {
      const ctx = this.ctx;
      const out = ctx.createGain();
      out.connect(this.master);
      const partials = [
        // [Verhältnis, Lautstärke, Abklingzeit]
        [0.5,  0.35, 4.5],
        [1.0,  0.60, 3.8],
        [1.19, 0.30, 2.6],
        [1.5,  0.28, 2.4],
        [2.0,  0.42, 2.2],
        [2.52, 0.20, 1.6],
        [3.01, 0.16, 1.3],
        [4.16, 0.10, 0.9],
        [5.43, 0.07, 0.6],
      ];
      partials.forEach(([r, a, d], i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = base * r * (1 + (i % 2 ? 0.0015 : -0.001));
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(a, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g); g.connect(out);
        o.start(t); o.stop(t + d + 0.05);
      });
      // Anschlag
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer(0.05);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.35, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      n.connect(hp); hp.connect(ng); ng.connect(out);
      n.start(t); n.stop(t + 0.05);
    },

    gong(times = 1) {
      if (!this.ready()) return;
      const t = this.ctx.currentTime + 0.02;
      for (let i = 0; i < times; i++) this.gongOnce(t + i * 0.55);
    },
  };

  // ------------------------------------------------------------------
  // Display wach halten (Screen Wake Lock API)
  // ------------------------------------------------------------------
  const Wake = {
    lock: null,
    async request() {
      if (!settings.wakeLock || !('wakeLock' in navigator) || this.lock) return;
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => { this.lock = null; });
      } catch (_) { this.lock = null; }
    },
    release() {
      if (this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
    },
  };

  // ------------------------------------------------------------------
  // Timer-Logik (zeitstempelbasiert, damit nichts driftet)
  // ------------------------------------------------------------------
  const T = {
    state: 'idle',  // idle | running | paused | done
    phases: [],
    idx: 0,
    endAt: 0,        // performance.now() Zeitpunkt, an dem die Phase endet
    remainingMs: 0,  // bei Pause
    warned: false,
    profile: null,
  };

  function buildPhases(p) {
    const list = [];
    if (p.prep > 0) list.push({ type: 'prep', dur: p.prep, n: 0 });
    const times = roundTimes(p);
    times.forEach((dur, k) => {
      const i = k + 1;
      list.push({ type: 'round', dur, n: i });
      if (i < times.length && p.rest > 0) list.push({ type: 'rest', dur: p.rest, n: i });
    });
    return list;
  }

  function resetTimer() {
    T.state = 'idle';
    T.profile = { ...activeProfile() };
    T.phases = buildPhases(T.profile);
    T.idx = 0;
    T.remainingMs = T.phases[0].dur * 1000;
    T.warned = false;
    Wake.release();
    render();
  }

  function phaseStartSound(phase) {
    if (phase.type === 'round' || phase.type === 'rest') Sound.gong(1);
  }

  function start() {
    Sound.unlock();
    if (T.state === 'done') resetTimer();
    if (T.state === 'idle') {
      T.idx = 0;
      T.remainingMs = T.phases[0].dur * 1000;
      T.warned = false;
      phaseStartSound(T.phases[0]);
    }
    T.endAt = performance.now() + T.remainingMs;
    T.state = 'running';
    Wake.request();
    loop();
  }

  function pause() {
    if (T.state !== 'running') return;
    T.remainingMs = Math.max(0, T.endAt - performance.now());
    T.state = 'paused';
    Wake.release();
    render();
  }

  function finish() {
    T.state = 'done';
    T.remainingMs = 0;
    Wake.release();
    if (settings.endGong) Sound.gong(3); else Sound.gong(1);
    render();
  }

  // Zur nächsten Phase wechseln; overshootMs = wie weit wir schon drüber sind
  function advance(now, overshootMs) {
    let idx = T.idx + 1;
    let over = overshootMs;
    // Falls die App im Hintergrund war: verpasste Phasen überspringen
    while (idx < T.phases.length && over >= T.phases[idx].dur * 1000) {
      over -= T.phases[idx].dur * 1000;
      idx++;
    }
    if (idx >= T.phases.length) { T.idx = T.phases.length - 1; finish(); return; }
    T.idx = idx;
    T.endAt = now - over + T.phases[idx].dur * 1000;
    T.warned = false;
    phaseStartSound(T.phases[idx]);
  }

  function skip() {
    Sound.unlock();
    if (T.state === 'idle' || T.state === 'done') return;
    const now = performance.now();
    if (T.idx + 1 >= T.phases.length) { finish(); return; }
    T.idx++;
    T.warned = false;
    T.remainingMs = T.phases[T.idx].dur * 1000;
    T.endAt = now + T.remainingMs;
    phaseStartSound(T.phases[T.idx]);
    render();
  }

  function tick() {
    if (T.state !== 'running') return;
    const now = performance.now();
    let rem = T.endAt - now;
    const phase = T.phases[T.idx];
    const warnMs = (T.profile.warn || 0) * 1000;

    if (!T.warned && warnMs > 0 && rem <= warnMs && rem > 0) {
      T.warned = true;
      // nur klopfen, wenn die Phase länger als die Warnzeit ist und der Moment nicht verpasst wurde
      if (phase.dur * 1000 > warnMs && rem > warnMs - 1500) Sound.knock();
    }
    if (rem <= 0) {
      advance(now, -rem);
    }
  }

  let rafId = 0;
  function loop() {
    cancelAnimationFrame(rafId);
    const step = () => {
      tick();
      render();
      if (T.state === 'running') rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }
  // Fallback, falls requestAnimationFrame gedrosselt wird (z. B. im Hintergrund)
  setInterval(() => { if (T.state === 'running') tick(); }, 200);

  // ------------------------------------------------------------------
  // Darstellung Timer
  // ------------------------------------------------------------------
  const el = {
    view: $('#view-timer'),
    time: $('#time'),
    label: $('#phaseLabel'),
    rounds: $('#roundCount'),
    bar: $('#progressBar'),
    next: $('#nextInfo'),
    total: $('#totalInfo'),
    pname: $('#profileName'),
    start: $('#btnStart'),
  };
  let lastKey = '';

  function render() {
    const p = T.profile;
    const phase = T.phases[T.idx];
    const times = roundTimes(p);
    const nRounds = times.length;
    let remMs;
    if (T.state === 'running') remMs = Math.max(0, T.endAt - performance.now());
    else remMs = T.remainingMs;
    const remSec = Math.ceil(remMs / 1000 - 1e-6);

    let phaseAttr, label, timeText, progress, nextText;
    if (T.state === 'idle') {
      phaseAttr = 'idle';
      label = 'BEREIT';
      timeText = fmt(times[0]);
      progress = 0;
      nextText = isPyramid(p)
        ? `Pyramide ${fmt(times[0])} → ${fmt(Math.max(...times))} → ${fmt(times[nRounds - 1])}  ·  Pause ${fmt(p.rest)}`
        : `${nRounds} × ${fmt(times[0])}  ·  Pause ${fmt(p.rest)}`;
    } else if (T.state === 'done') {
      phaseAttr = 'done';
      label = 'FERTIG';
      timeText = '0:00';
      progress = 1;
      nextText = 'Starke Leistung! 🥊';
    } else {
      phaseAttr = phase.type;
      label = phase.type === 'round' ? `RUNDE ${phase.n}` : phase.type === 'rest' ? 'PAUSE' : 'VORBEREITUNG';
      if (T.state === 'paused') label += ' – PAUSIERT';
      timeText = fmt(remSec);
      progress = 1 - remMs / (phase.dur * 1000);
      const nxt = T.phases[T.idx + 1];
      if (!nxt) nextText = 'Letzte Runde!';
      else if (nxt.type === 'round') nextText = `Danach: Runde ${nxt.n} (${fmt(nxt.dur)})`;
      else nextText = `Danach: Pause (${fmt(nxt.dur)})`;
    }

    const roundNo = T.state === 'idle' ? 1
      : T.state === 'done' ? nRounds
      : (phase.type === 'prep' ? 1 : phase.n);
    const roundText = `Runde ${roundNo}/${nRounds}`;

    // verbleibende Gesamtzeit
    let totalRem = 0;
    if (T.state === 'idle') totalRem = totalSeconds(p);
    else if (T.state !== 'done') {
      totalRem = remMs / 1000;
      for (let i = T.idx + 1; i < T.phases.length; i++) totalRem += T.phases[i].dur;
    }
    const totalText = T.state === 'done' ? `Gesamt ${fmt(totalSeconds(p))}` : `Restzeit gesamt ${fmt(Math.ceil(totalRem - 1e-6))}`;

    const warnActive = T.state === 'running' && phase && p.warn > 0 && remMs <= p.warn * 1000 && phase.dur > p.warn;

    // Breite des Fortschrittsbalkens jedes Frame aktualisieren
    el.bar.style.width = `${(clamp(progress, 0, 1) * 100).toFixed(2)}%`;

    const key = [phaseAttr, label, timeText, nextText, roundText, totalText, warnActive, T.state, p.name].join('|');
    if (key === lastKey) return;
    lastKey = key;

    el.view.dataset.phase = phaseAttr;
    el.view.classList.toggle('running', T.state === 'running');
    el.view.classList.toggle('warn', !!warnActive);
    el.label.textContent = label;
    el.time.textContent = timeText;
    el.time.classList.toggle('long', timeText.length > 4);
    el.next.textContent = nextText;
    el.rounds.textContent = roundText;
    el.total.textContent = totalText;
    el.pname.textContent = p.name;
    el.start.setAttribute('aria-label', T.state === 'running' ? 'Pause' : 'Start');

    const meta = document.querySelector('meta[name="theme-color"]');
    const colors = { round: '#17a34a', rest: '#dc2626', prep: '#d99a00', done: '#2b3340', idle: '#111418' };
    if (meta && currentView === 'timer') meta.setAttribute('content', colors[phaseAttr] || '#111418');
  }

  el.start.addEventListener('click', () => {
    if (T.state === 'running') pause(); else start();
  });
  $('#btnSkip').addEventListener('click', skip);
  $('#btnReset').addEventListener('click', () => {
    if ((T.state === 'running' || T.state === 'paused') && !confirm('Timer zurücksetzen?')) return;
    resetTimer();
  });
  $('#profileChip').addEventListener('click', () => { location.hash = '#/profile'; });
  // Querformat: Menü-Quadrat in der Ecke blendet die Navigation ein/aus
  $('#menuBtn').addEventListener('click', e => {
    e.stopPropagation();
    document.body.classList.toggle('menu-open');
  });
  el.view.addEventListener('click', () => document.body.classList.remove('menu-open'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (Sound.ctx && Sound.ctx.state !== 'running') Sound.ctx.resume().catch(() => {});
      if (T.state === 'running') { Wake.request(); tick(); loop(); }
    }
  });

  // ------------------------------------------------------------------
  // Profile
  // ------------------------------------------------------------------
  function renderProfiles() {
    const ul = $('#profileList');
    ul.textContent = '';
    profiles.forEach(p => {
      const li = document.createElement('li');
      li.className = 'profile-item' + (p.id === activeId ? ' active' : '');

      const sel = document.createElement('button');
      sel.type = 'button';
      sel.className = 'profile-select';
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = (p.id === activeId ? '✓ ' : '') + p.name;
      const meta = document.createElement('span');
      meta.className = 'p-meta';
      const times = roundTimes(p);
      const roundInfo = isPyramid(p)
        ? `${fmt(p.pyrStart)}–${fmt(Math.max(...times))}`
        : fmt(p.round);
      meta.innerHTML =
        `<span>${isPyramid(p) ? 'Pyramide · ' : ''}${times.length} ${times.length === 1 ? 'Runde' : 'Runden'}</span>` +
        `<span class="g">${roundInfo}</span>` +
        `<span class="r">${fmt(p.rest)}</span>` +
        `<span>≈ ${fmt(totalSeconds(p))}</span>`;
      sel.append(name, meta);
      sel.addEventListener('click', () => selectProfile(p.id));

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'profile-edit';
      edit.textContent = 'Bearbeiten';
      edit.addEventListener('click', () => { location.hash = `#/profil/${encodeURIComponent(p.id)}`; });

      li.append(sel, edit);
      ul.append(li);
    });
  }

  function selectProfile(id) {
    if ((T.state === 'running' || T.state === 'paused') && id !== activeId &&
        !confirm('Der Timer läuft. Profil wechseln und Timer zurücksetzen?')) return;
    activeId = id;
    saveActive();
    resetTimer();
    location.hash = '#/timer';
  }

  // --- Editor ---
  let editing = null;   // Kopie des Profils
  let editingIsNew = false;
  let editMode = 'equal';

  function setEditMode(mode) {
    editMode = mode === 'pyramid' ? 'pyramid' : 'equal';
    $$('#modeSwitch button').forEach(b => b.classList.toggle('active', b.dataset.mode === editMode));
    $('#equalFields').hidden = editMode !== 'equal';
    $('#pyramidFields').hidden = editMode !== 'pyramid';
    updateEditTotal();
  }
  $$('#modeSwitch button').forEach(b => b.addEventListener('click', () => setEditMode(b.dataset.mode)));

  function readTimefield(tf) {
    const m = parseInt($('.tf-min', tf).value, 10) || 0;
    const s = parseInt($('.tf-sec', tf).value, 10) || 0;
    return m * 60 + s;
  }
  function writeTimefield(tf, sec) {
    $('.tf-min', tf).value = Math.floor(sec / 60);
    $('.tf-sec', tf).value = String(sec % 60).padStart(2, '0');
  }
  function fieldValue(name) {
    const tf = $(`.timefield[data-field="${name}"]`);
    if (tf) return readTimefield(tf);
    const st = $(`.stepper[data-field="${name}"] input`);
    return parseInt(st.value, 10) || 0;
  }
  function setField(name, v) {
    const box = $(`[data-field="${name}"]`);
    v = clamp(Math.round(v), +box.dataset.min, +box.dataset.max);
    if (box.classList.contains('timefield')) writeTimefield(box, v);
    else $('input', box).value = v;
    updateEditTotal();
  }
  function normalizeField(name) { setField(name, fieldValue(name)); }

  function collectEdit() {
    return {
      ...editing,
      name: $('#fName').value.trim() || 'Profil',
      mode: editMode,
      rounds: clamp(fieldValue('rounds'), 1, 99),
      round: clamp(fieldValue('round'), 10, 5940),
      pyrStart: clamp(fieldValue('pyrStart'), 10, 5940),
      pyrStep: clamp(fieldValue('pyrStep'), 10, 1800),
      pyrPeak: clamp(fieldValue('pyrPeak'), 10, 5940),
      rest: clamp(fieldValue('rest'), 0, 5940),
      prep: clamp(fieldValue('prep'), 0, 300),
      warn: clamp(fieldValue('warn'), 0, 30),
    };
  }
  function updateEditTotal() {
    if (!editing) return;
    const p = collectEdit();
    const times = roundTimes(p);
    $('#pyrPreview').textContent = `${times.length} Runden: ${times.map(fmt).join(' · ')}`;
    $('#editTotal').textContent = `Gesamtdauer: ${fmtLong(totalSeconds(p))}`;
  }

  function openEditor(id) {
    const existing = profiles.find(p => p.id === id);
    editingIsNew = !existing;
    editing = existing ? { ...existing } : {
      id: 'p-' + Date.now().toString(36),
      name: '', rounds: 3, round: 180, rest: 60, prep: 10, warn: 5,
    };
    editing = { mode: 'equal', pyrStart: 10, pyrStep: 10, pyrPeak: 30, ...editing };
    $('#editTitle').textContent = editingIsNew ? 'Neues Profil' : 'Profil bearbeiten';
    $('#fName').value = editing.name;
    ['rounds', 'round', 'rest', 'prep', 'warn', 'pyrStart', 'pyrStep', 'pyrPeak'].forEach(f => setField(f, editing[f]));
    setEditMode(editing.mode);
    $('#btnDelete').hidden = editingIsNew;
    $('#btnDuplicate').hidden = editingIsNew;
    updateEditTotal();
  }

  // Plus/Minus-Tasten mit Gedrückthalten
  $$('#editForm [data-field]').forEach(box => {
    const name = box.dataset.field;
    const step = +box.dataset.step;
    $$('.step-btn', box).forEach(btn => {
      const dir = +btn.dataset.dir;
      let holdT, repT;
      const bump = () => {
        const cur = fieldValue(name);
        // auf Schrittweite einrasten
        const next = dir > 0 ? Math.floor(cur / step) * step + step : Math.ceil(cur / step) * step - step;
        setField(name, next);
      };
      const stop = () => { clearTimeout(holdT); clearInterval(repT); };
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        bump();
        holdT = setTimeout(() => { repT = setInterval(bump, 90); }, 450);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
      btn.addEventListener('click', e => e.preventDefault());
    });
    $$('input', box).forEach(inp => {
      inp.addEventListener('change', () => normalizeField(name));
      inp.addEventListener('input', updateEditTotal);
      inp.addEventListener('focus', () => inp.select());
    });
  });
  $('#fName').addEventListener('input', updateEditTotal);

  $('#editForm').addEventListener('submit', e => {
    e.preventDefault();
    const p = collectEdit();
    const i = profiles.findIndex(x => x.id === p.id);
    if (i >= 0) profiles[i] = p; else profiles.push(p);
    saveProfiles();
    if (p.id === activeId || editingIsNew) {
      activeId = p.id;
      saveActive();
      if (T.state === 'idle' || T.state === 'done') resetTimer();
    }
    toast('Profil gespeichert');
    editing = null;
    location.hash = '#/profile';
  });
  $('#btnCancelEdit').addEventListener('click', () => { editing = null; location.hash = '#/profile'; });
  $('#btnDelete').addEventListener('click', () => {
    if (profiles.length <= 1) { toast('Das letzte Profil kann nicht gelöscht werden.'); return; }
    if (!confirm(`Profil „${editing.name}“ löschen?`)) return;
    profiles = profiles.filter(p => p.id !== editing.id);
    saveProfiles();
    if (activeId === editing.id) {
      activeId = profiles[0].id;
      saveActive();
      resetTimer();
    }
    editing = null;
    toast('Profil gelöscht');
    location.hash = '#/profile';
  });
  $('#btnDuplicate').addEventListener('click', () => {
    const p = collectEdit();
    const copy = { ...p, id: 'p-' + Date.now().toString(36), name: `${p.name} (Kopie)`.slice(0, 40) };
    profiles.push(copy);
    saveProfiles();
    toast('Profil dupliziert');
    location.hash = `#/profil/${encodeURIComponent(copy.id)}`;
  });
  $('#btnNewProfile').addEventListener('click', () => { location.hash = '#/profil/neu'; });

  // ------------------------------------------------------------------
  // Einstellungen
  // ------------------------------------------------------------------
  const sVolume = $('#sVolume'), sWake = $('#sWake'), sEndGong = $('#sEndGong');
  sVolume.value = settings.volume;
  sWake.checked = settings.wakeLock;
  sEndGong.checked = settings.endGong;
  sVolume.addEventListener('input', () => {
    settings.volume = +sVolume.value;
    Sound.setVolume(settings.volume);
    saveSettings();
  });
  sWake.addEventListener('change', () => {
    settings.wakeLock = sWake.checked;
    saveSettings();
    if (!settings.wakeLock) Wake.release();
    else if (T.state === 'running') Wake.request();
  });
  sEndGong.addEventListener('change', () => { settings.endGong = sEndGong.checked; saveSettings(); });
  $('#btnTestKnock').addEventListener('click', () => { Sound.unlock(); Sound.knock(); });
  $('#btnTestGong').addEventListener('click', () => { Sound.unlock(); Sound.gong(1); });
  $('#btnResetAll').addEventListener('click', () => {
    if (!confirm('Alle eigenen Profile löschen und Standardprofile wiederherstellen?')) return;
    profiles = DEFAULT_PROFILES.map(p => ({ ...p }));
    activeId = profiles[0].id;
    saveProfiles(); saveActive();
    resetTimer();
    toast('Standardprofile wiederhergestellt');
  });

  $('#appVersion').textContent = VERSION;

  // ------------------------------------------------------------------
  // Navigation (Hash-Routing)
  // ------------------------------------------------------------------
  let currentView = 'timer';
  const views = {
    timer: '#view-timer', profiles: '#view-profiles', edit: '#view-edit',
    settings: '#view-settings', info: '#view-info', privacy: '#view-privacy',
  };
  const tabOf = { timer: 'timer', profiles: 'profiles', edit: 'profiles', settings: 'settings', info: 'info', privacy: 'info' };

  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    let view = 'timer';
    if (h === 'profile') { view = 'profiles'; renderProfiles(); }
    else if (h.startsWith('profil/')) {
      view = 'edit';
      const id = decodeURIComponent(h.slice(7));
      openEditor(id === 'neu' ? null : id);
    }
    else if (h === 'einstellungen') view = 'settings';
    else if (h === 'info') view = 'info';
    else if (h === 'datenschutz') view = 'privacy';

    currentView = view;
    document.body.classList.toggle('on-timer', view === 'timer');
    document.body.classList.remove('menu-open');
    Object.entries(views).forEach(([k, sel]) => { $(sel).hidden = k !== view; });
    $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tabOf[view]));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && view !== 'timer') meta.setAttribute('content', '#111418');
    if (view === 'timer') { lastKey = ''; render(); }
    else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  if (!profiles.some(p => p.id === activeId)) { activeId = profiles[0].id; saveActive(); }
  saveProfiles();
  resetTimer();
  route();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
