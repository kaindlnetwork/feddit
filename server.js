'use strict';

// PhotoPrism Swipe – sortiere Fotos wie bei Tinder: rechts behalten, links löschen.
// Keine externen Abhängigkeiten, benötigt Node.js >= 20.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const config = {
  port: Number(process.env.PORT || 8080),
  photoprismUrl: (process.env.PHOTOPRISM_URL || 'http://localhost:2342').replace(/\/+$/, ''),
  token: process.env.PHOTOPRISM_TOKEN || '',
  username: process.env.PHOTOPRISM_USERNAME || '',
  password: process.env.PHOTOPRISM_PASSWORD || '',
  appPassword: process.env.APP_PASSWORD || '',
  keepAlbum: process.env.KEEP_ALBUM || '',
  allowPermanentDelete: process.env.ALLOW_PERMANENT_DELETE === 'true',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(config.dataDir, 'state.json');
const ORDERS = ['newest', 'oldest', 'added', 'edited', 'name', 'size', 'duration'];
const THUMB_SIZES = ['tile_500', 'fit_720', 'fit_1280', 'fit_1920', 'fit_2560'];
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Persistenter Zustand: Entscheidungen und Lesepositionen je Sortierung/Filter
// ---------------------------------------------------------------------------

let state = { decisions: {}, cursors: {}, keepAlbumUid: '' };
let saveTimer = null;

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Zustand konnte nicht gelesen werden:', err.message);
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(config.dataDir, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(state));
      await fsp.rename(tmp, STATE_FILE);
    } catch (err) {
      console.error('Zustand konnte nicht gespeichert werden:', err.message);
    }
  }, 300);
}

function cursorKey(order, q) {
  return `${order}|${q}`;
}

// ---------------------------------------------------------------------------
// PhotoPrism-Client
// ---------------------------------------------------------------------------

let authToken = config.token;
let previewToken = '';

async function login() {
  if (config.token) return config.token;
  if (!config.username || !config.password) {
    throw new HttpError(500, 'Weder PHOTOPRISM_TOKEN noch PHOTOPRISM_USERNAME/PHOTOPRISM_PASSWORD gesetzt.');
  }
  const res = await fetch(`${config.photoprismUrl}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  if (!res.ok) throw new HttpError(502, `Login bei PhotoPrism fehlgeschlagen (${res.status}).`);
  const body = await res.json();
  authToken = body.access_token || body.id || res.headers.get('x-session-id');
  if (body.config && body.config.previewToken) previewToken = body.config.previewToken;
  if (!authToken) throw new HttpError(502, 'PhotoPrism hat kein Session-Token geliefert.');
  return authToken;
}

async function pp(method, apiPath, { body, headers = {}, raw = false, retry = true } = {}) {
  if (!authToken) await login();
  const res = await fetch(`${config.photoprismUrl}/api/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'X-Auth-Token': authToken,
      'X-Session-ID': authToken,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry && !config.token) {
    authToken = '';
    return pp(method, apiPath, { body, headers, raw, retry: false });
  }

  const pt = res.headers.get('x-preview-token');
  if (pt) previewToken = pt;

  if (raw) return res;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `PhotoPrism ${method} ${apiPath} -> ${res.status} ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getPreviewToken() {
  if (!previewToken) {
    const cfg = await pp('GET', '/config');
    if (cfg && cfg.previewToken) previewToken = cfg.previewToken;
  }
  return previewToken;
}

async function searchPhotos(order, q, offset, count) {
  const params = new URLSearchParams({
    count: String(count),
    offset: String(offset),
    order,
    merged: 'true',
    public: 'false',
  });
  if (q) params.set('q', q);
  return (await pp('GET', `/photos?${params}`)) || [];
}

async function ensureKeepAlbum() {
  if (!config.keepAlbum) return '';
  if (state.keepAlbumUid) return state.keepAlbumUid;
  const params = new URLSearchParams({ count: '100', type: 'album', q: config.keepAlbum });
  const albums = (await pp('GET', `/albums?${params}`)) || [];
  const found = albums.find((a) => a.Title === config.keepAlbum);
  const album = found || (await pp('POST', '/albums', { body: { Title: config.keepAlbum } }));
  state.keepAlbumUid = album.UID;
  saveState();
  return album.UID;
}

// ---------------------------------------------------------------------------
// Fotos aufbereiten
// ---------------------------------------------------------------------------

function toCard(photo, pos) {
  const files = Array.isArray(photo.Files) ? photo.Files : [];
  const primary = files.find((f) => f.Primary) || files[0] || {};
  const video = files.find((f) => f.Video || f.MediaType === 'video');
  const isVideo = ['video', 'live', 'animated'].includes(photo.Type);
  return {
    uid: photo.UID,
    pos,
    title: photo.Title || '',
    type: photo.Type || 'image',
    takenAt: photo.TakenAtLocal || photo.TakenAt || '',
    place: [photo.PlaceCity, photo.PlaceCountry].filter((p) => p && p !== 'zz').join(', '),
    camera: [photo.CameraMake, photo.CameraModel].filter(Boolean).join(' '),
    fileName: primary.Name || photo.FileName || '',
    width: primary.Width || photo.Width || 0,
    height: primary.Height || photo.Height || 0,
    size: files.reduce((sum, f) => sum + (f.Size || 0), 0),
    favorite: !!photo.Favorite,
    hash: photo.Hash || primary.Hash || '',
    videoHash: isVideo && video ? video.Hash : '',
  };
}

// Liefert die nächsten unentschiedenen Fotos. "have" ist die Anzahl an
// unentschiedenen Fotos, die der Browser bereits in seiner Warteschlange hält.
// Gelöschte (archivierte) Fotos verschwinden aus der PhotoPrism-Suche, daher
// merken wir uns nur, ab welchem Offset bereits alles entschieden ist.
async function nextBatch(order, q, have, count) {
  const key = cursorKey(order, q);
  let start = state.cursors[key] || 0;
  let offset = start;
  let undecidedSeen = 0;
  let leadingDecided = true;
  const cards = [];
  const seen = new Set();

  for (let pages = 0; pages < 50 && cards.length < count; pages++) {
    const photos = await searchPhotos(order, q, offset, PAGE_SIZE);
    for (let i = 0; i < photos.length && cards.length < count; i++) {
      const photo = photos[i];
      if (seen.has(photo.UID)) continue;
      seen.add(photo.UID);
      const decided = state.decisions[photo.UID];
      if (decided) {
        if (leadingDecided) start = offset + i + 1;
        continue;
      }
      leadingDecided = false;
      if (undecidedSeen++ < have) continue;
      cards.push(toCard(photo, offset + i));
    }
    if (photos.length < PAGE_SIZE) break;
    offset += photos.length;
  }

  if (start !== (state.cursors[key] || 0)) {
    state.cursors[key] = start;
    saveState();
  }

  return { photos: cards, previewToken: await getPreviewToken() };
}

async function decide(uid, action, pos, order, q) {
  if (!/^[a-z0-9]{10,32}$/i.test(uid)) throw new HttpError(400, 'Ungültige UID.');
  if (!['keep', 'delete', 'favorite'].includes(action)) throw new HttpError(400, 'Ungültige Aktion.');

  if (action === 'delete') {
    await pp('POST', '/batch/photos/archive', { body: { photos: [uid] } });
  } else {
    if (action === 'favorite') await pp('POST', `/photos/${uid}/like`);
    const albumUid = await ensureKeepAlbum();
    if (albumUid) await pp('POST', `/albums/${albumUid}/photos`, { body: { photos: [uid] } });
  }

  state.decisions[uid] = { action, pos: Number(pos) || 0, key: cursorKey(order, q), at: Date.now() };
  saveState();
}

async function undo(uid) {
  const d = state.decisions[uid];
  if (!d) throw new HttpError(404, 'Keine Entscheidung für dieses Foto gefunden.');

  if (d.action === 'delete') {
    await pp('POST', '/batch/photos/restore', { body: { photos: [uid] } });
  } else {
    if (d.action === 'favorite') await pp('DELETE', `/photos/${uid}/like`);
    if (state.keepAlbumUid) {
      await pp('DELETE', `/albums/${state.keepAlbumUid}/photos`, { body: { photos: [uid] } });
    }
  }

  delete state.decisions[uid];
  if (d.key && state.cursors[d.key] > d.pos) state.cursors[d.key] = d.pos;
  saveState();
}

function stats() {
  const counts = { keep: 0, delete: 0, favorite: 0, pendingPurge: 0 };
  for (const d of Object.values(state.decisions)) {
    counts[d.action]++;
    if (d.action === 'delete' && !d.purged) counts.pendingPurge++;
  }
  return { ...counts, allowPermanentDelete: config.allowPermanentDelete, keepAlbum: config.keepAlbum };
}

async function purge() {
  if (!config.allowPermanentDelete) {
    throw new HttpError(403, 'Endgültiges Löschen ist deaktiviert (ALLOW_PERMANENT_DELETE=true setzen).');
  }
  const uids = Object.entries(state.decisions)
    .filter(([, d]) => d.action === 'delete' && !d.purged)
    .map(([uid]) => uid);
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    await pp('POST', '/batch/photos/delete', { body: { photos: chunk } });
    for (const uid of chunk) state.decisions[uid].purged = true;
    saveState();
  }
  return { deleted: uids.length };
}

function resetProgress() {
  state.decisions = {};
  state.cursors = {};
  saveState();
}

// ---------------------------------------------------------------------------
// HTTP-Server
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/manifest+json',
  '.png': 'image/png',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e5) throw new HttpError(413, 'Anfrage zu groß.');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Ungültiges JSON.');
  }
}

function checkAuth(req, res) {
  if (!config.appPassword) return true;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    const a = crypto.createHash('sha256').update(pass).digest();
    const b = crypto.createHash('sha256').update(config.appPassword).digest();
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PhotoPrism Swipe", charset="UTF-8"' });
  res.end('Anmeldung erforderlich');
  return false;
}

async function pipeMedia(req, res, apiPath) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await pp('GET', apiPath, { raw: true, headers });
  const out = { 'Cache-Control': 'private, max-age=86400' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Verboten');
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Nicht gefunden');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (!checkAuth(req, res)) return;

  if (req.method === 'GET' && pathname === '/api/batch') {
    const order = ORDERS.includes(url.searchParams.get('order')) ? url.searchParams.get('order') : 'newest';
    const q = (url.searchParams.get('q') || '').slice(0, 200);
    const have = Math.max(0, Number(url.searchParams.get('have')) || 0);
    const count = Math.min(50, Math.max(1, Number(url.searchParams.get('count')) || 20));
    return sendJson(res, 200, await nextBatch(order, q, have, count));
  }

  if (req.method === 'GET' && pathname === '/api/stats') return sendJson(res, 200, stats());

  if (req.method === 'POST' && pathname === '/api/decide') {
    const { uid, action, pos, order = 'newest', q = '' } = await readJson(req);
    await decide(String(uid), action, pos, order, q);
    return sendJson(res, 200, stats());
  }

  if (req.method === 'POST' && pathname === '/api/undo') {
    const { uid } = await readJson(req);
    await undo(String(uid));
    return sendJson(res, 200, stats());
  }

  if (req.method === 'POST' && pathname === '/api/purge') return sendJson(res, 200, await purge());

  if (req.method === 'POST' && pathname === '/api/reset') {
    resetProgress();
    return sendJson(res, 200, stats());
  }

  let m;
  if (req.method === 'GET' && (m = pathname.match(/^\/media\/thumb\/([a-f0-9]{8,64})\/([a-z0-9_]+)$/))) {
    const size = THUMB_SIZES.includes(m[2]) ? m[2] : 'fit_1280';
    return pipeMedia(req, res, `/t/${m[1]}/${await getPreviewToken()}/${size}`);
  }

  if (req.method === 'GET' && (m = pathname.match(/^\/media\/video\/([a-f0-9]{8,64})$/))) {
    return pipeMedia(req, res, `/videos/${m[1]}/${await getPreviewToken()}/avc`);
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  throw new HttpError(405, 'Methode nicht erlaubt');
}

loadState();

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: err.message });
    });
  })
  .listen(config.port, () => {
    console.log(`PhotoPrism Swipe läuft auf http://localhost:${config.port} (PhotoPrism: ${config.photoprismUrl})`);
  });
