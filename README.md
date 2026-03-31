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

- Orquestador + especialistas (`code`, `math`, `explorer`, `writer`, `debugger`, `secretary`, `web-designer`, `marketing`) en runtime único.
- Toda delegación es async via chat (`delegate` tool). Sin sync path.
- Per-agent concurrency: cada especialista tiene `maxConcurrency` slots de chat.
- Chats con cola FIFO: si un agente está al máximo, los nuevos chats se encolan como `waiting`.
- Persistencia local de conversaciones por hilo (`threadId`), trazas de ejecución y chat records.
- Error handling robusto: JSONL fault-tolerant, hooks con `safeAsync`, guards en CLI/trace/persistence.
- Configuración de modelo por agente (`orchestrator`, `code`, `math`) via builder pattern en `packages/core/agents.ts`.
- Sistema extensible de agentes: agent builder, tool registry, tool middleware con permisos y HITL.
- Captura segura de credenciales: el `orchestrator` puede solicitar claves por HITL (`request_credentials`) y guardarlas cifradas en `CredentialStore`.
- Office tools: `read_excel`/`write_excel` (exceljs) para el agente math/analyst; `read_docx`/`write_docx` (mammoth + docx) para el agente writer.
- Google Workspace integration: Sheets, Docs, Drive, Gmail, Calendar, Tasks — autenticación OAuth2 via `googleapis`.
- Agente `secretary`: asistente personal para calendar, email, contactos internos, tareas y cron jobs.
- Contactos internos del `secretary`: libreta local persistida en `.runtime-data/secretary-contacts.json` (listar, leer, buscar, crear, eliminar).
- Scheduler integrado: cron, one-time, delayed tasks con persistencia JSONL (scheduler tools migrados al agente `secretary`).
- Prompt compiler: ensamblado de system prompt en 5 capas (base, tools, delegation, rules, examples).
- Skills layer local: cada agente puede usar `.skills(...)` y el runtime auto-inyecta contexto desde `SKILL.md` en `./skills` según relevancia por turno.
- Restauración automática de chats y scheduled jobs interrumpidos al reiniciar sesión.
- CLI interactiva para operar y testear sin UI, con HITL approval prompts.
- Gate de decisión para saber cuándo pasar a UI/monorepo.
- Workspace manager local (`workspace_*`): registro de repos/workspaces, workspace activo y roots permitidos.
- Git/GitHub tools para `code` y `web-designer`: `git_*` + `github_*` (create/merge PR via `gh`) con HITL en operaciones mutables.

## Configuración del modelo

Agentes definidos via builder pattern en `packages/core/agents.ts` usando `defineAgent()`.
Hoy, los nueve agentes usan `openrouter/google/gemini-3.1-flash-lite-preview`.

| Agent ID | Provider | Model ID |
|---|---|---|
| `orchestrator` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `code` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `math` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `explorer` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `writer` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `debugger` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `secretary` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `web-designer` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `marketing` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |
| `graphic-designer` | `openrouter` | `google/gemini-3.1-flash-lite-preview` |

## Requisitos

- [Bun](https://bun.com) 1.3+
- [Git](https://git-scm.com/) instalado y disponible en `PATH`
- Dependencias de Office tools: `exceljs`, `mammoth`, `docx` (instaladas via `bun install`)
- Google Workspace: `googleapis` (instalada via `bun install`); requiere credenciales OAuth2 (ver sección Google Auth)
- Explorer web: iniciar servicios de soporte con `docker compose up searxng pi-browse-service -d` (o levantar el stack completo con `docker compose up --build -d`)
- Explorer web: requiere salida a internet (DNS + HTTPS) desde el host
- Explorer web: `SEARXNG_URL=http://localhost:8080` (default) y `BROWSE_SERVICE_URL=http://localhost:8001` (default)
- Explorer web: `OPENROUTER_API_KEY` requerido para `interact_page` (browser-use LLM)
- Explorer web: `BROWSE_LLM_MODEL` opcional para overridear el modelo LLM de browser-use
- Explorer web: si `interact_page` falla, revisar logs de backend con prefijos `[browser]`, `[tool-error]` y logs del microservicio `pi-browse-service` (ahora incluyen stack traces y contexto del endpoint)
- Para PRs desde agentes: [GitHub CLI (`gh`)](https://cli.github.com/) autenticado (`gh auth login`)
- Marketing: env var `MARKETING_SHEET_ID` o CredentialStore dominio `"marketing"` con el ID de la hoja de Google Sheets usada por `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`
- Graphic designer: env vars `GEMINI_API_KEY`, `CANVA_API_KEY`, `FIGMA_ACCESS_TOKEN` o CredentialStore dominios `"gemini"` (field: `apiKey`), `"canva"` (field: `apiKey`), `"figma"` (field: `accessToken`)

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
bun run smoke:writer
bun run smoke:debugger
bun run smoke:web-designer
bun run smoke:marketing
bun run smoke:graphic-designer
bun run ui:gate
```

## Deploy con Docker Compose (Oracle VM)

Levantar backend + servicios de explorer:

```bash
docker compose up --build -d
```

Ver logs del backend:

```bash
docker compose logs -f pi-backend
```

Apagar stack:

```bash
docker compose down
```

Notas:

- El estado persistente del runtime queda en `./.runtime-data` (bind mount a `/app/.runtime-data`).
- `searxng` y `pi-browse-service` quedan publicados solo en loopback (`127.0.0.1`) para reducir exposicion.
- Si `3000` ya esta ocupado, usa otro puerto para el backend: `PI_BACKEND_PORT=3001 docker compose up --build -d`.

Nginx reverse proxy (Oracle VM):

- Template listo: `deploy/nginx/pi-agent.conf`
- Copiar y habilitar en Ubuntu:

```bash
sudo cp deploy/nginx/pi-agent.conf /etc/nginx/sites-available/pi-agent.conf
sudo ln -s /etc/nginx/sites-available/pi-agent.conf /etc/nginx/sites-enabled/pi-agent.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

- HTTPS con Certbot:

```bash
sudo certbot --nginx -d tu-dominio.com -d www.tu-dominio.com
```

Con sesión específica:

```bash
bun run start -- --session test01
bun run ui -- --session test01
bun run ui:gate -- --session test01
```

## UI web — Dithie Dashboard

```bash
bun run ui -- --session demo-1
```

Abre <http://localhost:3000> para ver el dashboard de Dithie:

- **Estética Sacred-inspired**: paleta derivada del sistema de tokens de `sacred.computer`, con tema dark por defecto, superficies/contrastes terminales y fuente JetBrains Mono.
- **Dithie**: pixel-art spider (16x16) como identidad del orchestrator, con estados animados (idle, thinking, delegating, error).
- **Chat unificado**: toda la conversación pasa por Dithie (orchestrator). Las delegaciones se muestran como bloques colapsables inline.
- **Anclaje de envío**: al enviar un mensaje en el chat principal (`/`), cuando comienza el streaming de Dithie ese mensaje del usuario se alinea cerca del tope del contenedor (smooth) y al finalizar el stream no hace salto automático al fondo.
- **Thinking inline**: el chat consume `thinking_start/delta/end` en tiempo real y los muestra completos dentro del feed para debugging del reasoning. El bloque usa una presentacion flotante, con icono/loader de estado, etiqueta `thinking`, y un titulo extraido de la primera linea si viene como heading markdown; headings markdown posteriores tambien se resaltan dentro del cuerpo. El bloque permanece visible mientras streamea la respuesta final. `stream_status` queda como fallback cuando no llega thinking del modelo.
- **Thinking persistente**: al recargar (F5/Ctrl+R), el bloque de thinking se reconstruye desde mensajes persistidos del orchestrator (`assistant.content[type=thinking]`) con fallback a trazas.
- **React Router**: la UI usa layout persistente + rutas para `/`, `/traces`, `/agents`, `/chats` y `/jobs`.
- **Tailwind UI**: el layout y los componentes usan utilidades Tailwind; `app.css` quedó como capa global de tokens, tema y animaciones, y se compila a `apps/web/app.generated.css`.
- **Antes del primer token**: fila compacta con la mascota y la etiqueta `thinking` (sin burbuja vacía); al empezar el stream aparece la burbuja con el cursor.
- **HITL en UI**: cuando una tool requiere aprobación, aparece un modal con `Allow` / `Don't Allow` y atajos `y` / `n`.
- **Panel de trazas**: trazas en tiempo real (newest-last) con items expandibles y duración calculada client-side.
- **Reload seguro**: al refrescar con F5/Ctrl+R, la UI rehidrata chat, delegaciones, trazas, chats internos y jobs persistidos de la sesión activa.
- **Layout del chat**: la barra de entrada vive dentro del panel izquierdo en `/`, por lo que la columna derecha de TRACES llega hasta el borde inferior de la pantalla.
- **Color por agente**: la vista `/agents` asigna un tinte específico a cada agente usando una paleta compatible con Sacred.
- **Theme switcher**: la barra de navegación permite alternar entre dark/light y persiste la preferencia en `localStorage`.
- **WebSocket** en `/ws`: deltas de streaming, delegation events (`delegation_start`/`delegation_end`), lifecycle de chats y push de trazas.
- **HITL en UI**: cuando una tool requiere aprobación, aparece un modal con `Allow` / `Don't Allow` y atajos `y` / `n`. Para `request_credentials`, el modal muestra inputs (incluyendo campos `password`) y envía `modifiedParams` sin exponer valores en chat/trazas. El timeout empieza recién cuando la UI confirma recepción (`hitl_seen`), evitando timeouts “silenciosos” sin modal.
- **HITL + delegación**: mientras una delegación está esperando aprobación HITL, el runtime pausa el timeout del chat delegado para evitar fallos prematuros.
- **HITL + delegación (multi-step)**: si una misma delegación entra en varias aprobaciones HITL, el timeout acumula correctamente el tiempo restante entre cada `pause/resume` para evitar cancelaciones falsas.
- **Timeouts de delegación**: por defecto los chats delegados usan `180s`; `explorer`, `web-designer` y `marketing` usan `300s` por sus flujos web más largos.
- **Diagnóstico HITL (server logs)**: el backend imprime `"[hitl] request ... delivered=..."`, respuestas y timeouts para depurar por qué no aparece el modal.
- **Acceso local con HITL**: Dithie/orchestrator puede usar `read_file`, `search_code` y `list_directory` sobre paths locales del PC, siempre con aprobación humana.
- **Terminal con HITL**: Dithie/orchestrator puede ejecutar comandos via `run_command` en modo `powershell` o `bash`, con aprobación humana en cada ejecución.
- **REST API**: `/api/agents`, `/api/agents/:id/activity`, `/api/chats`, `/api/threads`, `/api/traces`, `/api/jobs`.
- **REST API**: `/api/agents`, `/api/agents/:id/activity`, `/api/chats`, `/api/threads`, `/api/traces`, `/api/ui-state`, `/api/jobs`.
- **Fallback SPA**: el servidor web sirve el HTML base en las rutas cliente (`/chat`, `/traces`, `/agents`, `/chats`, `/jobs`) para soportar deep-linking y refresh.

La CLI (`bun run start`) y el servidor UI son entradas independientes que comparten `MultiAgentRuntime`.

## Comandos de la CLI

- `/help`
- `/agents`
- `/use <agentId>` (`orchestrator|code|math|explorer|writer|debugger|secretary|web-designer|marketing`)
- `/chats` (alias: `/jobs`)
- `/chat <chatId> [--json]` (aliases: `/job`, `/task`) — transcript live; con `--json` devuelve inspección raw
- `/close <chatId>` (alias: `/cancel`)
- `/scheduled [jobId]` — lista scheduled jobs o inspecciona uno
- `/cancel-job <jobId>` — cancela un scheduled job
- `/threads`
- `/thread <threadId>`
- `/traces [n]`
- `/smoke <math|code|orchestrator|explorer|writer|debugger>`
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
| `read_file` | Lee un archivo local con numeración de líneas (HITL) |
| `search_code` | Busca texto en archivos dentro de un directorio local (HITL) |
| `list_directory` | Lista archivos/subdirectorios de un path local (HITL) |
| `run_command` | Ejecuta comandos en terminal (directo o shell `powershell`/`bash`) con HITL |
| `request_credentials` | Solicita claves al usuario via HITL y las guarda cifradas por dominio |

### Workspaces + Git (code/web-designer)

`code` y `web-designer` ahora tienen:

- `workspace_roots`, `workspace_list`, `workspace_get_active`
- `workspace_register` (HITL), `workspace_set_active` (HITL)
- `git_status`, `git_diff`, `git_log`, `git_list_branches`, `git_fetch`
- `git_checkout_branch`, `git_add`, `git_commit`, `git_pull`, `git_push`, `git_merge_branch` (HITL)
- `github_create_pr`, `github_merge_pr` (HITL, vía `gh`)

Comportamiento de alcance:

- Por defecto, el runtime permite toda la PC (sin roots restringidos).
- Si definís `WORKSPACE_ALLOWED_ROOTS`, el acceso queda limitado a esos roots.
- Formato:
  - Windows: `WORKSPACE_ALLOWED_ROOTS=C:\\repos;D:\\work`
  - Linux/macOS: `WORKSPACE_ALLOWED_ROOTS=/home/me/repos:/srv/work`

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
- `apps/web/index.html`: shell HTML de la UI (title "dithie", JetBrains Mono font).
- `apps/web/app.tsx`: entrypoint React que monta `RouterProvider` + `RuntimeProvider`.
- `apps/web/runtime-context.tsx`: estado global de la UI, hidratación desde `/api/ui-state`, conexión WebSocket, acciones compartidas y cola HITL.
- `apps/web/layouts/dashboard-layout.tsx`: shell persistente con header y navegación, más modal global de aprobaciones.
- `apps/web/pages/*.tsx`: páginas de router para chat, trazas, agentes, chats y jobs.
- `apps/web/components/chat-panel.tsx`: compositor del feed principal del chat.
- `apps/web/components/ui/chat-*.tsx`: componentes presentacionales del chat (input, mensajes, thinking, delegaciones).
- `apps/web/components/*.tsx`: componentes reutilizables para navegación y trazas.
- `apps/web/app.css`: capa global de Tailwind + tokens/tema inspirados en Sacred.
- `apps/web/app.generated.css`: CSS compilado de Tailwind que consume la HTML servida por Bun.
- `components.json`: configuración de shadcn/ui adaptada a esta estructura para que futuras altas de componentes apunten a `apps/web`.
- `apps/web/lib/agent-colors.ts`: mapeo de tintes por agente y badges de estado.
- `apps/web/lib/utils.ts`: helper `cn()` para composición de clases.
- `apps/web/types.ts`, `apps/web/sidebar.tsx`, `apps/web/sidebar-spider.tsx`, `apps/web/agent-view.tsx`: trabajo previo de vistas por agente conservado en la branch para iteraciones futuras.
- `apps/web/dithie-sprite.tsx`: componente DithieSprite (CSS Grid 16/32px, canvas 64px, animaciones).
- `apps/web/dithie-frames.ts`: frame data del pixel-art spider (16x16 grids para cada estado).
- `packages/core/runtime.ts`: runtime multiagente, enrutado de mensajes, correlación de IDs y trazas.
- `packages/core/tools.ts`: tools del orquestador (`list_agents`, `delegate`, `delegate_task`, `get_chat_status`, `get_chat_result`, `close_chat`).
- `packages/core/agents.ts`: definición de agentes via builder pattern (`defineAgent()`).
- `packages/core/agent-builder.ts`: builder pattern para declarar agentes (incluye `.skills(...)` para configurar skills locales por agente).
- `packages/core/skills-layer.ts`: capa de skills locales (`SKILL.md`) con descubrimiento en `./skills`, selección por relevancia por turno y anexado controlado al prompt.
- `skills/`: raíz de skills del proyecto (incluye snapshot vendorizado de `marketingskills` en `skills/marketingskills`).
- `packages/core/tool-registry.ts`: registro y resolución de tools con glob patterns, ciclo de vida MCP.
- `packages/core/tool-middleware.ts`: `wrapTool` con permisos, HITL approval y hooks.
- `packages/core/prompt-compiler.ts`: compilador de system prompt en 5 capas.
- `packages/core/delegation.ts`: delegate tool con control de depth, whitelist y ciclos.
- `packages/core/scheduler.ts`: cron parser, timer basado en setTimeout, persistencia JSONL.
- `packages/core/scheduler-tools.ts`: tools de scheduling (`schedule_task`, `list_scheduled_jobs`, `cancel_scheduled_job`).
- `packages/core/mcp-client.ts`: interfaz `McpConnector` para servidores de tools externos.
- `packages/core/browser.ts`: `browseUrl` llama al microservicio Python (Crawl4AI); `searchWeb` llama directamente a SearXNG REST API; `interactWithPage` llama al microservicio Python (browser-use LLM-driven automation).
- `packages/core/explorer-tools.ts`: tool entries del explorer (`browse_url`, `search_web`, `interact_page`); `interact_page` usa parámetro `task` en lenguaje natural — browser-use decide las acciones de forma autónoma; soporta placeholders `{{credential:fieldname}}` en el task string.
- `packages/core/credential-tools.ts`: tool entry `request_credentials` para solicitar credenciales por HITL y guardarlas en `CredentialStore`.
- `packages/core/analyst-tools.ts`: tool entries del data analyst (`query_sqlite`, `query_supabase`, `parse_csv`, `analyze_data`).
- `packages/core/office-tools.ts`: tool entries de Office — `read_excel`, `write_excel` (exceljs) para math/analyst; `read_docx`, `write_docx` (mammoth + docx) para writer.
- `packages/core/debugger-tools.ts`: tool entries del debugger (`read_file`, `search_code`, `list_directory`).
- `packages/core/marketing-tools.ts`: tool entries del marketing (`seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`).
- `packages/core/workspace-manager.ts`: estado/persistencia de workspaces (`.runtime-data/workspaces.json`), workspace activo y allowed roots.
- `packages/core/workspace-tools.ts`: tools `workspace_*` para listar/registrar/activar workspaces.
- `packages/core/git-tools.ts`: tools `git_*` y `github_*` (via `gh`) sobre el workspace activo.
- `packages/core/credential-store.ts`: almacenamiento cifrado AES-256-GCM de credenciales.
- `packages/core/google-auth.ts`: helper OAuth2 para Google APIs — lee credenciales del CredentialStore (dominio `"google"`) o env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`).
- `packages/core/google-sheets-tools.ts`: tool entries de Google Sheets — `read_gsheet`, `write_gsheet`, `create_gsheet` (asignados al agente `math`/analyst).
- `packages/core/google-docs-tools.ts`: tool entries de Google Docs — `read_gdoc`, `write_gdoc`, `create_gdoc` (asignados al agente `writer`).
- `packages/core/google-drive-tools.ts`: tool entries de Google Drive — `drive_list`, `drive_search`, `drive_download` (asignados al agente `explorer`).
- `packages/core/google-mail-tools.ts`: tool entries de Gmail — `gmail_search`, `gmail_read` (read, asignados a `secretary`); `gmail_send`, `gmail_draft` (write, asignados a `writer`).
- `packages/core/google-calendar-tools.ts`: tool entries de Google Calendar — `calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete` (asignados a `secretary`).
- `packages/core/local-contacts-tools.ts`: tool entries de contactos internos — `contacts_list`, `contacts_read`, `contacts_search`, `contacts_create`, `contacts_delete` (asignados a `secretary`).
- `packages/core/google-tasks-tools.ts`: tool entries de Google Tasks — `tasks_list`, `tasks_create`, `tasks_complete` (asignados a `secretary`).
- `packages/core/chat-manager.ts`: gestión de chats con per-agent concurrency, cola FIFO, timeout/retry, pausa/reanudación de timeout para HITL multi-step y persistencia a disco.
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
  .skills({ enabled: true, roots: ["skills"] })
  .permissions({ "tool1": "allow" })
  .maxConcurrency(1)
  .build();
```

## Tool Permissions & HITL

Las tools tienen un `defaultPermission`: `"allow"`, `"deny"`, o `"hitl"`.
Orden de resolución: runtime override → agent permissions → exact match → glob pattern → default.

Cuando el permiso resuelve a `"hitl"`, se llama al `HITLHandler` para pedir aprobación:

- **CLI**: prompt via readline en terminal
- **Web**: request/response via WebSocket con timeout configurable + modal de aprobación (`Allow` / `Don't Allow`, `y` / `n`)
- **HITL con inputs**: tools como `request_credentials` usan el mismo flujo HITL pero con formulario de campos (texto/password) y `modifiedParams`.

## Google Workspace (Google Auth)

Las tools de Google usan OAuth2 via `googleapis`. Las credenciales se resuelven en este orden:

1. **CredentialStore**: dominio `"google"` con campos `clientId`, `clientSecret`, `refreshToken`.
2. **Variables de entorno**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

Configura con CredentialStore:

```ts
await credentialStore.save("google", {
  clientId: "...",
  clientSecret: "...",
  refreshToken: "...",
});
```

También podés pedirlas en UI desde el chat con el `orchestrator`: usará `request_credentials` y abrirá el modal HITL para completar los campos.

O via `.env`:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

### Asignación de tools Google por agente

| Agente | Tools Google |
| --- | --- |
| `math` (analyst) | `read_gsheet`, `write_gsheet`, `create_gsheet` |
| `writer` | `read_gdoc`, `write_gdoc`, `create_gdoc`, `gmail_send`, `gmail_draft` |
| `explorer` | `drive_list`, `drive_search`, `drive_download` |
| `secretary` | `gmail_search`, `gmail_read`, `calendar_list`, `calendar_create`, `calendar_update`, `calendar_delete`, `tasks_list`, `tasks_create`, `tasks_complete`, `schedule_task`, `list_scheduled_jobs`, `cancel_scheduled_job` |
| `marketing` | `seo_audit`, `marketing_keywords`, `marketing_competitors`, `marketing_content_calendar`, `search_web`, `browse_url` (Google Sheets via `MARKETING_SHEET_ID`; delega a `writer`, `explorer`, `secretary`) |

### Contactos internos (secretary)

- `contacts_list`, `contacts_read`, `contacts_search`, `contacts_create`, `contacts_delete`
- Persistencia local en `.runtime-data/secretary-contacts.json`

## Scheduler

El runtime incluye un `Scheduler` para ejecución cron, one-time y delayed:

- Jobs persisten a JSONL y se restauran al reiniciar.
- Tools de agente: `schedule_task` (hitl), `list_scheduled_jobs` (allow), `cancel_scheduled_job` (hitl).
- Schedules configurables via `RuntimeOptions.schedules`.

## Comportamientos esperados

- Para mensajes triviales, el orquestador puede responder sin delegar.
- Para tareas especializadas, debe aparecer `tool_start/tool_end` en `/traces`.
- Los `tool_start/tool_end` de ejecucion ahora se persisten desde `tool_execution_start/tool_execution_end` con args/details saneados; `interact_page.task` se redacta en trazas.
- Si una tool falla durante stream en UI, se emite `stream_status` con el error resumido (ademas del registro en stderr).
- Cuando el orquestador delega durante un turno del usuario, espera a que esos chats delegados cierren antes de devolver la respuesta final.
- Si no hay delegación, no verás eventos de `delegate` en la traza.
- El especialista `math` responde corto por defecto (solo resultado, salvo pedido de pasos).

## Troubleshooting rápido

- **Respuestas fuera de contexto**: usa una sesión nueva (`--session`) para evitar historial previo.
- **No sé si delegó**: consulta `/traces 30` y busca `delegate`.
- **Quiero ver conversación interna entre agentes**: `/threads` y luego `/thread <id>`.
- **Quiero estado completo raw de un chat**: `/chat <chatId> --json`.
- **Veo `(sin texto)` o respuesta vacía**: revisa `/thread <id>`; si hay `Model error: ...` suele ser rate-limit/cuota del proveedor.
- **Veo `thought:` o falta respuesta final tras delegar**: el runtime ahora ignora turns intermedios de tool-use, limpia prefijos `thought:` y puede usar fallback desde `get_chat_result` completado cuando el último assistant llega vacío.

## Nota

Este repo está en modo MPV terminal-first. La UI se activa cuando el gate indique fricción operativa real (concurrencia, HITL frecuente o volumen alto de trazas).

## Multi-org + WhatsApp (Kapso) update (2026-03)

Esta implementacion ya no asume un `orchestrator` unico en backend/UI.

- Se agrego `packages/core/runtime-manager.ts` para manejar `orgId -> OrgRuntime` con carga lazy.
- Cada org persiste aislada en `.runtime-data/orgs/<orgId>/`.
- Cada orchestrator puede existir como `orchestrator:<id>` (dinamico por organizacion).
- Especialistas (`code`, `math`, etc.) se comparten por org con su cola FIFO global por agente.
- El runtime soporta `initiator: "external"` y metadatos de canal (`channel`, `contact`, `orchestratorId`) en trazas/envelopes.

Canal WhatsApp (Kapso) v1:

- Webhook project-level: `POST /api/kapso/webhooks/project` para `whatsapp.phone_number.created` y bind automatico de `phone_number_id`.
- Webhook phone-number-level: `POST /api/kapso/webhooks/phone-number/:phoneNumberId` para `whatsapp.message.*` y `whatsapp.conversation.*`.
- Verificacion de firma: `X-Webhook-Signature` (HMAC SHA-256 sobre raw body).
- Deduplicacion: `X-Idempotency-Key` (ventana temporal en memoria del backend).
- Regla estricta `owner_number`: mensajes de numeros no-owner se bloquean antes del runtime, no se enrutan y no se persisten en chat; se registra `communication_intent`.
- Cola FIFO por conversacion (`orgId + orchestratorId + owner_number`) para preservar orden ping-pong.

UI y conversacion unificada:

- `GET /api/ui-state` acepta `orgId`, `orchestratorId` y `contact`.
- Inbox por orchestrator con hilos por contacto (conversaciones WPP).
- El hilo muestra inbound/outbound de WhatsApp y mensajes internos de UI.
- El chat de la UI envia `orchestratorId` seleccionado en el payload WS (`type: "chat"`), evitando fallback hardcodeado a `orchestrator` en sesiones multi-orchestrator.
- Mensajes enviados desde UI no se despachan a WhatsApp; solo afectan el contexto conversacional interno.
- Nuevos eventos WS: `channel_event` (sent/delivered/read/failed) y `communication_intent`.

Nuevos endpoints internos:

- `GET /api/orgs/:orgId/orchestrators`
- `POST /api/orgs/:orgId/orchestrators/:orchestratorId/setup-link`
- `POST /api/orgs/:orgId/orchestrators/:orchestratorId/channel` (upsert manual de `ownerNumber` + `kapsoCustomerId` + `phoneNumberId?`; util para sandbox/local sin rehacer onboarding)
- `GET /api/conversations`
- `GET /api/channel-events`
- `GET /api/communication-intents`

Variables de entorno Kapso:

- `KAPSO_API_KEY` (requerida para onboarding/envio)
- `KAPSO_API_BASE_URL` (opcional, default `https://api.kapso.ai`)
- `KAPSO_PROJECT_WEBHOOK_SECRET` y `KAPSO_PHONE_WEBHOOK_SECRET` (o `KAPSO_WEBHOOK_SECRET`)
- `DEFAULT_ORG_ID` para backend/UI
- Bootstrap opcional para pruebas repetibles en local/sandbox:
  - `KAPSO_BOOTSTRAP_ORG_ID` (default `DEFAULT_ORG_ID`)
  - `KAPSO_BOOTSTRAP_ORCHESTRATOR_ID` (default `main`)
  - `KAPSO_BOOTSTRAP_OWNER_NUMBER`
  - `KAPSO_BOOTSTRAP_CUSTOMER_ID`
  - `KAPSO_BOOTSTRAP_PHONE_NUMBER_ID` (opcional)
  - `KAPSO_BOOTSTRAP_ACTIVE` (`true`/`false`, opcional)

## Modelo de negocio y despliegue cloud (multi-tenant)

Este producto se opera como un servicio en la nube con un unico backend que atiende multiples organizaciones.

- Un servidor cloud ejecuta el runtime y la UI/API.
- Cada cliente corresponde a una `organization` (`orgId`) aislada en datos y configuracion.
- Cada organizacion puede tener uno o varios orchestrators (`orchestrator:<id>`).
- Cada orchestrator puede tener su propio numero de WhatsApp (Kapso customer + `phoneNumberId`).
- Los especialistas viven dentro de cada organizacion y son compartidos entre orchestrators de esa org.
- La cola de trabajo se mantiene por especialista (FIFO) y por conversacion de canal (FIFO por `orgId + orchestratorId + contact`).

Implicancias de producto/comercial:

- Onboarding por organizacion (alta de org + alta de orchestrators + setup links de WhatsApp).
- Escalado horizontal por capacidad del servidor; el aislamiento logico esta en `RuntimeManager` por `orgId`.
- Trazabilidad y auditoria por org (threads, traces, chats, channel-events, communication-intents).
- Seguridad de canal por `owner_number` (solo el numero autorizado conversa con ese orchestrator).
- Un mismo producto/SaaS sirve a multiples clientes sin mezclar contexto entre organizaciones.
