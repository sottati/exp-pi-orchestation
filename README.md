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
- Identidad conversacional estable por `sessionId` + par de agentes (`conversationId`), reutilizada en delegaciones sucesivas.
- Persistencia local de conversaciones por hilo (`threadId`), trazas de ejecución y chat records.
- Ventana de contexto configurable por runtime (`historyWindowMessages`, default `50`) sin recortar historial persistido.
- Ingreso unificado de mensajes (`runtime.chat`) para origen humano e intra-agente, con soporte de subscripción a eventos de generación (`onAgentEvent`) en ambos casos.
- Especialistas reactivos por defecto; solo reportan al orchestrator via `report_to_orchestrator` cuando se pide explícitamente.
- Error handling robusto: JSONL fault-tolerant, hooks con `safeAsync`, guards en CLI/trace/persistence.
- Configuración de modelo por agente (`orchestrator`, `code`, `math`) en `packages/core/agents.ts`.
- Restauración automática de chats interrumpidos al reiniciar sesión.
- CLI interactiva para operar y testear sin UI.
- Gate de decisión para saber cuándo pasar a UI/monorepo.

## Configuración del modelo

Configuración explícita por agente en `packages/core/agents.ts` (`AGENT_MODEL_CONFIG`).
Hoy, los tres agentes usan `openrouter/google/gemini-3.1-flash-lite-preview`.

| Agent ID | Provider | Model ID |
|---|---|---|
| `orchestrator` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `code` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `math` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |

## Requisitos

- [Bun](https://bun.com) 1.3+

## Instalación

```bash
bun install
```

## Scripts principales

```bash
bun run start
bun run ui
bun test
bun run typecheck
bun run smoke:math
bun run smoke:code
bun run smoke:orchestrator
bun run ui:gate
```

Con sesión específica:

```bash
bun run start -- --session test01
bun run ui -- --session test01
bun run ui:gate -- --session test01
```

## UI web

```bash
bun run ui -- --session demo-1
```

Abre http://localhost:3000 para ver la interfaz web:

- **Barra de agentes**: botones para cambiar entre `orchestrator`, `code`, `math`.
- **Panel de mensajes**: conversación filtrada por agente activo, con streaming en tiempo real.
- **Panel de trazas**: últimas 50 trazas en tiempo real vía WebSocket.
- **WebSocket** en `/ws`: deltas de streaming, lifecycle de chats y push de trazas.
- **REST API**: `/api/agents`, `/api/chats`, `/api/threads`, `/api/traces`.

La CLI (`bun run start`) y el servidor UI son entradas independientes que comparten `MultiAgentRuntime`.

## Comandos de la CLI

- `/help`
- `/agents`
- `/use <agentId>` (`orchestrator|code|math`)
- `/chats` (alias: `/jobs`)
- `/chat <chatId> [--json]` (aliases: `/job`, `/task`) — transcript live agrupado por turn (`runId`/`turnId`); con `--json` devuelve inspección raw
- `/close <chatId>` (alias: `/cancel`)
- `/threads`
- `/thread <threadId>`
- `/traces [n]`
- `/smoke <math|code|orchestrator>`
- `/exit`

## Modelo de delegación: Chats

Cada delegación del orchestrator a un especialista crea o continúa un **chat** (`AgentChat`). El chat es la unidad de trabajo:

- `chatId`: unidad efímera de ejecución (una delegación concreta).
- `conversationId`: identidad lógica estable por sesión + par de agentes (ej: `demo::code<->orchestrator`).

- `active`: el especialista está procesando
- `waiting`: encolado porque el agente está al máximo de concurrencia
- `closed`: terminado (con `closeReason`: `completed`, `failed`, o `cancelled`)
- `keepAlive` (opcional): mantiene el chat `active` tras una respuesta y procesa follow-ups en orden dentro del mismo `chatId`

Cuando un chat activo se cierra, el siguiente en la cola del mismo agente pasa a `active`.
Política de cierre/reapertura: mientras exista un chat `active` keepAlive para la misma conversación, `delegate` continúa ese `chatId`; si no existe, crea uno nuevo con el mismo `conversationId`.

### Tools del orchestrator

| Tool | Descripción |
|------|-------------|
| `list_agents` | Lista especialistas con capacidades y slots |
| `delegate` | Crea o continúa delegación al especialista, retorna chatId |
| `delegate_task` | Alias legacy de `delegate` |
| `follow_up_chat` | Envía follow-up explícito a chat keepAlive abierto |
| `get_chat_status` | Estado de un chat por chatId |
| `get_chat_result` | Resultado final o último resultado en chat keepAlive |
| `close_chat` | Cierra un chat activo o en cola |

### Tool de especialistas

| Tool | Descripción |
|------|-------------|
| `report_to_orchestrator` | Reporte explícito de especialista al orchestrator (solo cuando el usuario lo pide) |

## Persistencia local

Los datos se guardan en:

```text
.runtime-data/<sessionId>/
```

Incluye:

- `threads/*.jsonl`: mensajes por hilo entre participantes.
- `traces.jsonl`: eventos de ejecución y delegación.
- `chats.jsonl`: snapshots de estado de chats (append-only, deduplicado por chatId al leer).
- Cada chat persistido incluye `conversationId` para correlación estable entre delegaciones.

Las líneas corruptas en archivos JSONL se ignoran silenciosamente (fault-tolerant parsing).
Al reiniciar una sesión, los chats que estaban `active` o `waiting` se marcan como `closed` con error "Interrupted by runtime restart".
La política es explícita y determinística: no hay auto-resume de ejecución interrumpida, las colas activas se reconstruyen limpias, y un `close` posterior sobre esos chats ya cerrados no re-persista estados.

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

5. Inspección por chat (live):

   ```text
   /chat <chatId>
   ```

   La vista live imprime encabezados por turn (`runId`/`turnId`) y luego los mensajes del turn en orden.

   Inspección raw JSON:

   ```text
   /chat <chatId> --json
   ```

## Estructura principal

- `apps/cli/index.ts`: CLI interactiva.
- `apps/backend/server.ts`: servidor web con REST + WebSocket.
- `apps/backend/ui-gate.ts`: evaluación de fricción para activar UI.
- `apps/web/index.html`: shell HTML de la UI.
- `apps/web/app.tsx`: SPA React (estado local + streaming).
- `apps/web/app.css`: estilos de la UI.
- `packages/core/runtime.ts`: runtime multiagente, enrutado de mensajes, correlación de IDs y trazas.
- `packages/core/tools.ts`: tools del orquestador (`list_agents`, `delegate`, `delegate_task`, `follow_up_chat`, `get_chat_status`, `get_chat_result`, `close_chat`) y tool de especialista (`report_to_orchestrator`).
- `packages/core/chat-manager.ts`: gestión de chats con per-agent concurrency, cola FIFO, timeout/retry, loop multi-turn opcional (`keepAlive`) y persistencia a disco.
- `packages/core/thread-store.ts`: persistencia JSONL de hilos, trazas y chat records.
- `packages/core/errors.ts`: utilidades de error handling (`errorMessage`, `safeAsync`, `safeParseLine`).
- `packages/core/contracts.ts`: contratos de `ThreadEnvelope`, `AgentChat`, `TraceEvent`.
- `packages/core/agents.ts`: definición de agentes con configuración de modelo por agente.

## Comportamientos esperados

- Para mensajes triviales, el orquestador puede responder sin delegar.
- Para tareas especializadas, debe aparecer `tool_start/tool_end` en `/traces`.
- Si no hay delegación, no verás eventos de `delegate` en la traza.
- El especialista `math` responde corto por defecto (solo resultado, salvo pedido de pasos).

## Troubleshooting rápido

- **Respuestas fuera de contexto**: usa una sesión nueva (`--session`) para evitar historial previo.
- **No sé si delegó**: consulta `/traces 30` y busca `delegate`.
- **Quiero ver conversación interna entre agentes**: `/threads` y luego `/thread <id>`.
- **Quiero estado completo raw de un chat**: `/chat <chatId> --json`.
- **Veo `(sin texto)` o respuesta vacía**: revisa `/thread <id>`; si hay `Model error: ...` suele ser rate-limit/cuota del proveedor.

## Nota

Este repo está en modo MPV terminal-first. La UI se activa cuando el gate indique fricción operativa real (concurrencia, HITL frecuente o volumen alto de trazas).
