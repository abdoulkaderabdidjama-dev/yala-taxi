var CACHE = "yalatxi-v1";
var ASSETS = [
  "/",
  "/client.html",
  "/chauffeur.html",
  "/reset.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function(e) {
  // Ne pas intercepter les appels API et socket
  if (e.request.url.includes("/api/") || e.request.url.includes("socket.io")) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(response) {
        // Mettre en cache les nouvelles ressources
        if (response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        // Hors ligne : retourner la page principale
        if (e.request.destination === "document") {
          return caches.match("/");
        }
      });
    })
  );
});
