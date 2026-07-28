# Estado real de instancias WhatsApp — Configuración > Instancias

## Problema

En Configuración > Instancias WhatsApp, la columna "Estado" muestra el campo `whatsapp_instances.status` guardado en la base de datos. Ese campo solo se actualiza cuando: (a) llega un webhook `CONNECTION_UPDATE` de Evolution API, (b) alguien visita el Dashboard (dispara `/api/instances/refresh-status` en segundo plano), o (c) un admin aprieta "Probar" en esa instancia puntual. Fuera de esos tres eventos, el dato queda congelado.

Verificación en vivo (28/7/2026) contra las 11 instancias de producción confirmó que el campo está completamente desactualizado: la DB reporta `disconnected` para las 11, pero en la realidad 9 están efectivamente caídas (la mayoría por sesión de WhatsApp cerrada hace 13-22 días, una hace más de 5 meses) y 2 están conectadas y funcionando. Nadie lo detectó porque no hay ninguna vista que fuerce un chequeo real al entrar a la pantalla de administración.

Además, "conectado" en Evolution API no garantiza que los mensajes lleguen a la app: los mensajes entrantes los procesa N8N (nuestro propio webhook `/api/webhooks/evolution` es un no-op para `MESSAGES_UPSERT`), así que un webhook mal registrado dejaría una instancia "conectada" pero muda, sin que nada lo muestre.

## Objetivo

Que un admin, al entrar a Configuración > Instancias, vea de inmediato y sin acción manual si cada instancia está realmente en condiciones de recibir mensajes — con tres señales independientes y verificables, ninguna inferida:

1. **Conexión WhatsApp** — sesión abierta en Evolution API (Baileys).
2. **Webhook** — registrado, habilitado, apuntando a la URL de N8N correcta, con el evento `MESSAGES_UPSERT`.
3. **Último mensaje recibido** — timestamp real del último mensaje entrante (`from_me = false`) guardado en la base, como evidencia independiente de que la cadena completa (WhatsApp → Evolution → N8N → Supabase) funcionó recientemente. Es informativo, no dispara alertas por sí solo (instancias de bajo tráfico no deben marcarse como rotas por no tener mensajes recientes).

No objetivo: no se toca el Dashboard más allá de mantener compatibilidad con el endpoint que ya consume; no hay reconexión automática ni botón para reescanear QR; no hay polling en segundo plano mientras la pestaña está abierta (fuera de alcance de esta iteración).

## Señales y fuentes de datos

| Señal | Fuente | Detalle verificado en vivo |
|---|---|---|
| Conexión | `GET /instance/fetchInstances` en Evolution API (con la `api_key` de la instancia) | Devuelve `connectionStatus` (`open`/`close`) y, cuando está cerrada, `disconnectionReasonCode` + `disconnectionAt` — mucho más útil que `connectionState`, que solo da el estado sin motivo. Confirmado contra las 11 instancias reales. |
| Webhook | `GET /webhook/find/{instance}` en Evolution API | Confirmado que existe en esta versión desplegada. Devuelve `{ url, enabled, events }`. Se valida: `enabled === true`, `url === process.env.N8N_WEBHOOK_URL`, `events.includes('MESSAGES_UPSERT')`. |
| Último mensaje recibido | Supabase, tabla `conversations` | `SELECT last_message_at FROM conversations WHERE instance_id = :id AND last_message_from_me = false ORDER BY last_message_at DESC LIMIT 1`. Usa el campo denormalizado ya mantenido por trigger — no requiere tocar la tabla `messages`. |

## Lógica del semáforo

Combina únicamente conexión + webhook (el último mensaje se muestra pero no vota):

- 🟢 **Operativa**: conexión `open` Y webhook `enabled` con URL y evento correctos.
- 🔴 **Sin recibir mensajes**: conexión distinta de `open`, O webhook ausente/deshabilitado/con URL incorrecta/sin el evento. Cualquiera de las dos condiciones alcanza para rojo — no requiere que fallen las dos.
- 🟡 **No se pudo verificar**: Evolution API no respondió el chequeo de conexión y/o webhook (timeout, error de red, instancia sin `api_key` válida). Estado desconocido, no se afirma que esté rota.

El semáforo nunca usa datos inferidos: cuando una señal no se pudo obtener, se marca explícitamente como "no verificado" en vez de asumir un valor.

**Precedencia cuando una señal falla y la otra no se pudo verificar:** rojo gana sobre amarillo. Si la conexión está confirmada como cerrada pero el chequeo del webhook dio timeout, el resultado es 🔴, no 🟡 — ya hay evidencia concreta de que no puede recibir mensajes, y sería menos veraz mostrar "no verificado" cuando en realidad hay un problema confirmado. Amarillo es solo para cuando *ninguna* señal disponible indica un problema y *alguna* no se pudo comprobar.

## Diseño técnico

### Backend — extender `/api/instances/refresh-status`

Se mantiene el mismo endpoint (ya usado por el Dashboard) para no duplicar lógica ni rutas. Por cada instancia, en paralelo:

1. `fetchInstances` → conexión + motivo de desconexión si aplica.
2. `webhook/find` → estado del webhook.
3. Query a `conversations` → último mensaje entrante.

Cada llamada a Evolution API se envuelve en su propio `try/catch` con timeout (patrón ya existente en el endpoint, 5s por llamada) — un fallo en una señal no debe tumbar las otras dos ni el resto de las instancias (`Promise.allSettled` a nivel instancia, como ya está).

Se sigue actualizando `whatsapp_instances.status` con el resultado de conexión (compatibilidad con el Dashboard y con cualquier otro lugar que lo lea), y se agrega al payload de respuesta, por instancia:

```
{
  instanceId,
  connected: boolean,
  connectionState: string,          // 'open' | 'close' | 'connecting' | 'unknown'
  disconnectReason?: string,        // solo si connectionState !== 'open'
  disconnectedAt?: string,          // ISO
  webhookOk: boolean | null,        // null = no se pudo verificar
  webhookUrl?: string,              // lo que Evolution tiene registrado, para diagnóstico
  lastInboundMessageAt: string | null,
  health: 'green' | 'yellow' | 'red',
}
```

El Dashboard sigue leyendo `connected` como hasta ahora; los campos nuevos los ignora sin romperse.

### Frontend — pestaña Instancias en Configuración

- Al montar la pestaña "Instancias WhatsApp" (no toda la página de Configuración, solo cuando `activeTab === 'instances'`), se dispara automáticamente `POST /api/instances/refresh-status` y se pisan los `status`/nuevos campos en el estado local — mismo patrón que ya usa el Dashboard (`refreshInstanceStatuses`), reutilizable como hook o función compartida.
- La columna "Estado" pasa de texto pequeño a un badge semáforo (🟢/🟡/🔴 + etiqueta corta: "Operativa" / "No verificado" / "Sin recibir mensajes").
- Al hacer click (mejor que hover para mobile/accesibilidad) sobre el badge se expande el detalle con las 3 señales: estado de conexión (+ motivo y fecha de desconexión si está cerrada), estado del webhook (+ URL registrada si no coincide), y fecha del último mensaje recibido (formateada relativa, ej. "hace 13 días").
- Mientras se está verificando, el badge muestra un estado "Verificando…" en vez del último valor conocido, para no mostrar un dato potencialmente engañoso como si fuera fresco.
- El botón "Probar" existente por instancia se mantiene sin cambios: sirve para validar credenciales al cargar/editar una instancia (incluso antes de guardarla, con `api_url`/`api_key` sueltos que todavía no existen en la DB), un caso que el chequeo enriquecido no cubre porque necesita una instancia ya persistida. El semáforo con las 3 señales vive solo en el refresh automático al abrir la pestaña.

## Manejo de errores / casos borde

- Instancia sin `api_key` guardada o con `api_key` inválida → Evolution devuelve 401/403 → se trata como "no se pudo verificar" (amarillo), nunca como falso rojo.
- `webhook/find` devuelve 404 si la instancia nunca tuvo webhook registrado → se interpreta como webhook ausente → contribuye a rojo (correcto: no puede recibir mensajes).
- Ninguna conversación con mensajes entrantes todavía (instancia nueva) → `lastInboundMessageAt: null`, se muestra como "Sin mensajes registrados", no como error.
- Todas las llamadas a Evolution respetan el `sslAgent` existente (certificado autofirmado de Easypanel) reutilizando `evolutionFetch`.

## Fuera de alcance

- Reconexión automática o botón de "reescanear QR" — la resolución del incidente encontrado (9 instancias caídas) es manual, fuera de esta feature.
- Polling periódico en segundo plano con la pestaña abierta.
- Cambios al Dashboard más allá de mantener compatibilidad del endpoint compartido.
- Alertas proactivas (email/Slack) cuando una instancia cae — podría ser una iteración futura una vez que el semáforo esté validado en uso real.
