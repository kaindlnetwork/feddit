'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const tpl = $('card-tpl');

  const SWIPE_THRESHOLD = 0.25; // Anteil der Kartenbreite
  const REFILL_AT = 6;
  const PRELOAD = 4;

  const settings = loadSettings();
  let queue = []; // unentschiedene Fotos, queue[0] ist die oberste Karte
  let history = []; // [{ card, action }] für "Rückgängig"
  const elements = new Map(); // uid -> DOM-Element
  let pendingDecisions = 0;
  let loading = false;
  let exhausted = false;
  let generation = 0; // erhöht sich bei Filterwechsel, verwirft veraltete Antworten
  let chain = Promise.resolve();

  // Alle Serveraufrufe laufen nacheinander, damit der Server beim Nachladen
  // immer den aktuellen Stand der Entscheidungen kennt.
  function serial(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    return data;
  }

  function loadSettings() {
    try {
      return { order: 'newest', q: '', ...JSON.parse(localStorage.getItem('swipe-settings') || '{}') };
    } catch {
      return { order: 'newest', q: '' };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem('swipe-settings', JSON.stringify(settings));
    } catch {}
  }

  // ------------------------------------------------------------------ Daten

  function refill() {
    if (loading || exhausted || queue.length >= REFILL_AT) return;
    loading = true;
    const gen = generation;
    serial(async () => {
      const params = new URLSearchParams({
        order: settings.order,
        q: settings.q,
        have: String(queue.length + pendingDecisions),
        count: '20',
      });
      const data = await api('GET', `/api/batch?${params}`);
      if (gen !== generation) return;
      const known = new Set(queue.map((c) => c.uid));
      const fresh = data.photos.filter((p) => !known.has(p.uid));
      if (data.photos.length === 0) exhausted = true;
      queue.push(...fresh);
      $('error').hidden = true;
    })
      .catch((err) => {
        if (gen !== generation) return;
        $('error-text').textContent = err.message;
        $('error').hidden = queue.length > 0;
        if (queue.length) toast(err.message, 'error');
      })
      .finally(() => {
        if (gen !== generation) return;
        loading = false;
        render();
        if (!exhausted && queue.length < REFILL_AT && $('error').hidden) refill();
      });
  }

  function refreshStats() {
    api('GET', '/api/stats').then(updateStats).catch(() => {});
  }

  function updateStats(s) {
    $('cnt-keep').textContent = s.keep;
    $('cnt-delete').textContent = s.delete;
    $('cnt-favorite').textContent = s.favorite;
    $('purge-box').hidden = !s.allowPermanentDelete || s.pendingPurge === 0;
    $('purge-count').textContent = s.pendingPurge;
  }

  function reset() {
    generation++;
    for (const el of elements.values()) el.remove();
    elements.clear();
    queue = [];
    history = [];
    loading = false;
    exhausted = false;
    render();
    refill();
  }

  // ------------------------------------------------------------- Darstellung

  function thumbUrl(hash, size = 'fit_1920') {
    return `/media/thumb/${hash}/${size}`;
  }

  function formatDate(iso) {
    if (!iso || iso.startsWith('0001')) return 'Unbekanntes Datum';
    const d = new Date(iso.replace(/Z$/, ''));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function buildCard(card) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.uid = card.uid;
    const media = el.querySelector('.media');

    if (card.videoHash) {
      const video = document.createElement('video');
      video.poster = thumbUrl(card.hash);
      video.src = `/media/video/${card.videoHash}`;
      video.preload = 'none';
      video.playsInline = true;
      video.loop = true;
      media.append(video);
      const badge = document.createElement('div');
      badge.className = 'play-badge';
      badge.innerHTML = '<svg class="ic"><use href="#i-play"/></svg>Video · zum Abspielen tippen';
      media.append(badge);
      video.addEventListener('play', () => (badge.hidden = true));
      video.addEventListener('pause', () => (badge.hidden = false));
    } else {
      const img = document.createElement('img');
      img.src = thumbUrl(card.hash);
      img.alt = card.title;
      img.draggable = false;
      img.decoding = 'async';
      media.append(img);
    }

    el.querySelector('.meta-title').textContent = card.title || card.fileName || 'Ohne Titel';
    el.querySelector('.meta-sub').textContent = [formatDate(card.takenAt), card.place].filter(Boolean).join(' · ');
    el.querySelector('.meta-more').textContent = [
      card.fileName,
      card.camera,
      card.width && card.height ? `${card.width} × ${card.height}` : '',
      formatSize(card.size),
      card.favorite ? 'Bereits Favorit' : '',
    ].filter(Boolean).join('\n');

    attachDrag(el, card);
    return el;
  }

  function render() {
    const visible = queue.slice(0, 2);
    const visibleIds = new Set(visible.map((c) => c.uid));

    for (const [uid, el] of elements) {
      if (!visibleIds.has(uid) && !el.classList.contains('leaving')) {
        el.remove();
        elements.delete(uid);
      }
    }

    visible.forEach((card, i) => {
      let el = elements.get(card.uid);
      if (!el) {
        el = buildCard(card);
        elements.set(card.uid, el);
        stage.append(el);
      }
      el.style.zIndex = String(10 - i);
      el.classList.toggle('behind', i > 0);
      if (i > 0) {
        el.style.transform = '';
        const v = el.querySelector('video');
        if (v) v.pause();
      }
    });

    for (const card of queue.slice(2, 2 + PRELOAD)) {
      const img = new Image();
      img.src = thumbUrl(card.hash);
    }

    const empty = queue.length === 0;
    $('loading').hidden = !(empty && loading && $('error').hidden);
    $('empty').hidden = !(empty && !loading && exhausted && $('error').hidden);
    for (const id of ['btn-delete', 'btn-keep', 'btn-fav', 'btn-info']) $(id).disabled = empty;
    $('btn-undo').disabled = history.length === 0;
  }

  // ------------------------------------------------------------ Entscheiden

  function decide(action, el) {
    const card = queue[0];
    if (!card) return;
    el = el || elements.get(card.uid);

    if (el) {
      const w = window.innerWidth;
      const fly = {
        keep: `translate(${w * 1.5}px, 60px) rotate(30deg)`,
        delete: `translate(${-w * 1.5}px, 60px) rotate(-30deg)`,
        favorite: `translate(0, ${-window.innerHeight * 1.3}px)`,
      }[action];
      el.classList.remove('dragging');
      el.classList.add('leaving');
      showVerdict(el, action === 'favorite' ? 'fav' : action, 1);
      const v = el.querySelector('video');
      if (v) v.pause();
      el.style.transform = fly;
      el.style.opacity = '0';
      setTimeout(() => {
        el.remove();
        if (elements.get(card.uid) === el) elements.delete(card.uid);
      }, 320);
    }

    queue.shift();
    history.push({ card, action });
    if (history.length > 100) history.shift();
    pendingDecisions++;
    if (navigator.vibrate) navigator.vibrate(12);
    render();

    const gen = generation;
    // Zähler und Warteschlange werden innerhalb des serialisierten Aufrufs
    // angepasst, damit das nächste Nachladen bereits den neuen Stand sieht.
    serial(async () => {
      try {
        updateStats(
          await api('POST', '/api/decide', { uid: card.uid, action, pos: card.pos, order: settings.order, q: settings.q }),
        );
      } catch (err) {
        if (gen === generation) {
          toast(`Nicht gespeichert: ${err.message}`, 'error');
          history = history.filter((h) => h.card !== card);
          queue.unshift(card);
        }
      } finally {
        pendingDecisions--;
      }
    }).finally(() => {
      if (gen !== generation) return;
      render();
      refill();
    });
  }

  function undo() {
    const last = history.pop();
    if (!last) return;
    render();
    const gen = generation;
    serial(async () => {
      updateStats(await api('POST', '/api/undo', { uid: last.card.uid }));
      if (gen === generation) queue.unshift(last.card);
    })
      .then(() => gen === generation && toast('Entscheidung zurückgenommen', 'info'))
      .catch((err) => {
        if (gen !== generation) return;
        history.push(last);
        toast(`Rückgängig fehlgeschlagen: ${err.message}`, 'error');
      })
      .finally(() => gen === generation && render());
  }

  // ------------------------------------------------------------ Gesten

  function attachDrag(el, card) {
    let start = null;

    el.addEventListener('pointerdown', (e) => {
      if (queue[0] !== card || e.button > 0) return;
      start = { x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0 };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });

    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      start.dx = e.clientX - start.x;
      start.dy = e.clientY - start.y;
      const rot = start.dx / 18;
      el.style.transform = `translate(${start.dx}px, ${start.dy}px) rotate(${rot}deg)`;
      const w = el.offsetWidth * SWIPE_THRESHOLD;
      const up = -start.dy > Math.abs(start.dx) ? Math.min(1, -start.dy / w) : 0;
      showVerdict(el, 'keep', up ? 0 : start.dx / w);
      showVerdict(el, 'delete', up ? 0 : -start.dx / w);
      showVerdict(el, 'fav', up);
    });

    const end = () => {
      if (!start) return;
      const { dx, dy, t } = start;
      start = null;
      el.classList.remove('dragging');
      const dt = Math.max(1, performance.now() - t);
      const w = el.offsetWidth * SWIPE_THRESHOLD;
      const fastX = Math.abs(dx) / dt > 0.6 && Math.abs(dx) > 40;
      const fastY = -dy / dt > 0.6 && -dy > 40;

      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
        el.style.transform = '';
        togglePlayback(el);
        return;
      }
      if ((-dy > w || fastY) && -dy > Math.abs(dx)) return decide('favorite', el);
      if (dx > w || (fastX && dx > 0)) return decide('keep', el);
      if (dx < -w || (fastX && dx < 0)) return decide('delete', el);

      el.style.transform = '';
      ['keep', 'delete', 'fav'].forEach((v) => showVerdict(el, v, 0));
    };

    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function showVerdict(el, kind, amount) {
    const v = el.querySelector(`.verdict-${kind}`);
    const a = Math.max(0, Math.min(1, amount));
    v.style.opacity = String(a);
    v.style.transform = `scale(${0.96 + 0.04 * a})`;
  }

  function togglePlayback(el) {
    const v = el && el.querySelector('video');
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  // ------------------------------------------------------------ UI

  const TOAST_ICONS = { ok: 'i-check', info: 'i-info', error: 'i-close' };

  function toast(msg, tone = 'ok') {
    const wrap = $('toasts');
    while (wrap.children.length >= 2) wrap.firstElementChild.remove();
    const t = document.createElement('div');
    t.className = `toast toast-${tone}`;
    t.innerHTML = `<span class="toast-ico"><svg class="ic"><use href="#${TOAST_ICONS[tone]}"/></svg></span>`;
    t.append(document.createTextNode(msg));
    wrap.append(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 220);
    }, tone === 'error' ? 4000 : 1800);
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem('swipe-theme', theme);
      else localStorage.removeItem('swipe-theme');
    } catch {}
    for (const b of document.querySelectorAll('#theme-switch .seg-btn')) {
      const active = b.dataset.themeValue === theme;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    }
  }

  for (const b of document.querySelectorAll('#theme-switch .seg-btn')) {
    b.addEventListener('click', () => applyTheme(b.dataset.themeValue));
  }
  applyTheme(document.documentElement.dataset.theme || '');

  $('btn-keep').addEventListener('click', () => decide('keep'));
  $('btn-delete').addEventListener('click', () => decide('delete'));
  $('btn-fav').addEventListener('click', () => decide('favorite'));
  $('btn-undo').addEventListener('click', undo);
  $('btn-info').addEventListener('click', () => stage.classList.toggle('show-info'));
  $('btn-reload').addEventListener('click', reset);
  $('btn-retry').addEventListener('click', () => {
    $('error').hidden = true;
    reset();
  });

  $('btn-settings').addEventListener('click', () => {
    $('opt-order').value = settings.order;
    $('opt-q').value = settings.q;
    refreshStats();
    $('settings').showModal();
  });

  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue !== 'save') return;
    const order = $('opt-order').value;
    const q = $('opt-q').value.trim();
    if (order === settings.order && q === settings.q) return;
    settings.order = order;
    settings.q = q;
    saveSettings();
    reset();
  });

  $('btn-purge').addEventListener('click', async () => {
    const n = $('purge-count').textContent;
    if (!confirm(`${n} Fotos endgültig löschen? Dies lässt sich nicht rückgängig machen.`)) return;
    try {
      const r = await serial(() => api('POST', '/api/purge'));
      toast(`${r.deleted} Fotos endgültig gelöscht`);
      history = history.filter((h) => h.action !== 'delete');
      render();
      refreshStats();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Alle gespeicherten Entscheidungen vergessen? Bereits gelöschte Fotos bleiben im Archiv, behaltene Fotos werden wieder angezeigt.')) return;
    try {
      updateStats(await serial(() => api('POST', '/api/reset')));
      $('settings').close();
      reset();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.addEventListener('keydown', (e) => {
    if ($('settings').open || e.target.matches('input, select, textarea')) return;
    const map = {
      ArrowRight: () => decide('keep'), d: () => decide('keep'),
      ArrowLeft: () => decide('delete'), a: () => decide('delete'),
      ArrowUp: () => decide('favorite'), w: () => decide('favorite'),
      z: undo, Backspace: undo,
      i: () => stage.classList.toggle('show-info'),
      ' ': () => queue[0] && togglePlayback(elements.get(queue[0].uid)),
    };
    const fn = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (fn && !e.repeat) {
      e.preventDefault();
      fn();
    }
  });

  refreshStats();
  reset();
})();
