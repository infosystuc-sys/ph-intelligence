# Estado de instancias WhatsApp poco confiable — diagnóstico de red + reconciliación de datos

Extiende [2026-07-28-whatsapp-instance-health-design.md](2026-07-28-whatsapp-instance-health-design.md), que ya implementó el semáforo de 3 señales. Este documento cubre por qué, en producción (31/7/2026), las 11 instancias muestran 🟡 "No verificado" en vez de su estado real, y qué se corrige.

## Problema

Dos causas distintas, confirmadas por evidencia, no supuestas:

1. **Los chequeos de red desde Vercel dan timeout (`AbortError`)** contra `puntohogar-evolution-api.cuhhss.easypanel.host`, tanto para `fetchInstances` como para `webhook/find`. Un `curl` directo desde una red externa distinta a la de Vercel responde en <1s (401 por api_key inválida), así que el host está arriba y responde rápido a *otras* redes — el problema es específico del camino Vercel → Evolution. Ya hubo un intento previo de mitigar esto subiendo el timeout de 5s a 10s (ver comentario en `lib/instance-health.ts`); no alcanzó, lo que sugiere que no es solo "un poco lento" sino algo que bloquea o cuelga la conexión (firewall/proxy/límite de conexiones concurrentes — hoy se disparan ~22 pedidos en paralelo a las 11 instancias).
2. **Instance_name/api_key desalineados**: comparando la tabla `whatsapp_instances` contra el panel de Evolution Manager, al menos 2 instancias tienen nombre incorrecto para su número real (ej. el teléfono de "Tucuman3" en Evolution está guardado como instancia `"9000"` en la app; el teléfono de `"3877412798"` en Evolution está guardado como `"Lajitas"`). Como `webhook/find` se llama por `instance_name`, un nombre incorrecto rompe esa señal aunque la conexión esté perfecta — un problema independiente del timeout de red.

## Objetivo

- Saber con evidencia (no hipótesis) en qué etapa se corta la conexión Vercel→Evolution, y resolverlo según lo que aparezca.
- Que cada fila de `whatsapp_instances` tenga el `instance_name`/`api_key` que realmente le corresponde a ese número, con revisión humana antes de aplicar cualquier corrección.
- Cada cambio de este trabajo debe poder revertirse sin dejar la app peor de lo que está hoy.

No objetivo (igual que el spec original): reconexión automática, QR, alertas proactivas, polling en segundo plano.

## Fase 1 — Instrumentación de diagnóstico (temporal, no cambia comportamiento)

`evolutionFetch` (`lib/evolution.ts`) hoy, al abortar, descarta toda la información de la conexión subyacente:

```ts
reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
```

Se agrega, sin cambiar el contrato de la función (mismo tipo de retorno, mismos casos de éxito):
- Timestamp de inicio de la request.
- Listener `req.on('socket', socket => socket.once('connect', () => connectedAt = Date.now()))` para saber si el TCP llegó a conectar.
- Si el abort dispara: el mensaje de error pasa a incluir cuánto tardó y si el socket llegó a conectar, ej. `AbortError tras 10000ms (socket conectado a los 340ms, sin respuesta)` vs `AbortError tras 10000ms (socket nunca conectó)`. Esto ya viaja hasta el badge en Configuración vía `connectionCheckError`/`webhookCheckError` — no hace falta tocar el frontend.

**Rollback:** este cambio es aditivo y de solo-logging/mensaje de error; si algo saliera mal, se revierte con un solo commit (`git revert`) sin efecto en datos.

**Cómo se usa:** una vez deployado, se corre el refresh de Configuración una vez y se lee el detalle expandido del badge. Con "nunca conectó" → problema de firewall/red (acción en Easypanel). Con "conectó pero sin respuesta" → problema de Traefik/límite de conexiones o de la propia Evolution API bajo carga (acción: bajar concurrencia desde nuestro lado, y/o revisar límites en Easypanel).

## Fase 2 — Reconciliación de instancias (asistida, no automática)

Nuevo endpoint admin `GET /api/instances/reconcile`:
1. Trae la lista real de instancias desde Evolution (iterando `fetchInstances` con cada `api_key` guardada, ya que no hay una key global — mismo patrón que ya usa `list-remote`).
2. Empareja por **número de teléfono** contra `whatsapp_instances`.
3. Devuelve solo las filas donde el teléfono coincide pero `instance_name` y/o `api_key` no — nunca las que ya coinciden, para no generar ruido.

Nueva sección en Configuración > Instancias: tabla de discrepancias encontradas ("la app dice `9000`, Evolution dice `Tucuman3` para el mismo número") con un checkbox por fila y un botón "Aplicar seleccionadas". Solo hace `UPDATE` de las filas que el admin marcó explícitamente.

**Rollback:** antes de aplicar cada corrección, se guarda el valor anterior de `instance_name`/`api_key` en una columna nueva `previous_values jsonb` de la misma fila (sin tabla nueva, sin migración de RLS). Un botón "Deshacer" en esa misma sesión restaura ese valor. Si se detecta un problema más tarde, el admin siempre puede volver a editar la instancia manualmente desde la pestaña existente (el flujo de edición ya soporta cambiar `instance_name`/`api_key` a mano).

## Fase 3 — Arreglo del chequeo de estado (condicionado a lo que arroje la Fase 1)

Dos ramas posibles, se implementa la que corresponda según evidencia real:

- **Bloqueo/cuelgue de red confirmado**: Vercel Functions no tiene IP de salida fija por defecto, así que "permitir la IP de Vercel" en Easypanel no es viable sin contratar Secure Compute de Vercel. Alternativa recomendada: mover el chequeo periódico a un workflow de n8n (que ya corre en la misma red que Evolution, usado hoy para el webhook) que escriba `whatsapp_instances.status` y las 3 señales en Supabase cada N minutos; la app deja de llamar a Evolution directamente y solo lee lo último guardado. Reversible: si no sirve, se vuelve a leer en vivo desde `/api/instances/refresh-status` como hasta ahora — no se borra el endpoint existente, se lo deja de invocar automáticamente pero sigue funcionando para el botón "Probar".
- **Saturación por concurrencia confirmada**: se cambia `Promise.allSettled` sobre las 11 instancias a lotes de 3-4 en paralelo (con un `for` secuencial entre lotes) dentro de `/api/instances/refresh-status`. Cambio acotado a un archivo, fácil de revertir con `git revert`.

## Fase 4 — Ajuste menor de UI

Una vez que el semáforo sea confiable: nada estructural nuevo, solo asegurar que la tabla de discrepancias de la Fase 2 y el detalle expandido de la Fase 1 convivan bien visualmente en la pestaña existente. No se rediseña la pantalla.

## Testing

- Fase 1: verificar en producción que el mensaje de error expandido efectivamente cambia (se puede simular localmente apuntando `EVOLUTION_API_BASE_URL` a un puerto que no escucha, para forzar "nunca conectó").
- Fase 2: probar contra las 11 instancias reales en modo solo-lectura (el `GET` de reconcile no escribe nada) antes de aplicar ninguna corrección; confirmar con el admin cada fila antes del `UPDATE`.
- Fase 3: una vez aplicada la rama que corresponda, correr el refresh y confirmar que las instancias que Evolution Manager muestra como "Conectado" pasan a 🟢 y las "Desconectado"/"Conectando" no quedan en 🟡 sin motivo.

## Fuera de alcance

Igual que el spec original, más: no se migra el health-check completo a n8n si la Fase 1 muestra que el problema es de concurrencia (no de bloqueo) — se elige una sola rama de la Fase 3, no ambas.
