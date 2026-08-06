/* Meetings — service worker
   Contract with index.html:
     • receives { type:'schedule', alerts:[{key,at,id,offset,sticky,title,body}] }
     • fires those alerts while it is alive (handOff() sends the next 30 min)
     • shows push notifications sent by the paired server (VAPID)
     • focuses / opens the app on notification click
*/

const CACHE = 'meetings-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

/* ---------- lifecycle ---------- */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------- offline shell ----------
   Only same-origin GETs are touched. Calls to the sync server pass straight
   through so tokens and live data are never cached. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => { caches.open(CACHE).then(c => c.put(req, r.clone())); return r; })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone()));
      return r;
    }))
  );

  sweep(); // any wake is a chance to catch a missed alert
});

/* ---------- scheduled alerts ---------- */
let alerts = [];          // pending, sorted by time
let timers = [];          // live setTimeout handles
const fired = new Set();  // keys already shown this SW lifetime

self.addEventListener('message', e => {
  const d = e.data || {};

  if (d.type === 'schedule') {
    alerts = (d.alerts || []).filter(a => a && a.at && !fired.has(a.key));
    arm();
  }

  if (d.type === 'clear') {
    alerts = [];
    timers.forEach(clearTimeout);
    timers = [];
  }
});

function arm() {
  timers.forEach(clearTimeout);
  timers = [];
  const now = Date.now();

  alerts.forEach(a => {
    const wait = a.at - now;
    if (wait <= 0) { show(a); return; }
    // setTimeout beyond ~5 min rarely survives; sweep() is the safety net
    timers.push(setTimeout(() => show(a), wait));
  });
}

/* fire anything that has come due but was missed while the worker slept */
function sweep() {
  const now = Date.now();
  alerts.filter(a => a.at <= now + 1000 && !fired.has(a.key)).forEach(show);
}

function show(a) {
  if (fired.has(a.key)) return;
  fired.add(a.key);
  alerts = alerts.filter(x => x.key !== a.key);

  self.registration.showNotification(a.title, {
    body: a.body || '',
    tag: a.key,                        // replaces rather than stacks
    renotify: true,
    requireInteraction: !!a.sticky,
    vibrate: [200, 80, 200],
    timestamp: a.at,
    data: { id: a.id, offset: a.offset, url: './' }
  });

  // let an open tab mark it fired so it isn't shown twice
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage({ type: 'fired', key: a.key })));
}

/* ---------- server push (closed-app alerts) ---------- */
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; }
  catch (_) { p = { title: 'Meetings', body: e.data ? e.data.text() : '' }; }

  const title = p.title || 'Meeting alert';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: p.body || '',
      tag: p.tag || p.key || title,
      renotify: true,
      requireInteraction: !!p.sticky,
      vibrate: [200, 80, 200],
      data: { id: p.id, url: p.url || './' }
    })
  );
});

self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cs => cs.forEach(c => c.postMessage({ type: 'resubscribe' })))
  );
});

/* ---------- taps ---------- */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';

  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if ('focus' in c) {
        c.postMessage({ type: 'open', id: e.notification.data && e.notification.data.id });
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
