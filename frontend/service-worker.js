const CACHE_NAME = "stockfacil-shell-v1";

const APP_SHELL = [
  "/",
  "/index.html",
  "/panel.html",
  "/registro.html",
  "/planes.html",
  "/verificar-correo.html",
  "/styles.css",
  "/config.js",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest",
  "/js/pwa.js",
  "/js/auth.js",
  "/js/cash.js",
  "/js/config.js",
  "/js/db.js",
  "/js/dom.js",
  "/js/employees.js",
  "/js/firebase_sync.js",
  "/js/keyboard_scanner.js",
  "/js/login.js",
  "/js/paises.js",
  "/js/panel.js",
  "/js/products.js",
  "/js/registro.js",
  "/js/sales.js",
  "/js/scanner.js",
  "/js/ui.js",
  "/js/utils.js",
  "/js/verificar_correo.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        APP_SHELL.map(async (assetUrl) => {
          try {
            await cache.add(assetUrl);
          } catch (_) {
            // Continue even if a particular asset fails.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, networkResponse.clone());
          return networkResponse;
        } catch (_) {
          const cachedPage = await caches.match(request);
          if (cachedPage) return cachedPage;
          return (await caches.match("/index.html")) || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const networkPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(networkPromise);
        return cached;
      }

      const networkResponse = await networkPromise;
      return networkResponse || Response.error();
    })()
  );
});
