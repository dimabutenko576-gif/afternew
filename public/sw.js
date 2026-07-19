// Простой service worker — нужен в основном для того, чтобы браузер
// разрешил "установить" сайт как приложение. Кэширует только оболочку,
// сами ответы ИИ всегда загружаются заново (иначе бот "зависнет" на старых ответах).
const CACHE_NAME = 'ai-after-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // ничего не кэшируем агрессивно — просто отдаём сеть напрямую
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
