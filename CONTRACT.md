# Contrato frontend ↔ backend

Fuente de verdad de los tipos: `src/shared/contracts/messages.ts`.
Cualquier cambio en este documento debe acordarse entre frontend y backend antes de implementarse.

## 1. Jurados · HTTP

### `POST /api/actas`

Cuerpo: el JSON de la sección 3.1 del caso de estudio (`TallySheet`). El campo `idem` lo genera
el cliente **una sola vez** por acta + versión y lo reutiliza en todos los reenvíos.

Respuesta (`SubmitResponse`):

| `status` | HTTP | Significado | Qué hace el cliente |
|---|---|---|---|
| `REGISTERED` | 201 | Guardada y sumada al acumulado | Marca el acta como confirmada |
| `DUPLICATE` | 200 | Ya estaba guardada; mismo `receipt` que la primera vez | Marca el acta como confirmada |
| `SUPERSEDED` | 200 | Guardada, pero ya hay una versión más nueva aplicada | Marca como confirmada e informa |
| `DOUBTFUL` | 202 | Guardada, no cuadra la regla contable, va a verificación | Informa al jurado |
| `REJECTED` | 422 | Datos inválidos, no se guardó | Muestra `reason` para corregir |
| `UNAVAILABLE` | 503 | Sistema degradado (Redis caído). **No se guardó** | Deja el acta en la cola y reintenta |

Regla: el backend **nunca** responde éxito si no persistió el acta. Si el servidor cae entre
guardar y responder, el reintento llega con el mismo `idem` y recibe `DUPLICATE` con el recibo original.

## 2. Público · SSE

### `GET /api/stream?topic=<topic>&lastEventId=<id>`

- `topic`: `department`, `municipality:<id>` o `station:<id>`.
- `lastEventId`: último `id` procesado por el cliente. También se acepta la cabecera estándar `Last-Event-ID`.
- El `id` de cada evento es el **ID del Redis Stream** del tópico (`<ms>-<seq>`), monótono.

Formato de cada evento:

```
id: 1793577600123-0
event: delta
data: {"type":"delta","topic":"municipality:11","changes":{...},"at":1793577600123}
```

| Evento | Cuándo | Contenido |
|---|---|---|
| `snapshot` | Primera conexión, tópico nuevo, o `lastEventId` fuera de la ventana de retención | Estado completo (`totals`) e `instanceId` |
| `delta` | Una vez por ventana de agregación (≈2 s) si el tópico cambió | `changes` con los **valores absolutos nuevos** de lo que cambió |
| `correction` | Igual que `delta`, cuando en la ventana hubo actas corregidas | `changes` + lista `corrections` que explica por qué un número bajó |

Reconexión: si `lastEventId` está dentro de la ventana retenida, el servidor reenvía los eventos
posteriores a ese id; si no, envía un `snapshot`. Un cliente lento cuyo búfer supere el umbral
se desconecta y vuelve con su `lastEventId` (RF-9).

## 3. Auditores · WebSocket

### `/ws/auditor?name=<nombre>`

Mensajes JSON con un campo `type`. Ver `AuditorClientMessage` y `AuditorServerMessage`.

| Cliente → servidor | Uso |
|---|---|
| `take_case` | Pedir el bloqueo de un caso |
| `heartbeat` | Cada 10 s. `active: true` si el auditor interactuó desde el latido anterior; solo esos renuevan el bloqueo |
| `resolve_case` | Resolver con el `lockToken` recibido; el servidor verifica que siga siendo el dueño |
| `release_case` | Devolver el caso a la cola, también con `lockToken` |

| Servidor → cliente | Uso |
|---|---|
| `welcome` | `auditorId`, `instanceId` y la duración del bloqueo (`lockTtlMs`) |
| `queue_snapshot` | Cola completa al conectar |
| `case_added` / `case_locked` / `case_released` / `case_resolved` | Cambios de la cola, a todas las consolas |
| `take_rejected` | El caso ya lo tiene otro auditor |
| `presence` | Lista de auditores conectados, en qué caso están y desde cuándo |
| `error` | `LOCK_NOT_OWNED` si se intenta resolver o liberar un bloqueo ajeno o expirado; `ALREADY_HOLDING_CASE` si el auditor ya tiene otro caso; `CASE_NOT_FOUND`; `BAD_MESSAGE` |

Un auditor trabaja un solo caso a la vez. Al cerrarse la conexión el bloqueo **no** se libera de
inmediato: expira solo si ningún latido activo lo renueva dentro de `lockTtlMs`.

Códigos de cierre: `4000` = reconectar con jitter (sobrecarga o cliente lento), `4401` = no autorizado, no reconectar.
