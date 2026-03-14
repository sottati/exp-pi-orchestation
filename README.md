# pi-agent-core (MPV Multiagente)

Runtime de prueba para orquestación y delegación entre agentes usando `@mariozechner/pi-agent-core`.

## TL;DR

```bash
bun install
bun run start -- --session demo-1
```

Después, en la CLI:

```text
/use orchestrator
Necesito un snippet en C para imprimir del 1 al 10
/traces 20
/threads
```

## Qué incluye hoy

- Orquestador + especialistas (`code`, `math`) en runtime único.
- Toda delegación es async via chat (`delegate` tool). Sin sync path.
- Per-agent concurrency: cada especialista tiene `maxConcurrency` slots de chat.
- Chats con cola FIFO: si un agente está al máximo, los nuevos chats se encolan como `waiting`.
- Persistencia local de conversaciones por hilo (`threadId`), trazas de ejecución y chat records.
- Error handling robusto: JSONL fault-tolerant, hooks con `safeAsync`, guards en CLI/trace/persistence.
- Modelo configurable via `PI_MODEL_PROVIDER`/`PI_MODEL_ID` (default: `openrouter`/`openrouter/free`).
- Restauración automática de chats interrumpidos al reiniciar sesión.
- CLI interactiva para operar y testear sin UI.
- Gate de decisión para saber cuándo pasar a UI/monorepo.

## Configuración del modelo

Variables de entorno opcionales (Bun las carga automáticamente desde `.env`):

| Variable | Default | Descripción |
|---|---|---|
| `PI_MODEL_PROVIDER` | `openrouter` | Proveedor de LLM |
| `PI_MODEL_ID` | `openrouter/free` | ID del modelo |

## Requisitos

- [Bun](https://bun.com) 1.3+

## Instalación

```bash
bun install
```

## Scripts principales

```bash
bun run start
bun run typecheck
bun run smoke:math
bun run smoke:code
bun run smoke:orchestrator
bun run ui:gate
```

Con sesión específica:

```bash
bun run start -- --session test01
bun run ui:gate -- --session test01
```

## Comandos de la CLI

- `/help`
- `/agents`
- `/use <agentId>` (`orchestrator|code|math`)
- `/chats` (alias: `/jobs`)
- `/chat <chatId>` (aliases: `/job`, `/task`) — vista unificada (chat + trazas + mensajes)
- `/close <chatId>` (alias: `/cancel`)
- `/threads`
- `/thread <threadId>`
- `/traces [n]`
- `/smoke <math|code|orchestrator>`
- `/exit`

## Modelo de delegación: Chats

Cada delegación del orchestrator a un especialista crea un **chat** (`AgentChat`). El chat es la unidad de trabajo:

- `active`: el especialista está procesando
- `waiting`: encolado porque el agente está al máximo de concurrencia
- `closed`: terminado (con `closeReason`: `completed`, `failed`, o `cancelled`)

Cuando un chat activo se cierra, el siguiente en la cola del mismo agente pasa a `active`.

### Tools del orchestrator

| Tool | Descripción |
|------|-------------|
| `list_agents` | Lista especialistas con capacidades y slots |
| `delegate` | Envía tarea a especialista, retorna chatId |
| `delegate_task` | Alias legacy de `delegate` |
| `get_chat_status` | Estado de un chat por chatId |
| `get_chat_result` | Resultado de un chat completado |
| `close_chat` | Cierra un chat activo o en cola |

## Persistencia local

Los datos se guardan en:

```text
.runtime-data/<sessionId>/
```

Incluye:

- `threads/*.jsonl`: mensajes por hilo entre participantes.
- `traces.jsonl`: eventos de ejecución y delegación.
- `chats.jsonl`: snapshots de estado de chats (append-only, deduplicado por chatId al leer).

Las líneas corruptas en archivos JSONL se ignoran silenciosamente (fault-tolerant parsing).
Al reiniciar una sesión, los chats que estaban `active` o `waiting` se marcan como `closed` con error "Interrupted by runtime restart".

Cada envelope de hilo incluye metadatos de relación:

- `parentEnvelopeId`
- `replyToEnvelopeId`
- `runId`, `turnId`, `chatId?`, `toolCallId?`

## Flujo recomendado de prueba

1. Iniciar sesión limpia:

   ```bash
   bun run start -- --session test01
   ```

2. Ver agentes disponibles:

   ```text
   /agents
   ```

3. Pedir al orquestador una tarea de código:

   ```text
   /use orchestrator
   Pasame un snippet en C para imprimir del 1 al 10
   ```

4. Auditar delegación:

   ```text
   /traces 20
   /threads
   /thread test01::code<->orchestrator
   ```

5. Inspección por chat:

   ```text
   /chat <chatId>
   ```

## Estructura principal

- `src/index.ts`: CLI interactiva.
- `src/runtime.ts`: runtime multiagente, enrutado de mensajes, correlación de IDs y trazas.
- `src/tools.ts`: tools del orquestador (`list_agents`, `delegate`, `delegate_task`, `get_chat_status`, `get_chat_result`, `close_chat`).
- `src/chat-manager.ts`: gestión de chats con per-agent concurrency, cola FIFO, timeout/retry y persistencia a disco.
- `src/thread-store.ts`: persistencia JSONL de hilos, trazas y chat records.
- `src/errors.ts`: utilidades de error handling (`errorMessage`, `safeAsync`, `safeParseLine`).
- `src/contracts.ts`: contratos de `ThreadEnvelope`, `AgentChat`, `TraceEvent`.
- `src/agents.ts`: definición de agentes con lazy model init configurable por env vars.
- `src/ui-gate.ts`: evaluación de fricción para activar UI.

## Comportamientos esperados

- Para mensajes triviales, el orquestador puede responder sin delegar.
- Para tareas especializadas, debe aparecer `tool_start/tool_end` en `/traces`.
- Si no hay delegación, no verás eventos de `delegate` en la traza.

## Troubleshooting rápido

- **Respuestas fuera de contexto**: usa una sesión nueva (`--session`) para evitar historial previo.
- **No sé si delegó**: consulta `/traces 30` y busca `delegate`.
- **Quiero ver conversación interna entre agentes**: `/threads` y luego `/thread <id>`.
- **Quiero estado completo de un chat**: `/chat <chatId>`.

## Nota

Este repo está en modo MPV terminal-first. La UI se activa cuando el gate indique fricción operativa real (concurrencia, HITL frecuente o volumen alto de trazas).
