'use strict';

const API_BASE = 'https://red-api.builtbyvega.com';
const CACHE_KEY = 'red-state';
const USER_KEY  = '/sw-user';

async function getCachedUser() {
  const cache = await caches.open(CACHE_KEY);
  const r = await cache.match(USER_KEY);
  return r ? r.text() : null;
}

self.addEventListener('push', event => {
  event.waitUntil(
    getCachedUser().then(userId => {
      if (!userId) {
        return self.registration.showNotification('R.E.D.', {
          body: 'Time to check in',
          icon: '/icon-192.png',
          tag: 'red-push',
        });
      }

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return fetch(`${API_BASE}/api/feed?tz=${encodeURIComponent(tz)}`)
        .then(r => r.json())
        .then(data => {
          const me   = data.users.find(u => u.id === userId);
          const body = me
            ? `${me.points}/9 today · ${me.streak}-day streak`
            : 'Time to check in';
          return self.registration.showNotification('R.E.D.', {
            body,
            icon: '/icon-192.png',
            tag: 'red-push',
            renotify: true,
          });
        })
        .catch(() => self.registration.showNotification('R.E.D.', {
          body: 'Time to check in',
          icon: '/icon-192.png',
          tag: 'red-push',
        }));
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const open = clients.find(c => c.url.startsWith(self.registration.scope));
        return open ? open.focus() : self.clients.openWindow('/');
      })
  );
});
