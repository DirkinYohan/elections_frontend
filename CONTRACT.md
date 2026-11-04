# Contrato frontend ↔ backend

Fuente de verdad de los tipos: `src/shared/contracts/messages.ts`.
El servidor simulado (`mock-server/server.mjs`) implementa este contrato completo.
Cualquier cambio debe acordarse entre frontend y backend antes de implementarse.

Criterio: lo que el backend ya define en `ElectionsOrchestratorController` y sus DTO se respeta tal cual
(rutas `/api/v1`, `ballotId`, `AggregateDto`, decisiones `CORRECTED/REJECTED/RATIFIED`, rutas
`/ws/juries` y `/ws/verification`). Lo que todavía no existe queda definido aquí y listado en
**Pendientes para el backend** al final.

## Transporte por audiencia

| Audiencia | Transporte | Por qué |
|---|---|---|
| Jurados | HTTP `POST` + cola offline en el navegador; WebSocket `/ws/juries` solo para avisos | En redes móviles malas, una petición idempotente que se reintenta es más robusta que mantener un socket abierto. La confirmación viaja en la misma respuesta |
| Auditores y coordinador | WebSocket puro `/ws/verification` | Bidireccional y colaborativo: tomar casos, latidos, ver en vivo lo que hacen los demás |
| Público | SSE `/api/v1/stream` | Una sola dirección, reconexión y `Last-Event-ID` nativos en el protocolo, pasa por cualquier proxy HTTP. El modo polling existe solo para medir la comparación |

## 1. Identidad

### `POST /api/v1/auth/login`

`{ "username": "...", "password": "..." }` → `SessionDto` `{ token, username, role, expiresAt }`.
Roles: `JURY`, `AUDITOR`, `COORDINATOR`, `PUBLIC`. Credenciales inválidas → `401 {"error": "..."}`.

- HTTP: `Authorization: Bearer <token>`.
- WebSocket: `?token=<token>` en la URL, porque el navegador no permite cabeceras propias en el handshake.
  En producción debería ser un token de corta duración emitido solo para abrir el socket.

## 2. Catálogo

### `GET /api/v1/catalog`

```json
{
  "department": "…", "corporation": "03",
  "candidates": [{ "key": "C1", "name": "…", "party": "…" }],
  "municipalities": [{ "id": 11, "name": "…", "stations": [{ "id": 110, "name": "…", "tables": [1, 2, 3] }] }]
}
```

Lo usan la página pública (selector de tópico, nombres de candidatos) y la app del jurado (formulario).
El frontend lo guarda en `localStorage`, así el jurado puede llenar el formulario sin red.

## 3. Jurados

### `POST /api/v1/ballots`

Cabeceras: `Authorization`, `X-Client-Id` (identificador del jurado para el límite de tasa).
Cuerpo: el JSON de la sección 3.1 del caso (`BallotTransmissionDto`, mismos nombres en español).
El campo `idem` lo genera el cliente **una sola vez** por acta + versión, lo guarda antes del
primer envío y lo reutiliza en cada reintento.

Respuesta `{ status, ballotId, version, receipt, message, registeredAt }`:

| `status` | HTTP | Hoy en el backend | Significado | Qué hace el cliente |
|---|---|---|---|---|
| `REGISTERED` | 201 | `ACCEPTED` | Guardada y sumada | Confirmada |
| `DUPLICATE` | 200 | `DUPLICATE` | Ya estaba; **mismo `receipt`** que la primera vez | Confirmada |
| `SUPERSEDED` | 200 | — | Guardada, pero ya hay una versión más nueva aplicada | Confirmada, se informa |
| `DOUBTFUL` | 202 | `SUSPICIOUS_FOR_VERIFICATION` | No cuadra la regla contable; va a verificación | "En verificación" |
| `REJECTED` | 422 | — | Datos inválidos, no se guardó | Muestra `message` |
| `UNAVAILABLE` | 503 | — | Degradado (Redis caído). **No se guardó** | Sigue en cola y reintenta |
| — | 429 | `Rate limit exceeded` | Límite de tasa | Espera `retryAfterSeconds` y reintenta |

El adaptador `src/shared/api/ballots.ts` acepta tanto los estados actuales del backend como los del contrato.

**Caída entre registrar y confirmar (RF-1).** El backend nunca responde éxito sin haber persistido.
Si cae después de guardar y antes de responder, el cliente no recibe nada, mantiene el acta en cola
y la reenvía con el mismo `idem`; el backend responde `DUPLICATE` con el recibo original. Si la clave
`idem` ya expiró en Redis, la segunda línea de defensa es la clave permanente `acta + versión`.

### WebSocket `/ws/juries?token=<token>`

Solo servidor → cliente. Cuando la verificación resuelve un acta dudosa de ese jurado:
`{ "type": "ballot_update", "ballotId", "version", "decision": "RATIFIED|CORRECTED|REJECTED", "notes", "at" }`.

## 4. Público

### SSE `GET /api/v1/stream?topic=<topic>&lastEventId=<id>`

- `topic`: `department`, `municipality:<id>` o `station:<id>` (RF-5).
- `lastEventId`: último `id` procesado. También se acepta la cabecera `Last-Event-ID`.
- `id`: ID del Redis Stream del tópico (`<ms>-<seq>`) o un `long` monótono. El cliente compara
  ambos formatos numéricamente.

```
id: 1793577600123-0
event: delta
data: {"type":"delta","topic":"municipality:11","changes":{"votes":{"C1":5120},"tablesReported":88},"at":1793577600123}
```

| Evento | Cuándo | Contenido |
|---|---|---|
| `snapshot` | Primera conexión, o `lastEventId` fuera de la ventana retenida | `totals` completos e `instanceId` |
| `delta` | Una vez por ventana (≈2 s) si el tópico cambió | `changes` con los **valores absolutos nuevos** de lo que cambió |
| `correction` | Igual que `delta` cuando en la ventana hubo actas corregidas | `changes` + `corrections: [{ballotId, fromVersion, toVersion, reason}]` |

- **Valores absolutos, no incrementos:** reaplicar un evento no cambia el estado, así que el solape
  de una reconexión no puede contar dos veces.
- **Un número solo baja dentro de un `correction`,** que trae la explicación.
- **Reconexión (RF-6):** si `lastEventId` está en la ventana retenida, el servidor reenvía solo lo
  posterior; si no, manda un `snapshot`.
- **Cliente lento (RF-9):** si su búfer de salida supera el umbral, el servidor deja de enviarle y
  cierra; el cliente vuelve con su `lastEventId`.
- Al abrir, el servidor envía de inmediato un comentario `: connected` para que salgan las cabeceras; si no, un cliente que se reconecta sin nada pendiente se queda "conectando" hasta el siguiente evento de su tópico. En Spring: `SseEmitter.send(SseEmitter.event().comment("connected"))` al crear el emisor.
- Comentario `: ping` cada 15 s para que los proxies no cierren la conexión.

### `GET /api/v1/results/department` · `/municipality/{id}` · `/station/{id}`

`AggregateDto` `{ level, identifier, reportedTables, totalTables, reportedPercentage, candidateTotals }`.
Ya existen en el backend. El frontend los usa solo en `?transport=polling` para comparar contra SSE.

## 5. Auditores y coordinador

### WebSocket `/ws/verification?token=<token>[&role=coordinator]`

| Cliente → servidor | Uso |
|---|---|
| `take_case {ballotId}` | Pedir el bloqueo |
| `heartbeat {active}` | Cada `heartbeatMs` (10 s). `active: true` solo si hubo interacción real desde el latido anterior. Solo esos renuevan el bloqueo |
| `resolve_case {ballotId, lockToken, decision, correctedVotes?, notes?}` | `decision`: `RATIFIED`, `CORRECTED` (con `correctedVotes`), `REJECTED` |
| `release_case {ballotId, lockToken}` | Devolver el caso a la cola |

| Servidor → cliente | Uso |
|---|---|
| `welcome` | `auditorId`, `name`, `role`, `instanceId`, `lockTtlMs`, `heartbeatMs` |
| `queue_snapshot` | Cola completa al conectar (y tras reconectar) |
| `case_added` / `case_locked` / `case_released` / `case_resolved` | Cambios de la cola, a todas las consolas |
| `take_rejected` | El caso ya lo tiene otro auditor |
| `presence` | Auditores conectados, caso actual, desde cuándo, instancia, último latido |
| `error` | `LOCK_NOT_OWNED`, `CASE_NOT_FOUND`, `ALREADY_HOLDING_CASE`, `READ_ONLY`, `BAD_MESSAGE` |

- `lockToken` solo se envía a la conexión dueña del bloqueo. Si el auditor reconecta y sigue siendo
  el dueño, el servidor le reenvía `case_locked` con el token.
- **Por qué token y no solo `auditorId`:** el token es único por adquisición. Si el bloqueo de un
  auditor expira y el mismo caso se reasigna, incluso a él mismo desde otra pestaña, el token viejo
  ya no coincide y la liberación tardía falla. En Redis: `SET lock:<ballotId> <token> NX PX <ttl>` para
  tomar, y un script Lua de comparar-y-borrar para liberar.
- **Tensión de RF-7:** el bloqueo dura `lockTtlMs` (30 s en el mock) y solo lo renuevan latidos
  activos. Si el auditor cierra el navegador, pierde la red o deja de interactuar, nadie renueva y
  el caso vuelve solo a la cola. Si sigue trabajando, cada latido activo lo extiende.
- **Presencia (RF-8):** cada latido refresca la presencia con TTL; una conexión que muere sin aviso
  deja de latir y desaparece al vencer el TTL.
- El coordinador (`role=coordinator`) recibe lo mismo, pero no puede tomar ni resolver (`READ_ONLY`).

Códigos de cierre: `4000` = reconectar con jitter, `4401` = no autorizado (no reconectar).

## 6. Operación

### `GET /api/v1/metrics`

```json
{ "instances": [{ "instanceId", "sseConnections", "wsConnections", "messagesPerSecond",
    "eventLoopLagMs", "memoryPerConnectionBytes", "ballotsPerMinute", "publishLatencyMs",
    "reconnectsPerSecond" }],
  "history": [{ "t", "…mismos campos, sumados entre instancias" }] }
```

Lo consume el tablero de operación (RT-7) cada 2 segundos.

## Pendientes para el backend

Contradicciones o huecos encontrados al comparar con `github.com/DirkinYohan/elections`:

1. **SSE `GET /api/v1/stream`** no existe. Sin él, el público no tiene transporte en tiempo real y no se cumple RT-5.
2. **Handlers de `/ws/verification` y `/ws/juries`** están comentados en `WebSocketConfig`. Las acciones de
   verificación hoy son REST (`/verification/lock`, `/release`, `/resolve`, `/heartbeat`); deben pasar a mensajes WebSocket.
3. **`lockToken`:** `VerificationService` guarda el `auditorId` como dueño del bloqueo; debe guardar un token
   aleatorio por adquisición y liberar con comparar-y-borrar atómico (Lua). El bloqueo dura 5 minutos fijos y no
   se renueva con latidos.
4. **Estados de respuesta de `/ballots`:** devolver `REGISTERED`, `SUPERSEDED`, `DOUBTFUL`, `UNAVAILABLE` y el
   `receipt`. Hoy un `DUPLICATE` no devuelve el recibo original y no hay control de versiones (RF-2).
5. **Idempotencia:** la clave `idempotency:ballot:<idem>` expira a las 4 horas y no hay respaldo con `acta + versión`.
6. **Redis caído:** no hay manejo; debe responder `503 UNAVAILABLE` y nunca un éxito sin persistir.
7. **`GET /api/v1/catalog`** y **`GET /api/v1/metrics`** no existen.
8. **Acumulados atómicos (RF-3):** `ResultsService.applyBallotToAggregates` está vacío; falta el script Lua.
9. **Ventana de difusión y recuperación (RF-4, RF-6):** `BroadcastService.dispatchWindowBatch` está vacío y
   `RecoveryService` devuelve un snapshot de texto fijo. Debe usar un Redis Stream por tópico con `MAXLEN`.
10. **`IdentityService`** guarda las sesiones en memoria del proceso: con varias instancias deben ir a Redis.
11. **Usuarios de demostración:** el mock agrega `auditor2` y `jury2` para mostrar bloqueos entre dos personas.
12. **Ocho instancias (RT-1, RT-2, RT-3):** la propuesta actual es de una sola instancia.
