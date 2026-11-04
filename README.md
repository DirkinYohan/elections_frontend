# Preconteo electoral · Frontend

Frontend del taller **"Transmisión y difusión de resultados en una jornada electoral"**
(Programación Orientada a la Web). El enunciado está en `docs/caso-de-estudio.pdf` y el contrato
con el backend ([DirkinYohan/elections](https://github.com/DirkinYohan/elections)) en [`CONTRACT.md`](CONTRACT.md).

Son cuatro aplicaciones servidas por un solo proyecto Vite:

| Ruta | Audiencia | Transporte | Tecnología |
|---|---|---|---|
| `/results/` | Público (hasta 400.000) | **SSE** (y polling solo para medir) | TypeScript puro, sin React: ~10 KB comprimidos |
| `/poll-worker/` | Jurados (6.400) | **HTTP** idempotente + cola offline; WebSocket `/ws/juries` para avisos | React + IndexedDB + Service Worker |
| `/auditor/` | Auditores (120) | **WebSocket** `/ws/verification` | React |
| `/operations/` | Coordinador | WebSocket (observador) + `GET /metrics` | React |

## Cómo correrlo

Requisitos: Node 22 o superior.

```bash
npm install
npm run mock     # terminal 1: backend simulado en http://localhost:8080
npm run dev      # terminal 2: http://localhost:5173
```

Cuentas de demostración (contraseña `pass123`): `jury1`, `jury2`, `auditor1`, `auditor2`, `coordinator1`.

**Contra el backend real:** detén el mock y levanta Spring Boot en el puerto 8080. El proxy de Vite
envía `/api` y `/ws` a ese puerto. Lo que el backend todavía debe implementar está en
**"Pendientes para el backend"** al final de `CONTRACT.md`; mientras tanto, el frontend tolera los
estados que hoy devuelve (`ACCEPTED`, `SUSPICIOUS_FOR_VERIFICATION`).

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo con proxy a `localhost:8080` |
| `npm run build` | Chequeo de tipos y build de producción en `dist/` (una carpeta por app) |
| `npm run preview` | Sirve `dist/` (con el mismo proxy); necesario para probar el Service Worker |
| `npm test` | Pruebas unitarias (Vitest) |
| `npm run lint` | oxlint |
| `npm run mock` | Backend simulado que implementa `CONTRACT.md` |
| `npm run load -- --sse 20000` | Prueba de carga (ver abajo) |

## Arquitectura

```
src/
├── apps/
│   ├── results/        página pública: state.ts (reductor puro), view.ts (DOM), main.ts (transporte)
│   ├── poll-worker/    lib/queue.ts (máquina de estados), lib/db.ts (IndexedDB), store.ts (envío)
│   ├── auditor/        cola, panel del caso, avisos
│   └── operations/     métricas, presencia, controles de demostración
└── shared/
    ├── contracts/      messages.ts: tipos del contrato
    ├── api/            adaptadores HTTP: ningún componente llama a fetch directamente
    ├── transport/      SseClient, WsClient, backoff con jitter, comparación de IDs de stream
    ├── verification/   reductor y hook del WebSocket de verificación (auditor y coordinador)
    └── ui/             estilos base, login, utilidades de formato
mock-server/            backend simulado (Node + ws)
load-test/              prueba de carga reproducible (Node, varios procesos)
public/poll-worker/     Service Worker y manifiesto de la app del jurado
```

Toda la lógica que importa vive en funciones puras con pruebas (`*.test.ts`); los componentes solo presentan.

## Cómo cumple cada requisito el frontend

| Req. | Dónde | Cómo |
|---|---|---|
| **RF-1** Idempotencia | `poll-worker/lib/queue.ts`, `store.ts` | El `idem` se genera una vez por acta y versión y se guarda en IndexedDB **antes** del primer envío; todos los reintentos lo reutilizan. Cada estado tiene un mensaje inequívoco, incluido el reenvío ("Ya estaba registrada ✓ recibo …"). Si la app muere a mitad de un envío, el acta vuelve a la cola y se reenvía con el mismo `idem` |
| **RF-2** Correcciones | `BallotForm`, `results/state.ts` | "Corregir" crea la versión siguiente. En la página pública, un número solo baja dentro de un evento `correction`, que se muestra con su explicación |
| **RF-3** Atomicidad | backend | El frontend recibe los cuatro niveles ya consistentes; el mock imita el script Lua |
| **RF-4** Fan-out | mock, `results/view.ts` | Deltas agregados por ventana de 2 s con valores absolutos. El render agrupa los cambios en un `requestAnimationFrame` y solo toca los nodos que cambiaron |
| **RF-5** Tópicos | `results/main.ts` | Selector de departamento, municipio o puesto; el tópico va en la URL |
| **RF-6** Reconexión | `SseClient`, `results/main.ts` | El cliente guarda el último id (también en `sessionStorage`) y reconecta con `?lastEventId=`; el servidor reenvía lo perdido o manda un `snapshot`. Los eventos repetidos se descartan |
| **RF-7** Bloqueo exclusivo | `shared/verification/` | Token por adquisición, latido cada 10 s que solo renueva si hubo interacción real (`ActivityTracker`), cuenta regresiva y aviso antes de perder el caso. Liberar o resolver exige el token |
| **RF-8** Presencia | `operations/` | Lista en vivo por WebSocket con caso actual, tiempo trabajando, instancia y último latido |
| **RF-9** Clientes lentos | mock, `SseClient` | El servidor corta a quien acumula más de 256 KB pendientes; el cliente vuelve con su último id |
| **RF-10** Degradación y avalancha | `ballots.ts`, `backoff.ts` | `503` deja el acta en cola como "Aún NO registrada". Reconexión con backoff exponencial y full jitter (primera ventana de 5 s en la página pública); no se reconecta al evento `online` del navegador para no sincronizar a todos |
| **RT-5** Dos transportes | — | SSE (público), WebSocket (auditores) y HTTP (jurados) |
| **RT-6** Conexión intermitente | Service Worker + IndexedDB | La app abre sin red, guarda el acta en el teléfono y la envía sola al volver la red |
| **RT-7** Instrumentación | `/operations/` | Conexiones, mensajes/s, retraso del Event Loop (p99), memoria por conexión, actas/min, latencia recepción → publicación, reconexiones/s |
| **RT-8** Prueba de carga | `load-test/` | 20.000+ conexiones SSE en varios procesos, perfil de la jornada, gráfica con y sin jitter |
| **RT-9** INP | `results/?debug=1` | Medido con `web-vitals`; también en `window.__metrics.inp` |

## Mediciones (sección 7)

Medidas contra el servidor simulado en una sola máquina. **Repítanlas contra el despliegue real**
con los mismos comandos y reemplacen las cifras.

### SSE frente a polling (60 s, mismo tópico, navegador real)

| | SSE | Polling cada 2 s |
|---|---|---|
| Peticiones HTTP del cliente | 0 (una conexión abierta) | 30 |
| Mensajes recibidos / útiles | 24 / 24 | 30 / 24 (20 % sin cambios) |
| Bytes de cuerpo recibidos | 4.257 | 5.849 (sin contar ~500 B de cabeceras por petición) |
| Atraso entre publicación y pantalla | p50 1 ms · p95 2 ms | hasta 2 s (1 s en promedio) |
| Proyección a 400.000 clientes | 400.000 conexiones abiertas, mensajes solo cuando algo cambia | 200.000 peticiones/s permanentes, cambie o no |

Cómo repetirlo: abre `/results/?debug=1` y `/results/?transport=polling&debug=1` en paralelo y compara el panel de depuración.

### Fan-out y la trampa de escala

Prueba de 3.000 conexiones SSE y 300 actas: el público recibió **29.874 mensajes** frente a los
**900.000** de un mensaje por acta y por cliente: **30 veces menos**, gracias a la agregación por
ventana de 2 s y a que cada cliente solo recibe su tópico. Latencia publicación → recepción: p50 25 ms, p95 50 ms.

### Avalancha de reconexión (RF-10)

Se matan las 3.000 conexiones en el segundo 15:

| | Pico de reconexiones | Duración del regreso |
|---|---|---|
| Sin jitter | **3.000 en el mismo instante** | < 1 s |
| Con full jitter (ventana inicial 5 s) | **~612 por segundo** | 5 s, sin pérdidas |

```bash
node load-test/run.mjs --sse 3000 --duration 40 --kill-at 15 --jitter on  --out results/jitter-on.csv
node load-test/run.mjs --sse 3000 --duration 40 --kill-at 15 --jitter off --out results/jitter-off.csv
node load-test/report.mjs load-test/results/jitter-on.csv load-test/results/jitter-off.csv
```

El reporte HTML queda en `load-test/results/report.html`.

## Prueba de carga (RT-8)

```bash
node load-test/run.mjs --target http://localhost:8080 --sse 20000 --workers 4 --auditors 120 --duration 120
```

| Opción | Por defecto | Significado |
|---|---|---|
| `--target` | `http://localhost:8080` | Backend o balanceador (directo, sin Vite) |
| `--sse` | 20000 | Conexiones públicas, repartidas entre todos los tópicos |
| `--workers` | 4 | Procesos que las sostienen |
| `--auditors` | 120 | Conexiones WebSocket de auditores |
| `--duration` | 120 | Segundos. Las 300 actas siguen el perfil: 55 % en el primer tercio, 4–11 % de reenvíos con el mismo `idem` |
| `--kill-at` | 0 | Segundo en que se matan todas las conexiones (`/mock/kill`); contra el backend real, mata una instancia a mano en ese momento |
| `--jitter` | `on` | `off` para la curva sin jitter |
| `--base` | 5000 | Primera ventana de reconexión en ms |
| `--reset` / `--pause-sim` | `yes` | Reinicia el mock y pausa su simulador para que solo cuenten las actas de la prueba |

Al final imprime el total de mensajes frente a la cifra ingenua y escribe un CSV por segundo.

**Límites del sistema operativo para 20.000 conexiones:**

- **Linux:** `ulimit -n 65535` en la máquina que genera la carga y en el servidor.
- **Windows:** el rango de puertos efímeros por defecto es de ~16.000 por destino. Amplíalo como administrador con
  `netsh int ipv4 set dynamicport tcp start=10000 num=55000`, o reparte la carga entre dos máquinas.

## Guion de sustentación

Antes de empezar: `npm run mock` y `npm run dev`, o el despliegue real. Abre `/operations/` como `coordinator1` en una pantalla aparte.

1. **Tres audiencias, dos transportes (RT-5).** Abre `/results/`, `/auditor/` y `/poll-worker/`. Muestra en las DevTools (pestaña Red) el `EventStream` del público y el `WS` del auditor.
2. **Tópicos (RF-5).** Cambia de municipio y de puesto; la URL cambia y solo llegan eventos de ese tópico.
3. **Idempotencia (RF-1).** En operación, activa "Soltar 50 % de confirmaciones". Envía actas como `jury1`: algunas quedan "Sin confirmar todavía", se reintentan solas con el mismo `idem` y terminan en "Registrada ✓ — ya estaba registrada" con el **mismo recibo**.
4. **Conexión intermitente (RT-6).** En DevTools pon el jurado en *Offline*, llena y guarda un acta: queda en cola. Recarga la página sin red: la app abre igual. Vuelve a *Online*: se transmite sola. (El Service Worker solo funciona con `npm run build && npm run preview`.)
5. **Correcciones (RF-2).** En "Mis actas" pulsa "Corregir" con otros números. En el público aparece "Acta corregida … versión 1 → 2" y el valor que baja se resalta.
6. **Verificación (RF-7).** Abre `/auditor/` como `auditor1` y, en otra ventana privada, como `auditor2`. Uno toma un caso: el otro lo ve bloqueado al instante. Deja de mover el mouse: aparece el aviso y a los 30 s el caso vuelve a la cola. Cierra la pestaña del que tiene un caso: vuelve solo.
7. **Liberación segura.** Con `auditor1` revisando un caso, ponlo *Offline* en DevTools. A los 30 s el caso vuelve a la cola y `auditor2` lo toma. Al volver la red, `auditor1` recibe el aviso de que perdió el caso y ya no puede resolverlo: su token viejo no coincide con el del nuevo dueño y el servidor respondería `LOCK_NOT_OWNED` (lo prueban `reducer.test.ts` y el mock).
8. **Presencia (RF-8).** En operación se ven los auditores, su caso y el tiempo trabajando. Cierra una pestaña sin cerrar sesión: desaparece al vencer su latido.
9. **Reconexión (RF-6).** En el público con `?debug=1`, pulsa "Matar todas las conexiones": vuelve con su último id, recibe solo lo perdido y los números coinciden con otra pestaña que nunca se desconectó.
10. **Degradación (RF-10).** "Simular caída de Redis": el jurado ve "Aún NO registrada · sistema degradado" (nunca un falso éxito), el público deja de recibir cambios sin romperse. Restaura y todo continúa.
11. **Avalancha (RF-10).** Muestra `load-test/results/report.html` con las dos curvas.
12. **Fan-out y Event Loop (RF-4, RT-4).** Pulsa "Simular el pico (×8)" y muestra en operación el retraso del Event Loop y los mensajes por segundo.
13. **INP (RT-9).** En el público con `?debug=1` y la CPU limitada ×6 en DevTools, interactúa con el selector y lee el INP.

## Despliegue (RT-10)

`npm run build` genera archivos estáticos en `dist/`. Sírvelos con Nginx delante del balanceador del backend:

```nginx
location /api/v1/stream {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;          # SSE: entregar cada evento de inmediato
    proxy_read_timeout 1h;
}
location /ws/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
location /api/ { proxy_pass http://backend; }
location / { root /var/www/elections/dist; try_files $uri $uri/ =404; }
```

Sin sesiones pegajosas (RT-2): ningún cliente depende de volver a la misma instancia. El id de continuidad
del público, el token del bloqueo del auditor y el `idem` del jurado viajan en cada petición y se validan contra Redis.
