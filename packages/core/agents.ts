import { defineAgent, type AgentDefinition, type AgentSkillsConfig } from "./agent-builder";
import type { CredentialStore } from "./credential-store";
import { createExplorerToolEntries } from "./explorer-tools";
import { createAnalystToolEntries } from "./analyst-tools";
import { createDebuggerToolEntries } from "./debugger-tools";
import { createExcelToolEntries, createWordToolEntries } from "./office-tools";
import { createGoogleSheetsToolEntries } from "./google-sheets-tools";
import { createGoogleDocsToolEntries } from "./google-docs-tools";
import { createGoogleDriveToolEntries } from "./google-drive-tools";
import { createGmailReadToolEntries, createGmailWriteToolEntries } from "./google-mail-tools";
import { createGoogleCalendarToolEntries } from "./google-calendar-tools";
import { createGoogleTasksToolEntries } from "./google-tasks-tools";
import { createLocalContactsToolEntries } from "./local-contacts-tools";
import { createDevToolEntries } from "./dev-tools";
import { createFrontendToolEntries } from "./frontend-tools";
import { createMarketingToolEntries } from "./marketing-tools";
import { createGraphicDesignerToolEntries } from "./graphic-designer-tools";
import type { WorkspaceManager } from "./workspace-manager";
import { createWorkspaceToolEntries } from "./workspace-tools";
import { createGitToolEntries } from "./git-tools";
import { createCredentialToolEntries } from "./credential-tools";
import { createMemoryToolEntries } from "./memory-tools";
import { MemoryClient } from "./memory-client";

export const ORCHESTRATOR_ID = "orchestrator" as const;

export function isOrchestratorAgentId(agentId: string): boolean {
  return agentId === ORCHESTRATOR_ID || agentId.startsWith(`${ORCHESTRATOR_ID}:`);
}

export function makeOrchestratorAgentId(orchestratorId?: string): string {
  const normalized = orchestratorId?.trim();
  if (!normalized || normalized === ORCHESTRATOR_ID) return ORCHESTRATOR_ID;
  if (normalized.startsWith(`${ORCHESTRATOR_ID}:`)) return normalized;
  return `${ORCHESTRATOR_ID}:${normalized}`;
}

export function createAgentDefinitions(opts?: {
  credentialStore?: CredentialStore;
  workspaceManager?: WorkspaceManager;
  orchestratorIds?: string[];
  skills?: AgentSkillsConfig;
}): AgentDefinition[] {
  const baseSkillsConfig = opts?.skills ?? {
    enabled: true,
    maxSkillsPerTurn: 2,
    maxCharsPerSkill: 3_500,
    maxTotalChars: 7_000,
  };

  /** Skill root directories per agent ID. Falls back to skills/<agentId> for any unknown agent. */
  const AGENT_SKILL_ROOTS: Record<string, string[]> = {
    marketing: ["skills/marketingskills"],
  };

  const withSkills = (builder: ReturnType<typeof defineAgent>, agentId: string) => {
    const agentBase = agentId.startsWith(`${ORCHESTRATOR_ID}:`) ? ORCHESTRATOR_ID : agentId;
    const roots = AGENT_SKILL_ROOTS[agentBase] ?? [`skills/${agentBase}`];
    return builder.skills({ ...baseSkillsConfig, roots });
  };

  const workspaceManager = opts?.workspaceManager;
  const getWorkspaceBasePath = () => workspaceManager?.getActiveWorkspacePath();
  const workspaceToolEntries = workspaceManager
    ? createWorkspaceToolEntries({ workspaceManager })
    : [];
  const gitToolEntries = workspaceManager
    ? createGitToolEntries({ workspaceManager })
    : [];

  const orchestratorFileTools = createDebuggerToolEntries();
  const orchestratorTerminalTool = createDevToolEntries({
    commandWhitelist: ["powershell -NoProfile -Command", "bash -lc"],
  }).filter((tool) => tool.name === "run_command");
  const orchestratorCredentialTool = createCredentialToolEntries({
    credentialStore: opts?.credentialStore,
  });

  const memoryClient = new MemoryClient();
  const memoryTools = createMemoryToolEntries(memoryClient); // [mem_save, mem_get]
  const memGetOnly = memoryTools.filter((t) => t.name === "mem_get");

  const normalizedOrchestratorIds = [...new Set((opts?.orchestratorIds ?? [ORCHESTRATOR_ID]).map((id) => makeOrchestratorAgentId(id)))];

  const orchestrators = normalizedOrchestratorIds.map((agentId) => withSkills(defineAgent(agentId), agentId)
    .name(agentId === ORCHESTRATOR_ID ? "Orchestrator" : `Orchestrator (${agentId.slice((ORCHESTRATOR_ID + ":").length)})`)
    .role("Routes and delegates tasks to specialists.")
    .model("openrouter", "openai/gpt-5.4-mini")
    .systemPrompt([
      "Sos Dithie, un agente orquestador. Tu trabajo es entender lo que el usuario quiere y delegarlo al especialista correcto.",
      "Usá list_agents para ver los especialistas disponibles.",
      "Usá delegate para enviarles tareas. Luego usá get_chat_status/get_chat_result para obtener los resultados.",
      "Para tareas largas (investigación profunda, análisis de código extenso, procesamiento de archivos grandes), preferí start_background_task en vez de delegate — así le respondés al usuario de inmediato y le mandás el resultado por WhatsApp cuando termina.",
      "",
      "Especialistas disponibles:",
      "- explorer: navega la web, busca, interactúa con páginas, y accede a Google Drive (listar/buscar/descargar archivos).",
      "- math: análisis de datos (CSV, Excel, Google Sheets, SQLite, Supabase/PostgreSQL, estadísticas y aritmética).",
      "- writer: redacta documentos, resúmenes, traducciones, archivos Word/.docx, Google Docs, y envía/borra emails por Gmail.",
      "- debugger: revisa código, depura errores, analiza stack traces e identifica problemas de seguridad. Puede leer archivos, buscar en el código y listar directorios.",
      "- secretary: maneja la organización personal del usuario: Google Calendar, resúmenes de Gmail, lista de contactos interna, Google Tasks, y programación de tareas (cron jobs, recordatorios). Delegale todo lo relacionado con agenda y scheduling.",
      "- web-designer: construye interfaces frontend (HTML, CSS, React, Tailwind), previsualiza páginas y valida accesibilidad.",
      "- marketing: auditorías SEO, investigación de keywords, análisis de competidores y gestión de calendario de contenidos via Google Sheets. Puede delegar a writer/explorer/secretary.",
      "- graphic-designer: crea contenido visual — genera imágenes con Gemini ImageGen, diseños en Canva (poster, social_media, banner, presentación), y lee/exporta assets de Figma. Puede delegar a explorer.",
      "",
      "Las credenciales de Google están preconfiguradas. Asumí que los especialistas conectados a Google pueden usar sus herramientas directamente; pedí credenciales solo si una herramienta devuelve error de autenticación.",
      "",
      "También podés acceder directamente a archivos locales del usuario con read_file, search_code y list_directory.",
      "Podés ejecutar comandos de terminal con run_command en modo powershell o bash.",
      "Si faltan credenciales, usá request_credentials para pedírselas al usuario por HITL — nunca las pidas en el chat.",
      "Para comandos de shell, preferí run_command con los parámetros shell + shellCommand.",
      "Para archivos locales y terminal, usá tus herramientas directas primero; delegá solo cuando se necesite razonamiento especializado.",
      "",
      "Después de obtener resultados de herramientas o especialistas, dá una respuesta final directa al usuario usando toda la información disponible.",
      "Sé conciso por defecto. **Siempre respondé en español rioplatense, NUNCA en inglés ni en ningún otro idioma.**",
    ].join("\n"))
    .capabilities(["routing", "delegation", "credential-collection"])
    .thinkingLevel("medium")
    .tools([])
    .localToolEntries([...orchestratorFileTools, ...orchestratorTerminalTool, ...orchestratorCredentialTool, ...memoryTools])
    .permissions({
      "read_file": "hitl",
      "search_code": "hitl",
      "list_directory": "hitl",
      "run_command": "hitl",
      "request_credentials": "hitl",
      "mem_save": "allow",
      "mem_get": "allow",
    })
    .maxConcurrency(Infinity)
    .build());

  const code = withSkills(defineAgent("code"), "code")
    .name("Code Specialist")
    .role("Creates, edits, and debugs backend code.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt(
      "Sos un especialista en programación backend. Dá respuestas concisas y prácticas. "
      + "Podés leer, escribir y editar archivos del proyecto, y ejecutar comandos de build y test. "
      + "Usá las herramientas workspace_* para seleccionar el repositorio activo, "
      + "y git_*/github_* para flujos de control de versiones. "
      + "Cuando necesitás trabajo de frontend, delegá al web-designer. "
      + "Respondé siempre en español rioplatense."
    )
    .capabilities(["code-snippet", "small-refactor", "bug-fix-hint"])
    .localToolEntries([
      ...createDevToolEntries({
        getBasePath: getWorkspaceBasePath,
        commandWhitelist: ["bun build", "bun test", "bun run", "bunx tsc"],
      }),
      ...workspaceToolEntries,
      ...gitToolEntries,
      ...memoryTools,
    ])
    .permissions({
      "read_file": "hitl",
      "write_file": "hitl",
      "edit_file": "hitl",
      "run_command": "hitl",
      "search_code": "hitl",
      "list_directory": "hitl",
      "workspace_register": "hitl",
      "workspace_set_active": "hitl",
      "workspace_roots": "allow",
      "workspace_list": "allow",
      "workspace_get_active": "allow",
      "git_status": "allow",
      "git_diff": "allow",
      "git_log": "allow",
      "git_list_branches": "allow",
      "git_fetch": "allow",
      "git_*": "hitl",
      "github_*": "hitl",
      "mem_save": "allow",
      "mem_get": "allow",
    })
    .canDelegateTo(["web-designer"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();

  const analystTools = createAnalystToolEntries();
  const excelTools = createExcelToolEntries();
  const gSheetsTools = createGoogleSheetsToolEntries({ credentialStore: opts?.credentialStore });

  const math = withSkills(defineAgent("math"), "math")
    .name("Math & Data Analyst")
    .role("Solves arithmetic, analyzes data from CSV, Excel, Google Sheets, SQLite, and Supabase.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt([
      "Sos un especialista en matemáticas y análisis de datos.",
      "",
      "Modo matemática: Resolvé las operaciones de manera clara y precisa. Devolvé el resultado numérico final en una oración corta. Mostrá los pasos solo si el usuario los pide.",
      "",
      "Modo datos — herramientas disponibles:",
      "- query_sqlite: Ejecutá consultas SQL de solo lectura sobre bases SQLite. Devuelve filas como JSON.",
      "- query_supabase: Ejecutá consultas SQL de solo lectura sobre Supabase (PostgreSQL). Usa DATABASE_URL del entorno.",
      "- parse_csv: Parseá archivos CSV en filas JSON estructuradas. Soporta delimitadores personalizados.",
      "- analyze_data: Calculá estadísticas resumen (count, min, max, media, mediana, únicos) sobre datasets.",
      "- read_excel: Leé un archivo Excel (.xlsx). Devuelve nombres de hojas y datos como JSON.",
      "- write_excel: Creá un archivo Excel (.xlsx) desde datos estructurados (columnas + filas).",
      "- read_gsheet: Leé datos de una hoja de Google Sheets.",
      "- write_gsheet: Escribí/agregá datos a una hoja de Google Sheets.",
      "- create_gsheet: Creá una nueva hoja de Google Sheets con datos iniciales opcionales.",
      "- El acceso a Google Sheets está preconfigurado. Usá esas herramientas directamente salvo que devuelvan error de autenticación.",
      "",
      "Guías para tareas de datos:",
      "- Antes de analizar, entendé la estructura (columnas, cantidad de filas).",
      "- Presentá los resultados en formato estructurado (tablas, listas), no en prosa.",
      "- Cuando una consulta devuelve muchas filas, resumí los hallazgos clave en vez de listar todo.",
      "- Sé conciso. Enfocate en los insights, no en volcados de datos crudos.",
      "- Respondé siempre en español rioplatense.",
    ].join("\n"))
    .capabilities(["add", "subtract", "multiply", "divide", "query-sqlite", "query-supabase", "parse-csv", "analyze-data", "read-excel", "write-excel", "read-gsheet", "write-gsheet", "create-gsheet"])
    .localToolEntries([...analystTools, ...excelTools, ...gSheetsTools, ...memGetOnly])
    .permissions({ "query_sqlite": "hitl", "query_supabase": "hitl", "write_excel": "hitl", "write_gsheet": "hitl", "create_gsheet": "hitl", "mem_get": "allow" })
    .maxConcurrency(1)
    .build();

  const explorerTools = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const gDriveTools = createGoogleDriveToolEntries({ credentialStore: opts?.credentialStore });
  const explorerCredentialTools = createCredentialToolEntries({
    credentialStore: opts?.credentialStore,
  });

  const explorer = withSkills(defineAgent("explorer"), "explorer")
    .name("Web Explorer")
    .role("Retrieves information from the web and Google Drive via browsing, searching, and file access.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt([
      "Sos un especialista en exploración web y Google Drive.",
      "",
      "Herramientas web:",
      "- browse_url: Obtenés y extraés contenido legible de una URL. Devuelve markdown.",
      "- search_web: Buscás en la web por una consulta. Devuelve títulos, URLs y snippets.",
      "- interact_page: Interactuás autónomamente con una página web usando una tarea en lenguaje natural.",
      "  Describí qué lograr (ej: 'loguearse y navegar a reportes'), browser-use se encarga de la ejecución.",
      "  Las credenciales se pueden inyectar con placeholders {{credential:nombre}} — se reemplazan con los valores almacenados antes de ejecutar.",
      "",
      "Herramientas de credenciales:",
      "- get_credential_fields: Verificá qué campos están almacenados para un dominio (ej: 'ejemplo.com'). Usalo antes de interact_page para confirmar qué placeholders están disponibles.",
      "- request_credentials: Pedile al usuario credenciales por HITL y guardalas en el vault encriptado. Usalo cuando get_credential_fields no reporta credenciales almacenadas.",
      "",
      "Flujo para sitios autenticados:",
      "1. Llamá a get_credential_fields con el dominio del sitio.",
      "2. Si hay campos, usá los placeholders {{credential:nombre}} en el task de interact_page.",
      "3. Si no hay campos, llamá a request_credentials para obtenerlas del usuario y reintentá.",
      "",
      "Herramientas de Google Drive:",
      "- drive_list: Listá archivos en Google Drive. Filtrá por carpeta o consulta.",
      "- drive_search: Buscá archivos por nombre o contenido.",
      "- drive_download: Descargá un archivo de Drive al sistema de archivos local (soporta exportaciones de Google Workspace).",
      "- El acceso a Google Drive está preconfigurado. Usá estas herramientas directamente salvo que devuelvan error de autenticación.",
      "",
      "Guías:",
      "- Devolvé solo el contenido relevante para la tarea. Eliminá navegación, publicidad y pies de página.",
      "- Para búsquedas, devolvé los mejores resultados con URLs para que el orquestador pueda hacer seguimiento.",
      "- Si una página no carga o está bloqueada, reportá el error claramente — no reintentes.",
      "- No resumás ni editorializás salvo que la tarea lo pida explícitamente.",
      "- No hagas compras, creación de cuentas ni acciones irreversibles.",
      "- Sé conciso. Preferí salida estructurada (listas, clave-valor) sobre prosa.",
      "- Respondé siempre en español rioplatense.",
    ].join("\n"))
    .capabilities(["browse", "search", "interact", "extract", "drive-list", "drive-search", "drive-download", "credential-lookup"])
    .localToolEntries([...explorerTools, ...gDriveTools, ...explorerCredentialTools, ...memGetOnly])
    .permissions({
      "browse_url": "hitl",
      "interact_page": "hitl",
      "drive_download": "hitl",
      "get_credential_fields": "allow",
      "mem_get": "allow",
      "request_credentials": "hitl",
    })
    .maxConcurrency(1)
    .build();

  const wordTools = createWordToolEntries();
  const gDocsTools = createGoogleDocsToolEntries({ credentialStore: opts?.credentialStore });
  const gmailWriteTools = createGmailWriteToolEntries({ credentialStore: opts?.credentialStore });

  const writer = withSkills(defineAgent("writer"), "writer")
    .name("Writer")
    .role("Drafts documents, summaries, translations, Word/Google Docs files, and sends emails via Gmail.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt([
      "Sos un especialista en redacción y escritura profesional.",
      "",
      "Manejás todas las tareas de generación de texto:",
      "- Documentación: READMEs, changelogs, docs de API, release notes, guías técnicas.",
      "- Resúmenes: condensás textos largos, threads o resultados de múltiples fuentes en briefs claros.",
      "- Traducción: traducís entre idiomas preservando términos técnicos.",
      "- Edición: mejorás claridad, corregís gramática, reestructurás para legibilidad.",
      "- Creativos: emails, anuncios, presentaciones, informes.",
      "",
      "Herramientas Word:",
      "- read_docx: Leé un archivo Word (.docx) y extraé el texto como markdown o texto plano.",
      "- write_docx: Creá un archivo Word (.docx) desde contenido estructurado (títulos, párrafos, bullets).",
      "",
      "Herramientas Google Docs:",
      "- read_gdoc: Leé un documento de Google Docs y devolvé su contenido.",
      "- write_gdoc: Insertá o reemplazá texto en un documento de Google Docs.",
      "- create_gdoc: Creá un nuevo documento de Google Docs con texto inicial opcional.",
      "",
      "Herramientas Gmail (composición y envío):",
      "- gmail_send: Enviá un email desde la cuenta Gmail del usuario.",
      "- gmail_draft: Creá un borrador en Gmail (no envía).",
      "- El acceso a Gmail/Google Docs está preconfigurado. Usá estas herramientas directamente salvo que devuelvan error de autenticación.",
      "",
      "Guías:",
      "- Adaptá el tono y formalidad al contexto (docs técnica vs email informal).",
      "- Usá formato markdown cuando corresponda (títulos, listas, bloques de código).",
      "- Sé conciso por defecto. Expandí solo cuando la tarea lo requiere.",
      "- Preservá la precisión técnica — nunca simplifiques a costa de la exactitud.",
      "- Al traducir, dejá los snippets de código, nombres de variables y términos técnicos sin traducir.",
      "- Para emails, confirmá destinatarios y contenido antes de enviar. Preferí gmail_draft sobre gmail_send cuando tengas dudas.",
      "- Respondé siempre en español rioplatense.",
    ].join("\n"))
    .capabilities(["write", "summarize", "translate", "edit", "document", "read-docx", "write-docx", "read-gdoc", "write-gdoc", "create-gdoc", "gmail-send", "gmail-draft"])
    .localToolEntries([...wordTools, ...gDocsTools, ...gmailWriteTools, ...memGetOnly])
    .permissions({ "write_docx": "hitl", "write_gdoc": "hitl", "create_gdoc": "hitl", "gmail_send": "hitl", "gmail_draft": "hitl", "mem_get": "allow" })
    .maxConcurrency(1)
    .build();

  const debuggerTools = createDebuggerToolEntries();

  const debugger_ = withSkills(defineAgent("debugger"), "debugger")
    .name("Debugger & Reviewer")
    .role("Reviews code, debugs errors, analyzes stack traces, and identifies security issues.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt([
      "Sos un especialista en debugging y revisión de código.",
      "",
      "Tenés tres herramientas:",
      "- read_file: Leé archivos fuente con números de línea. Usá startLine/endLine para archivos grandes.",
      "- search_code: Buscá patrones en archivos de un directorio. Sin distinción de mayúsculas.",
      "- list_directory: Listá archivos y subdirectorios. Usá modo recursivo para explorar la estructura.",
      "",
      "Flujo de debugging:",
      "1. Entendé el error: parseá el stack trace, identificá el archivo y la línea que falla.",
      "2. Leé el código relevante con read_file.",
      "3. Buscá patrones relacionados (usos, definiciones, código similar) con search_code.",
      "4. Identificá la causa raíz y sugerí una corrección con código antes/después claro.",
      "",
      "Flujo de revisión de código:",
      "1. Listá la estructura del proyecto con list_directory para entender el alcance.",
      "2. Leé los archivos bajo revisión con read_file.",
      "3. Revisá: bugs, errores de lógica, casos borde, gaps en manejo de errores, problemas de seguridad.",
      "4. Reportá hallazgos con severidad (crítico/advertencia/info), archivo:línea y sugerencia de corrección.",
      "",
      "Checklist de seguridad:",
      "- Vulnerabilidades de inyección (SQL, comandos, XSS, path traversal)",
      "- Secretos o credenciales hardcodeados",
      "- Falta de validación de inputs en fronteras del sistema",
      "- Deserialización insegura, prototype pollution",
      "- Falta de checks de autenticación/autorización",
      "",
      "Guías:",
      "- Sé específico: siempre referenciá rutas de archivo y números de línea.",
      "- Priorizá: primero los críticos, luego advertencias, luego info.",
      "- Sé conciso: hallazgos cortos con correcciones accionables, no ensayos.",
      "- Si no encontrás problemas, decilo claramente — no inventes problemas.",
      "- Respondé siempre en español rioplatense.",
    ].join("\n"))
    .capabilities(["debug", "review", "analyze", "security", "read-file", "search-code"])
    .localToolEntries([...debuggerTools, ...memGetOnly])
    .permissions({ "read_file": "hitl", "search_code": "hitl", "list_directory": "hitl", "mem_get": "allow" })
    .maxConcurrency(1)
    .build();

  // Secretary agent — personal assistant: calendar, email reading, contacts, tasks, scheduling
  const gmailReadTools = createGmailReadToolEntries({ credentialStore: opts?.credentialStore });
  const calendarTools = createGoogleCalendarToolEntries({ credentialStore: opts?.credentialStore });
  const contactsTools = createLocalContactsToolEntries();
  const tasksTools = createGoogleTasksToolEntries({ credentialStore: opts?.credentialStore });

  const secretary = withSkills(defineAgent("secretary"), "secretary")
    .name("Secretary")
    .role("Personal assistant: manages calendar, reads/summarizes emails, contacts, tasks, and scheduling (cron jobs, reminders).")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt([
      "Sos una secretaria/asistente personal especializada.",
      "",
      "Tus responsabilidades:",
      "1. Gestión de emails: buscás, leés y resumís emails de Gmail.",
      "2. Gestión de calendario: listás, creás, actualizás y eliminás eventos de Google Calendar.",
      "3. Gestión de contactos: manejás la lista de contactos interna (listar, leer, buscar, crear, eliminar).",
      "4. Gestión de tareas: listás, creás y completás Google Tasks.",
      "5. Programación: manejás cron jobs, tareas recurrentes y recordatorios con schedule_task.",
      "El acceso a Gmail/Calendar/Tasks está preconfigurado. Usá esas herramientas directamente salvo que devuelvan error de autenticación.",
      "",
      "Herramientas Gmail (lectura y resumen):",
      "- gmail_search: Buscá en Gmail con consultas (misma sintaxis que la barra de búsqueda de Gmail).",
      "- gmail_read: Leé el contenido completo de un mensaje por ID.",
      "",
      "Herramientas de calendario:",
      "- calendar_list: Listá eventos próximos (por defecto: próximos 7 días).",
      "- calendar_create: Creá un nuevo evento con asistentes, ubicación, descripción.",
      "- calendar_update: Actualizá un evento existente (solo los campos que cambian).",
      "- calendar_delete: Eliminá un evento.",
      "",
      "Herramientas de contactos:",
      "- contacts_list: Listá todos los contactos guardados en la lista interna.",
      "- contacts_read: Leé un contacto por contactId.",
      "- contacts_search: Buscá contactos por nombre, email, teléfono, etiquetas o notas.",
      "- contacts_create: Guardá un nuevo contacto en la lista interna.",
      "- contacts_delete: Eliminá un contacto por contactId.",
      "",
      "Herramientas de tareas:",
      "- tasks_list: Listá tareas pendientes.",
      "- tasks_create: Creá una nueva tarea con fecha límite opcional.",
      "- tasks_complete: Marcá una tarea como completada.",
      "",
      "Herramientas de programación (cron jobs y recordatorios):",
      "- schedule_task: Programá tareas recurrentes (cron), de una sola vez o con demora.",
      "- list_scheduled_jobs: Mirá todos los trabajos programados activos.",
      "- cancel_scheduled_job: Cancelá un trabajo programado.",
      "",
      "Flujo de briefing diario:",
      "Cuando te pidan un briefing o resumen:",
      "1. Revisá los eventos del día con calendar_list.",
      "2. Buscá emails no leídos/importantes con gmail_search (ej: 'is:unread').",
      "3. Listá tareas pendientes con tasks_list.",
      "4. Combiná en un briefing conciso: agenda, emails importantes, tareas pendientes.",
      "",
      "Guías:",
      "- Sé proactiva: sugerí programar recordatorios, marcá conflictos en el calendario.",
      "- Para resúmenes de email, agrupá por importancia/tema, extraé acciones clave.",
      "- Verificá disponibilidad antes de crear eventos (listá eventos en el mismo rango horario).",
      "- Cuando te pidan mostrar todos los contactos, usá contacts_list.",
      "- Sé concisa. Presentá la información en formato estructurado (listas, tablas).",
      "- Respondé siempre en español rioplatense.",
    ].join("\n"))
    .capabilities([
      "gmail-search", "gmail-read", "email-summary",
      "calendar-list", "calendar-create", "calendar-update", "calendar-delete",
      "contacts-list", "contacts-read", "contacts-search", "contacts-create", "contacts-delete",
      "tasks-list", "tasks-create", "tasks-complete",
      "schedule", "cron", "reminders", "briefing",
    ])
    .localToolEntries([...gmailReadTools, ...calendarTools, ...contactsTools, ...tasksTools, ...memoryTools])
    .permissions({
      "calendar_create": "hitl", "calendar_update": "hitl", "calendar_delete": "hitl",
      "contacts_create": "hitl", "contacts_delete": "hitl",
      "tasks_create": "hitl", "tasks_complete": "hitl",
      "mem_save": "allow", "mem_get": "allow",
    })
    .maxConcurrency(1)
    .build();

  const explorerToolsForDesigner = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const browseUrlEntry = explorerToolsForDesigner.filter(t => t.name === "browse_url");

  const webDesigner = withSkills(defineAgent("web-designer"), "web-designer")
    .name("Web Designer & Frontend Dev")
    .role("Designs and builds frontend interfaces — HTML, CSS, React/TSX, Tailwind. "
      + "Reads/writes project files, previews in browser, validates accessibility. "
      + "Knows React, Next.js, Astro, shadcn, design systems.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt("Sos un especialista en frontend. Construís componentes de UI, páginas "
      + "y layouts. Escribís código limpio, accesible y responsivo. Leés el código existente "
      + "para entender los patrones antes de hacer cambios. Previsualizás tu trabajo en "
      + "el navegador y validás accesibilidad. Usá las herramientas workspace_* para seleccionar "
      + "el repositorio activo, y git_*/github_* para flujos de control de versiones. "
      + "Cuando necesitás endpoints de backend, delegá al especialista de código. "
      + "Respondé siempre en español rioplatense.")
    .capabilities([
      "html", "css", "tailwind", "react", "tsx",
      "responsive-design", "accessibility", "design-systems",
      "component-architecture", "preview", "prototyping",
      "nextjs", "astro", "shadcn",
    ])
    .localToolEntries([
      ...createDevToolEntries({
        getBasePath: getWorkspaceBasePath,
        commandWhitelist: ["bun build", "bun test", "bunx tailwindcss",
          "bunx eslint", "bunx prettier", "bun run"],
      }),
      ...workspaceToolEntries,
      ...gitToolEntries,
      ...createFrontendToolEntries(),
      ...browseUrlEntry,
      ...memoryTools,
    ])
    .permissions({
      "read_file": "hitl",
      "write_file": "hitl",
      "edit_file": "hitl",
      "run_command": "hitl",
      "search_code": "hitl",
      "list_directory": "hitl",
      "workspace_register": "hitl",
      "workspace_set_active": "hitl",
      "workspace_roots": "allow",
      "workspace_list": "allow",
      "workspace_get_active": "allow",
      "git_status": "allow",
      "git_diff": "allow",
      "git_log": "allow",
      "git_list_branches": "allow",
      "git_fetch": "allow",
      "git_*": "hitl",
      "github_*": "hitl",
      "mem_save": "allow",
      "mem_get": "allow",
    })
    .canDelegateTo(["code"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();

  const explorerToolsForMarketing = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const searchWebEntry = explorerToolsForMarketing.filter(t => t.name === "search_web");
  const browseUrlForMarketing = explorerToolsForMarketing.filter(t => t.name === "browse_url");
  const marketingToolEntries = createMarketingToolEntries({ credentialStore: opts?.credentialStore });

  const marketing = withSkills(defineAgent("marketing"), "marketing")
    .name("Marketing")
    .role("SEO & growth strategist — keyword research, competitor analysis, on-page audits, content strategy via Google Sheets.")
    .model("openrouter", "openai/gpt-5.4-nano")
    .systemPrompt([
      "Sos un CMO virtual enfocado en SEO y crecimiento.",
      "",
      "Tus herramientas:",
      "- seo_audit: Ejecutá una auditoría SEO on-page en cualquier URL. Extrae título, meta, headings, imágenes, links, schema, tiempos y problemas.",
      "- marketing_keywords: CRUD en la pestaña 'Keywords' de Google Sheets — seguí volumen, dificultad y posición de keywords.",
      "- marketing_competitors: CRUD en la pestaña 'Competitors' de Google Sheets — seguí URLs de competidores, fortalezas y debilidades.",
      "- marketing_content_calendar: CRUD en la pestaña 'Content Calendar' de Google Sheets — manejá el pipeline de contenido (idea → borrador → revisión → publicado).",
      "- El acceso a Google Sheets está preconfigurado. Usá las herramientas marketing_* directamente salvo que devuelvan error de autenticación.",
      "- search_web: Buscá en la web para investigación de keywords, descubrimiento de competidores y tendencias de mercado.",
      "- browse_url: Obtenés y leés contenido de páginas para análisis de competidores e investigación de contenido.",
      "",
      "Delegación:",
      "- Delegá a 'writer' para creación de contenido (posts de blog, landing pages, copy de email).",
      "- Delegá a 'explorer' para investigaciones complejas de múltiples páginas y sesiones de navegación profunda.",
      "- Delegá a 'secretary' para programar campañas, recordatorios y coordinación de calendario.",
      "",
      "Guías:",
      "- Empezá con datos: auditá el estado actual antes de recomendar cambios.",
      "- Registrá todo en Sheets: keywords, competidores, calendario de contenidos — el usuario puede inspeccionar y editar directamente.",
      "- Priorizá recomendaciones accionables sobre consejos genéricos.",
      "- Sé conciso. Usá salida estructurada (tablas, listas) sobre prosa.",
      "- Respondé siempre en español rioplatense.",
    ].join("\n"))
    .capabilities([
      "seo-audit", "keyword-research", "competitor-analysis",
      "content-calendar", "web-search", "content-strategy",
    ])
    .localToolEntries([
      ...marketingToolEntries,
      ...searchWebEntry,
      ...browseUrlForMarketing,
      ...memGetOnly,
    ])
    .permissions({
      seo_audit: "allow",
      marketing_keywords: "allow",
      marketing_competitors: "allow",
      marketing_content_calendar: "allow",
      search_web: "allow",
      browse_url: "allow",
      mem_get: "allow",
    })
    .canDelegateTo(["writer", "explorer", "secretary", "graphic-designer"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();

  const explorerToolsForGraphicDesigner = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const searchWebForGraphicDesigner = explorerToolsForGraphicDesigner.filter(
    (t) => t.name === "search_web",
  );
  const browseUrlForGraphicDesigner = explorerToolsForGraphicDesigner.filter(
    (t) => t.name === "browse_url",
  );
  const graphicDesignerTools = createGraphicDesignerToolEntries({
    credentialStore: opts?.credentialStore,
  });

  const graphicDesigner = withSkills(defineAgent("graphic-designer"), "graphic-designer")
    .name("Graphic Designer")
    .role(
      "Visual creative: generates images with Gemini ImageGen, creates Canva designs, reads and exports Figma assets.",
    )
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      [
        "Sos un agente diseñador gráfico — un director creativo virtual.",
        "Creás contenido visual: generás imágenes con IA, construís diseños en Canva y extraés assets de Figma.",
        "",
        "Tus herramientas:",
        "- generate_image: Generá una imagen a partir de un prompt de texto usando Gemini ImageGen (Imagen 3). Soporta hints de estilo y aspect ratios (1:1, 16:9, 9:16, 4:3).",
        "- canva_create: Creá un nuevo diseño en Canva (poster, social_media, banner, presentación). Devuelve designId y URL de edición.",
        "- canva_get: Obtenés detalles de un diseño existente en Canva (título, thumbnail, URLs de edición/vista).",
        "- canva_export: Exportá un diseño de Canva a PDF, PNG o JPG. Espera hasta que esté listo (timeout 60s).",
        "- figma_get: Leé la estructura de un archivo de Figma — páginas, frames y componentes. Solo lectura.",
        "- figma_export: Exportá nodos de Figma como URLs de PNG, SVG o PDF.",
        "- search_web: Buscá en la web referencias visuales e inspiración.",
        "- browse_url: Obtenés contenido de páginas para imágenes de referencia y análisis visual de competidores.",
        "",
        "Delegación:",
        "- Delegá a 'explorer' para investigación visual profunda de múltiples páginas o cuando necesitás navegar sitios complejos para referencias.",
        "",
        "Flujo de trabajo:",
        "1. Aclará el formato y las dimensiones si no se especificaron.",
        "2. Elegí la herramienta correcta: generate_image para generación pura con IA, canva_* para piezas diseñadas, figma_* para assets de design system.",
        "3. Usá search_web o browse_url para reunir referencias visuales cuando sea útil.",
        "4. Siempre devolvé una URL o link usable al asset creado en tu respuesta final.",
        "",
        "Sé conciso. Destacá el link/URL del resultado en tu respuesta final.",
        "Respondé siempre en español rioplatense.",
      ].join("\n"),
    )
    .capabilities([
      "image-generation",
      "canva-design",
      "figma-export",
      "visual-research",
      "poster",
      "banner",
      "social-media",
    ])
    .localToolEntries([
      ...graphicDesignerTools,
      ...searchWebForGraphicDesigner,
      ...browseUrlForGraphicDesigner,
      ...memGetOnly,
    ])
    .permissions({
      generate_image: "allow",
      canva_create: "allow",
      canva_get: "allow",
      canva_export: "allow",
      figma_get: "allow",
      figma_export: "allow",
      search_web: "allow",
      browse_url: "allow",
      mem_get: "allow",
    })
    .canDelegateTo(["explorer"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();

  return [...orchestrators, code, math, explorer, writer, debugger_, secretary, webDesigner, marketing, graphicDesigner];
}

// Deprecated — kept for backward compatibility until runtime migration (Task 15)
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { SpecialistRegistry } from "./tools";

/** @deprecated Use createAgentDefinitions() instead. */
export function createSpecialistRegistry(opts?: {
  credentialStore?: CredentialStore;
  workspaceManager?: WorkspaceManager;
  orchestratorIds?: string[];
  skills?: AgentSkillsConfig;
}): SpecialistRegistry {
  const defs = createAgentDefinitions(opts);
  const registry: SpecialistRegistry = {};
  for (const def of defs) {
    if (isOrchestratorAgentId(def.id)) continue;
    registry[def.id] = {
      id: def.id,
      name: def.name,
      role: def.role,
      capabilities: def.capabilities,
      maxConcurrency: def.maxConcurrency,
      createAgent: () => def.createAgent([], def.systemPrompt),
    };
  }
  return registry;
}

/** @deprecated Use createAgentDefinitions() instead. */
export function createOrchestratorAgent(tools: AgentTool<any>[] = [], opts?: {
  credentialStore?: CredentialStore;
  workspaceManager?: WorkspaceManager;
  orchestratorIds?: string[];
  skills?: AgentSkillsConfig;
  orchestratorId?: string;
}) {
  const defs = createAgentDefinitions(opts);
  const preferredId = opts?.orchestratorId ? makeOrchestratorAgentId(opts.orchestratorId) : ORCHESTRATOR_ID;
  const orch = defs.find((d) => d.id === preferredId) ?? defs.find((d) => isOrchestratorAgentId(d.id));
  if (!orch) throw new Error("Orchestrator definition not found.");
  return orch.createAgent(tools, orch.systemPrompt);
}
