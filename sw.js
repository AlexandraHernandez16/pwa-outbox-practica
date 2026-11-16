// El SW no tiene <script>: importScripts carga db-helper.js de forma síncrona
// y deja disponibles abrirDB, guardarRegistro, obtenerTodosLosRegistros, eliminarRegistro, actualizarEstadoRegistro.
importScripts('./db-helper.js');

// v2: cambió el contenido de los archivos estáticos, así que se versiona
// el caché para que 'activate' borre el viejo 'app-static'.
const CACHE_STATIC = 'app-static-v2';
const CACHE_DYNAMIC = 'app-dynamic';

const ENDPOINT_API = 'https://jsonplaceholder.typicode.com/posts';

self.addEventListener(
  'install',
  (event) => {
    console.log('SW instalado :D');
    event.waitUntil(
      caches.open(CACHE_STATIC)
        .then((cache) => {
          // Rutas relativas ('./') para no romper el despliegue en el
          // subdirectorio de GitHub Pages (https://usuario.github.io/pwa-outbox-practica/)
          return cache.addAll(
            [
              './',
              './index.html',
              './styles.css',
              './app.js',
              './db-helper.js',
              './manifest.json',
              './icons/icon-192.png',
              './icons/icon-512.png',
            ]
          );
        })
        .then(() => self.skipWaiting())
    );
  }
);

self.addEventListener(
  'activate',
  (event) => {
    console.log('SW Activado');
    event.waitUntil(
      caches.keys().then(
        (keys) => {
          return Promise.all(
            keys.map((key) => {
              if (key != CACHE_STATIC && key != CACHE_DYNAMIC) {
                return caches.delete(key);
              }
            })
          );
        }
      ).then(() => self.clients.claim())
    );
  }
);

self.addEventListener('fetch', (event) => {
  // La Cache API solo admite GET. Los POST pasan directo a la red;
  // si fallan, app.js los guarda en IndexedDB.
  if (event.request.method !== 'GET') {
    return;
  }
  console.log('El SW ha interceptado la peticion ', event.request.url);
  const apiRequest = event.request.url.includes('jsonplaceholder.typicode.com');
  if (apiRequest) {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});

function cacheFirst(request) {
  return caches.match(request)
    .then((respCache) => {
      if (respCache) {
        return respCache;
      }
      return fetch(request)
        .then((respNetwork) => {
          return caches.open(CACHE_STATIC)
            .then((cacheStatic) => {
              cacheStatic.put(request, respNetwork.clone());
              return respNetwork;
            });
        });
    });
}

function networkFirst(request) {
  return fetch(request)
    .then((respNetwork) => {
      return caches.open(CACHE_DYNAMIC)
        .then((cacheDynamic) => {
          cacheDynamic.put(request, respNetwork.clone());
          return respNetwork;
        });
    })
    .catch(() => {
      return caches.match(request)
        .then((respCache) => {
          if (respCache) {
            return respCache;
          }
          return new Response(
            JSON.stringify({ error: 'No hay red ni caché' }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        });
    });
}

// ==========================================================
// Notificación del Worker hacia las pestañas abiertas (postMessage)
// ==========================================================
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

// ==========================================================
// Motor de sincronización en segundo plano
// ==========================================================
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        })
          .then((respuesta) => {
            if (!respuesta.ok) {
              throw new Error(`Error HTTP ${respuesta.status} al sincronizar ID ${item.id}`);
            }
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio)
        .then(() => notificarClientesActualizacion());
    });
}

// ==========================================================
// Escucha del evento 'sync' (Background Sync API)
// ==========================================================
self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW()
        .catch((error) => {
          console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
          // Relanzar el error indica al navegador que debe programar un reintento automático
          throw error;
        })
    );
  }
});
