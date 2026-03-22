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

- Orquestador + especialistas (`code`, `math`, `explorer`) en runtime único.
- Toda delegación es async via chat (`delegate` tool). Sin sync path.
- Per-agent concurrency: cada especialista tiene `maxConcurrency` slots de chat.
- Chats con cola FIFO: si un agente está al máximo, los nuevos chats se encolan como `waiting`.
- Persistencia local de conversaciones por hilo (`threadId`), trazas de ejecución y chat records.
- Error handling robusto: JSONL fault-tolerant, hooks con `safeAsync`, guards en CLI/trace/persistence.
- Configuración de modelo por agente (`orchestrator`, `code`, `math`) via builder pattern en `packages/core/agents.ts`.
- Sistema extensible de agentes: agent builder, tool registry, tool middleware con permisos y HITL.
- Scheduler integrado: cron, one-time, delayed tasks con persistencia JSONL.
- Prompt compiler: ensamblado de system prompt en 5 capas (base, tools, delegation, rules, examples).
- Restauración automática de chats y scheduled jobs interrumpidos al reiniciar sesión.
- CLI interactiva para operar y testear sin UI, con HITL approval prompts.
- Gate de decisión para saber cuándo pasar a UI/monorepo.

## Configuración del modelo

Agentes definidos via builder pattern en `packages/core/agents.ts` usando `defineAgent()`.
Hoy, los cuatro agentes usan `openrouter/google/gemini-3.1-flash-lite-preview`.

| Agent ID | Provider | Model ID |
|---|---|---|
| `orchestrator` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `code` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `math` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `explorer` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |

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
bun run smoke:explorer
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

- **Barra de agentes**: botones para cambiar entre `orchestrator`, `code`, `math`, `explorer`.
- **Panel de mensajes**: conversación filtrada por agente activo, con streaming en tiempo real.
- **Panel de trazas**: últimas 50 trazas en tiempo real vía WebSocket.
- **WebSocket** en `/ws`: deltas de streaming, lifecycle de chats y push de trazas.
- **REST API**: `/api/agents`, `/api/chats`, `/api/threads`, `/api/traces`, `/api/jobs`.

La CLI (`bun run start`) y el servidor UI son entradas independientes que comparten `MultiAgentRuntime`.

## Comandos de la CLI

- `/help`
- `/agents`
- `/use <agentId>` (`orchestrator|code|math|explorer`)
- `/chats` (alias: `/jobs`)
- `/chat <chatId> [--json]` (aliases: `/job`, `/task`) — transcript live; con `--json` devuelve inspección raw
- `/close <chatId>` (alias: `/cancel`)
- `/scheduled [jobId]` — lista scheduled jobs o inspecciona uno
- `/cancel-job <jobId>` — cancela un scheduled job
- `/threads`
- `/thread <threadId>`
- `/traces [n]`
- `/smoke <math|code|orchestrator|explorer>`
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

5. Inspección por chat (live):

   ```text
   /chat <chatId>
   ```

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
- `packages/core/tools.ts`: tools del orquestador (`list_agents`, `delegate`, `delegate_task`, `get_chat_status`, `get_chat_result`, `close_chat`).
- `packages/core/agents.ts`: definición de agentes via builder pattern (`defineAgent()`).
- `packages/core/agent-builder.ts`: builder pattern para declarar agentes.
- `packages/core/tool-registry.ts`: registro y resolución de tools con glob patterns, ciclo de vida MCP.
- `packages/core/tool-middleware.ts`: `wrapTool` con permisos, HITL approval y hooks.
- `packages/core/prompt-compiler.ts`: compilador de system prompt en 5 capas.
- `packages/core/delegation.ts`: delegate tool con control de depth, whitelist y ciclos.
- `packages/core/scheduler.ts`: cron parser, timer basado en setTimeout, persistencia JSONL.
- `packages/core/scheduler-tools.ts`: tools de scheduling (`schedule_task`, `list_scheduled_jobs`, `cancel_scheduled_job`).
- `packages/core/mcp-client.ts`: interfaz `McpConnector` para servidores de tools externos.
- `packages/core/browser.ts`: wrapper de Playwright para `browseUrl`, `searchWeb`, `interactWithPage`.
- `packages/core/explorer-tools.ts`: tool entries del explorer (`browse_url`, `search_web`, `interact_page`).
- `packages/core/credential-store.ts`: almacenamiento cifrado AES-256-GCM de credenciales.
- `packages/core/chat-manager.ts`: gestión de chats con per-agent concurrency, cola FIFO, timeout/retry y persistencia a disco.
- `packages/core/thread-store.ts`: persistencia JSONL de hilos, trazas y chat records.
- `packages/core/errors.ts`: utilidades de error handling (`errorMessage`, `safeAsync`, `safeParseLine`).
- `packages/core/contracts.ts`: contratos de `ThreadEnvelope`, `AgentChat`, `TraceEvent`, `ScheduledJob`.

## Agent Builder Pattern

Los agentes se definen declarativamente:

```ts
import { defineAgent } from "./packages/core/agent-builder";

const agent = defineAgent("myAgent")
  .name("My Agent")
  .role("Does things")
  .model("openrouter", "google/gemini-3.1-flash-lite-preview")
  .systemPrompt("You are a helpful agent.")
  .capabilities(["cap1", "cap2"])
  .tools(["tool1", "tool2"])
  .permissions({ "tool1": "allow" })
  .maxConcurrency(1)
  .build();
```

## Tool Permissions & HITL

Las tools tienen un `defaultPermission`: `"allow"`, `"deny"`, o `"hitl"`.
Orden de resolución: runtime override → agent permissions → exact match → glob pattern → default.

Cuando el permiso resuelve a `"hitl"`, se llama al `HITLHandler` para pedir aprobación:

- **CLI**: prompt via readline en terminal
- **Web**: request/response via WebSocket con timeout configurable

## Scheduler

El runtime incluye un `Scheduler` para ejecución cron, one-time y delayed:

- Jobs persisten a JSONL y se restauran al reiniciar.
- Tools de agente: `schedule_task` (hitl), `list_scheduled_jobs` (allow), `cancel_scheduled_job` (hitl).
- Schedules configurables via `RuntimeOptions.schedules`.

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
