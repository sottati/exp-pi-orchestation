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
- Delegación síncrona (`delegate_task_sync`) y asíncrona (`delegate_task_async`).
- Persistencia local de conversaciones por hilo (`threadId`), trazas de ejecución y task records.
- Error handling robusto: JSONL fault-tolerant, hooks con `safeAsync`, guards en CLI/trace/persistence.
- Modelo configurable via `PI_MODEL_PROVIDER`/`PI_MODEL_ID` (default: `openrouter`/`openrouter/free`).
- Restauración automática de tasks interrumpidas al reiniciar sesión.
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
- `/jobs`
- `/job <jobId>`
- `/task <taskId|jobId>` vista unificada (job + trazas + mensajes relacionados)
- `/cancel <jobId>`
- `/threads`
- `/thread <threadId>`
- `/traces [n]`
- `/smoke <math|code|orchestrator>`
- `/exit`

## Persistencia local

Los datos se guardan en:

```text
.runtime-data/<sessionId>/
```

Incluye:

- `threads/*.jsonl`: mensajes por hilo entre participantes.
- `traces.jsonl`: eventos de ejecución y delegación.
- `tasks.jsonl`: snapshots de estado de tasks async (append-only, deduplicado por jobId al leer).

Las líneas corruptas en archivos JSONL se ignoran silenciosamente (fault-tolerant parsing).
Al reiniciar una sesión, las tasks que estaban `queued` o `running` se marcan como `failed` ("Interrupted by runtime restart").

Cada envelope de hilo incluye metadatos de relación:

- `parentEnvelopeId`
- `replyToEnvelopeId`
- `runId`, `turnId`, `taskId?`, `toolCallId?`

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

5. Inspección por tarea:

   ```text
   /task <taskId|jobId>
   ```

## Estructura principal

- `src/index.ts`: CLI interactiva.
- `src/runtime.ts`: runtime multiagente, enrutado de mensajes, correlación de IDs y trazas.
- `src/tools.ts`: tools del orquestador (`list_agents`, `delegate_task_sync`, `delegate_task_async`, `get_task_status`, `get_task_result`, `cancel_task`).
- `src/task-manager.ts`: gestión de jobs async con timeout/retry/cancel y persistencia a disco.
- `src/thread-store.ts`: persistencia JSONL de hilos, trazas y task records.
- `src/errors.ts`: utilidades de error handling (`errorMessage`, `safeAsync`, `safeParseLine`).
- `src/contracts.ts`: contratos de `ThreadEnvelope`, `TaskRecord`, `TraceEvent`.
- `src/agents.ts`: definición de agentes con lazy model init configurable por env vars.
- `src/ui-gate.ts`: evaluación de fricción para activar UI.

## Comportamientos esperados

- Para mensajes triviales, el orquestador puede responder sin delegar.
- Para tareas especializadas, debe aparecer `tool_start/tool_end` en `/traces`.
- Si no hay delegación, no verás eventos de `delegate_task_*` en la traza.

## Troubleshooting rápido

- **Respuestas fuera de contexto**: usa una sesión nueva (`--session`) para evitar historial previo.
- **No sé si delegó**: consulta `/traces 30` y busca `delegate_task_sync` o `delegate_task_async`.
- **Quiero ver conversación interna entre agentes**: `/threads` y luego `/thread <id>`.
- **Quiero estado completo de una tarea**: `/task <taskId|jobId>`.

## Nota

Este repo está en modo MPV terminal-first. La UI se activa cuando el gate indique fricción operativa real (concurrencia, HITL frecuente o volumen alto de trazas).
