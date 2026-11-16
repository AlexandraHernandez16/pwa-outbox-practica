// ==========================================================
// Registro del Service Worker y recepción de mensajes (postMessage)
// ==========================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((registro) => {
      console.log('[App] Service Worker registrado con scope:', registro.scope);
    })
    .catch((error) => {
      console.error('[App] Falló el registro del Service Worker:', error);
    });

  // El SW avisa por aquí cuando terminó de sincronizar en segundo plano
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });
}

const ENDPOINT_API = 'https://jsonplaceholder.typicode.com/posts';

// ==========================================================
// Indicador visual de estado de red
// ==========================================================
function actualizarIndicadorRed(){
  const badge = document.getElementById('badge-red');
  if (!badge) return;

  if (navigator.onLine) {
    badge.textContent = 'En Línea';
    badge.classList.remove('offline');
    badge.classList.add('online');
  } else {
    badge.textContent = 'Sin Conexión';
    badge.classList.remove('online');
    badge.classList.add('offline');
  }
}

// ==========================================================
// READ: Dibuja la bandeja de salida leyendo IndexedDB
// ==========================================================
function renderizarColaOutbox(){
  return obtenerTodosLosRegistros()
    .then((registros) => {
      const lista = document.getElementById('lista-outbox');
      lista.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'lista-vacia';
        vacio.textContent = 'No hay incidencias registradas todavía.';
        lista.appendChild(vacio);
        return;
      }

      // Mostrar lo más reciente primero
      registros
        .slice()
        .sort((a, b) => b.fechaCreacion - a.fechaCreacion)
        .forEach((registro) => {
          const item = document.createElement('li');
          item.className = `estado-${registro.estado}`;

          const hora = new Date(registro.fechaCreacion).toLocaleString();

          item.innerHTML = `
            <div>
              <div class="item-titulo">${registro.titulo}</div>
              <div class="item-hora">${hora}</div>
            </div>
            <span class="item-estado">${registro.estado}</span>
          `;

          lista.appendChild(item);
        });
    })
    .catch((error) => {
      console.error('[Outbox] Error al leer IndexedDB:', error);
    });
}

// ==========================================================
// CREATE: Envío resiliente con fallback a IndexedDB
// ==========================================================
function procesarEnvioReporte(datosFormulario){
  return fetch(ENDPOINT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datosFormulario)
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso en vivo: registrar en bitácora local como sincronizado
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando transacción localmente...');
      // Falla de red: guardar en IndexedDB como pendiente para reenvío posterior
      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => {
          // Detección de soporte para Background Sync API
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready
              .then((registro) => {
                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                return registro.sync.register('sync-reportes');
              })
              .catch((error) => {
                console.error('[Outbox] No se pudo registrar la etiqueta sync:', error);
              });
          }
        });
    })
    .then(() => {
      // Actualizar la lista visual en ambos escenarios
      return renderizarColaOutbox();
    });
}

// ==========================================================
// UPDATE (fallback): Barrido y reenvío de pendientes desde el hilo principal
// Se conserva como respaldo para navegadores sin SyncManager (Safari/iOS)
// ==========================================================
function sincronizarPendientesFallback(){
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Convertir cada registro pendiente en una promesa de envío + actualización
      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            // Actualizar estado en IndexedDB de 'pendiente' a 'sincronizado'
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Esperar a que todos los reenvíos concluyan
      return Promise.all(promesasDeEnvio);
    })
    .then(() => {
      return renderizarColaOutbox();
    })
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

// ==========================================================
// Conexión del formulario (CREATE)
// ==========================================================
const formIncidencia = document.getElementById('form-incidencia');
if (formIncidencia) {
  formIncidencia.addEventListener('submit', (e) => {
    e.preventDefault();

    const tituloInput = document.getElementById('titulo');
    const descripcionInput = document.getElementById('descripcion');

    const datosFormulario = {
      titulo: tituloInput.value,
      descripcion: descripcionInput.value
    };

    procesarEnvioReporte(datosFormulario)
      .then(() => {
        formIncidencia.reset();
      })
      .catch((error) => {
        console.error('[Outbox] Error al procesar el envío del reporte:', error);
      });
  });
}

// ==========================================================
// Purga de registros sincronizados (DELETE)
// ==========================================================
const btnPurgar = document.getElementById('btn-purgar');
if (btnPurgar) {
  btnPurgar.addEventListener('click', () => {
    obtenerTodosLosRegistros()
      .then((registros) => {
        const sincronizados = registros.filter((item) => item.estado === 'sincronizado');

        if (sincronizados.length === 0) {
          console.log('[Outbox] No hay registros sincronizados para purgar.');
          return;
        }

        const promesasDeBorrado = sincronizados.map((item) => eliminarRegistro(item.id));
        return Promise.all(promesasDeBorrado);
      })
      .then(() => {
        return renderizarColaOutbox();
      })
      .catch((error) => {
        console.error('[Outbox] Error al purgar registros sincronizados:', error);
      });
  });
}

// ==========================================================
// Eventos de conectividad (UPDATE) con degradación elegante
// ==========================================================
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Degradación elegante: Solo sincronizar desde UI si el navegador NO soporta Background Sync (ej. Safari/iOS)
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// ==========================================================
// Carga inicial: pintar el estado de red y la bandeja de salida (READ)
// ==========================================================
actualizarIndicadorRed();
renderizarColaOutbox();