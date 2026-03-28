import { defineAgent, type AgentDefinition } from "./agent-builder";
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

export const ORCHESTRATOR_ID = "orchestrator" as const;

export function isOrchestratorAgentId(agentId: string): boolean {
  return agentId === ORCHESTRATOR_ID || agentId.startsWith(`${ORCHESTRATOR_ID}:`);
}

export function makeOrchestratorAgentId(orchestratorId?: string): string {
  const normalized = orchestratorId?.trim();
  if (!normalized || normalized === ORCHESTRATOR_ID) return ORCHESTRATOR_ID;
  return `${ORCHESTRATOR_ID}:${normalized}`;
}

export function createAgentDefinitions(opts?: {
  credentialStore?: CredentialStore;
  workspaceManager?: WorkspaceManager;
  orchestratorIds?: string[];
}): AgentDefinition[] {
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
  const normalizedOrchestratorIds = [...new Set((opts?.orchestratorIds ?? [ORCHESTRATOR_ID]).map((id) => makeOrchestratorAgentId(id)))];

  const orchestrators = normalizedOrchestratorIds.map((agentId) => defineAgent(agentId)
    .name(agentId === ORCHESTRATOR_ID ? "Orchestrator" : `Orchestrator (${agentId.slice((ORCHESTRATOR_ID + ":").length)})`)
    .role("Routes and delegates tasks to specialists.")
    .model("openrouter", "google/gemini-3-flash-preview")
    .systemPrompt([
      "You are an orchestrator agent.",
      "Use list_agents to discover available specialists.",
      "Use delegate to send tasks to specialists.",
      "Then poll with get_chat_status/get_chat_result to get results.",
      "The explorer specialist can browse the web, search, interact with pages, and access Google Drive (list/search/download files).",
      "The math specialist handles data analysis (CSV, Excel, Google Sheets, SQLite, Supabase/PostgreSQL, statistics).",
      "The writer specialist drafts documents, summaries, translations, Word (.docx) files, Google Docs, and sends/drafts emails via Gmail.",
      "The debugger specialist reviews code, debugs errors, and identifies security issues. It can read files, search code, and list directories.",
      "The secretary specialist manages the user's personal organization: Google Calendar, Gmail reading/summaries, an internal contact list, Google Tasks, and scheduling (cron jobs, recurring tasks, reminders). Delegate scheduling and agenda tasks to her.",
      "The web-designer specialist builds frontend interfaces (HTML, CSS, React, Tailwind), previews pages, and validates accessibility.",
      "The marketing specialist handles SEO audits, keyword research, competitor analysis, and content calendar management via Google Sheets. It can delegate to writer/explorer/secretary.",
      "The graphic-designer specialist creates visual content: generates images with Gemini ImageGen, creates and exports Canva designs (poster, social_media, banner, presentation), and reads/exports Figma assets. It can delegate to explorer.",
      "You can also directly inspect local files on the user's computer with read_file, search_code, and list_directory.",
      "You can run terminal commands with run_command in powershell or bash mode when needed.",
      "When credentials are missing, use request_credentials to ask the user for secrets through HITL instead of asking for secrets in plain chat.",
      "For shell commands, prefer run_command with shell + shellCommand parameters.",
      "For local filesystem and terminal requests, prefer your direct tools first; delegate only when specialist reasoning is needed.",
      "After tool results, produce a direct final answer for the user.",
      "Be concise by default.",
    ].join(" "))
    .capabilities(["routing", "delegation", "credential-collection"])
    .tools([])
    .localToolEntries([...orchestratorFileTools, ...orchestratorTerminalTool, ...orchestratorCredentialTool])
    .permissions({
      "read_file": "hitl",
      "search_code": "hitl",
      "list_directory": "hitl",
      "run_command": "hitl",
      "request_credentials": "hitl",
    })
    .maxConcurrency(Infinity)
    .build());

  const code = defineAgent("code")
    .name("Code Specialist")
    .role("Creates, edits, and debugs backend code.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      "You are a coding specialist. Return concise, practical answers. "
      + "You can read, write, and edit files in the project. You can run build and "
      + "test commands. Use workspace_* tools to select the active repository, and "
      + "git_*/github_* tools for version control workflows. When you need frontend "
      + "work, delegate to the web-designer."
    )
    .capabilities(["code-snippet", "small-refactor", "bug-fix-hint"])
    .localToolEntries([
      ...createDevToolEntries({
        getBasePath: getWorkspaceBasePath,
        commandWhitelist: ["bun build", "bun test", "bun run", "bunx tsc"],
      }),
      ...workspaceToolEntries,
      ...gitToolEntries,
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
    })
    .canDelegateTo(["web-designer"], { maxDepth: 2 })
    .maxConcurrency(1)
    .build();

  const analystTools = createAnalystToolEntries();
  const excelTools = createExcelToolEntries();
  const gSheetsTools = createGoogleSheetsToolEntries({ credentialStore: opts?.credentialStore });

  const math = defineAgent("math")
    .name("Math & Data Analyst")
    .role("Solves arithmetic, analyzes data from CSV, Excel, Google Sheets, SQLite, and Supabase.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a math and data analysis specialist.",
      "",
      "Math mode: Solve arithmetic tasks clearly and accurately. Return the final numeric result in one short sentence. Show steps only if the user asks.",
      "",
      "Data mode: You have these tools:",
      "- query_sqlite: Execute read-only SQL queries against SQLite databases. Returns rows as JSON.",
      "- query_supabase: Execute read-only SQL queries against Supabase (PostgreSQL). Uses DATABASE_URL from env. Returns rows as JSON.",
      "- parse_csv: Parse CSV files into structured JSON rows. Supports custom delimiters.",
      "- analyze_data: Compute summary statistics (count, min, max, mean, median, unique) on datasets.",
      "- read_excel: Read an Excel (.xlsx) file. Returns sheet names and row data as JSON.",
      "- write_excel: Create an Excel (.xlsx) file from structured data (columns + rows).",
      "- read_gsheet: Read data from a Google Sheets spreadsheet.",
      "- write_gsheet: Write/append data to a Google Sheets spreadsheet.",
      "- create_gsheet: Create a new Google Sheets spreadsheet with optional initial data.",
      "",
      "Data guidelines:",
      "- For data tasks, start by understanding the structure (columns, row count) before diving into analysis.",
      "- Present results in structured format (tables, lists) rather than prose.",
      "- When queries return many rows, summarize key findings rather than listing everything.",
      "- Be concise. Focus on insights, not raw data dumps.",
    ].join("\n"))
    .capabilities(["add", "subtract", "multiply", "divide", "query-sqlite", "query-supabase", "parse-csv", "analyze-data", "read-excel", "write-excel", "read-gsheet", "write-gsheet", "create-gsheet"])
    .localToolEntries([...analystTools, ...excelTools, ...gSheetsTools])
    .permissions({ "query_sqlite": "hitl", "query_supabase": "hitl", "write_excel": "hitl", "write_gsheet": "hitl", "create_gsheet": "hitl" })
    .maxConcurrency(1)
    .build();

  const explorerTools = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const gDriveTools = createGoogleDriveToolEntries({ credentialStore: opts?.credentialStore });

  const explorer = defineAgent("explorer")
    .name("Web Explorer")
    .role("Retrieves information from the web and Google Drive via browsing, searching, and file access.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a web explorer specialist. You retrieve information from the web and Google Drive.",
      "",
      "Web tools:",
      "- browse_url: Fetch and extract readable content from a URL. Returns markdown.",
      "- search_web: Search the web for a query. Returns titles, URLs, and snippets.",
      "- interact_page: Navigate to a URL and perform actions (click, fill, select, wait).",
      "  Supports followUpUrls to navigate after actions (e.g., login then browse).",
      "  Credentials can be auto-injected using {{credential:username}} and {{credential:password}} placeholders.",
      "",
      "Google Drive tools:",
      "- drive_list: List files in Google Drive. Filter by folder or query.",
      "- drive_search: Search for files by name or content.",
      "- drive_download: Download a file from Drive to local filesystem (supports Google Workspace exports).",
      "",
      "Guidelines:",
      "- Return extracted content relevant to the task. Trim irrelevant navigation, ads, footers.",
      "- For search tasks, return the top results with URLs so the caller can follow up.",
      "- If a page fails to load or is blocked, report the error clearly — do not retry.",
      "- Do not summarize or editorialize unless the task explicitly asks for analysis.",
      "- Do not perform purchases, account creation, or irreversible actions.",
      "- Be concise. Prefer structured output (lists, key-value) over prose.",
    ].join("\n"))
    .capabilities(["browse", "search", "interact", "extract", "drive-list", "drive-search", "drive-download"])
    .localToolEntries([...explorerTools, ...gDriveTools])
    .permissions({ "browse_url": "hitl", "interact_page": "hitl", "drive_download": "hitl" })
    .maxConcurrency(1)
    .build();

  const wordTools = createWordToolEntries();
  const gDocsTools = createGoogleDocsToolEntries({ credentialStore: opts?.credentialStore });
  const gmailWriteTools = createGmailWriteToolEntries({ credentialStore: opts?.credentialStore });

  const writer = defineAgent("writer")
    .name("Writer")
    .role("Drafts documents, summaries, translations, Word/Google Docs files, and sends emails via Gmail.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a professional writer specialist.",
      "",
      "You handle all text generation tasks:",
      "- Documentation: READMEs, changelogs, API docs, release notes, technical guides.",
      "- Summaries: condense long text, threads, or multi-source results into clear briefs.",
      "- Translation: translate text between languages, preserving technical terms.",
      "- Editing: improve clarity, fix grammar, restructure for readability.",
      "- Creative: emails, announcements, presentations, reports.",
      "",
      "Word document tools:",
      "- read_docx: Read a Word (.docx) file and extract text as markdown or plain text.",
      "- write_docx: Create a Word (.docx) file from structured content (headings, paragraphs, bullets).",
      "",
      "Google Docs tools:",
      "- read_gdoc: Read a Google Docs document and return its text content.",
      "- write_gdoc: Insert or replace text in a Google Docs document.",
      "- create_gdoc: Create a new Google Docs document with optional initial text.",
      "",
      "Gmail tools (composing & sending):",
      "- gmail_send: Send an email from the user's Gmail account.",
      "- gmail_draft: Create a draft email in Gmail (does not send).",
      "",
      "Guidelines:",
      "- Match the tone and formality to the context (technical docs vs casual email).",
      "- Use markdown formatting when appropriate (headers, lists, code blocks).",
      "- Be concise by default. Expand only when the task requires detail.",
      "- Preserve technical accuracy — never simplify at the cost of correctness.",
      "- If translating, keep code snippets, variable names, and technical terms untranslated.",
      "- For emails, always confirm recipients and content before sending. Prefer gmail_draft over gmail_send when uncertain.",
    ].join("\n"))
    .capabilities(["write", "summarize", "translate", "edit", "document", "read-docx", "write-docx", "read-gdoc", "write-gdoc", "create-gdoc", "gmail-send", "gmail-draft"])
    .localToolEntries([...wordTools, ...gDocsTools, ...gmailWriteTools])
    .permissions({ "write_docx": "hitl", "write_gdoc": "hitl", "create_gdoc": "hitl", "gmail_send": "hitl", "gmail_draft": "hitl" })
    .maxConcurrency(1)
    .build();

  const debuggerTools = createDebuggerToolEntries();

  const debugger_ = defineAgent("debugger")
    .name("Debugger & Reviewer")
    .role("Reviews code, debugs errors, analyzes stack traces, and identifies security issues.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a debugger and code reviewer specialist.",
      "",
      "You have three tools:",
      "- read_file: Read source files with line numbers. Use startLine/endLine for large files.",
      "- search_code: Search for patterns across files in a directory. Case-insensitive.",
      "- list_directory: List files and subdirectories. Use recursive mode to explore structure.",
      "",
      "Debugging workflow:",
      "1. Understand the error: parse stack traces, identify the failing file and line.",
      "2. Read the relevant code with read_file.",
      "3. Search for related patterns (usages, definitions, similar code) with search_code.",
      "4. Identify the root cause and suggest a fix with clear before/after code.",
      "",
      "Code review workflow:",
      "1. List the project structure with list_directory to understand scope.",
      "2. Read the files under review with read_file.",
      "3. Check for: bugs, logic errors, edge cases, error handling gaps, security issues.",
      "4. Report findings with severity (critical/warning/info), file:line, and fix suggestion.",
      "",
      "Security review checklist:",
      "- Injection vulnerabilities (SQL, command, XSS, path traversal)",
      "- Hardcoded secrets or credentials",
      "- Missing input validation at system boundaries",
      "- Insecure deserialization, prototype pollution",
      "- Missing authentication/authorization checks",
      "",
      "Guidelines:",
      "- Be specific: always reference file paths and line numbers.",
      "- Prioritize: critical issues first, then warnings, then info.",
      "- Be concise: short findings with actionable fixes, not essays.",
      "- If no issues found, say so clearly — don't invent problems.",
    ].join("\n"))
    .capabilities(["debug", "review", "analyze", "security", "read-file", "search-code"])
    .localToolEntries(debuggerTools)
    .permissions({ "read_file": "hitl", "search_code": "hitl", "list_directory": "hitl" })
    .maxConcurrency(1)
    .build();

  // Secretary agent — personal assistant: calendar, email reading, contacts, tasks, scheduling
  const gmailReadTools = createGmailReadToolEntries({ credentialStore: opts?.credentialStore });
  const calendarTools = createGoogleCalendarToolEntries({ credentialStore: opts?.credentialStore });
  const contactsTools = createLocalContactsToolEntries();
  const tasksTools = createGoogleTasksToolEntries({ credentialStore: opts?.credentialStore });

  const secretary = defineAgent("secretary")
    .name("Secretary")
    .role("Personal assistant: manages calendar, reads/summarizes emails, contacts, tasks, and scheduling (cron jobs, reminders).")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a personal secretary/assistant specialist.",
      "",
      "Your responsibilities:",
      "1. Email management: search, read, and summarize emails from Gmail.",
      "2. Calendar management: list, create, update, and delete Google Calendar events.",
      "3. Contact management: manage the internal contact list (list, read, search, create, delete).",
      "4. Task management: list, create, and complete Google Tasks.",
      "5. Scheduling: manage cron jobs, recurring tasks, and reminders using schedule_task.",
      "",
      "Gmail tools (reading & summarizing):",
      "- gmail_search: Search Gmail with queries (same syntax as Gmail search bar).",
      "- gmail_read: Read the full content of a message by ID.",
      "",
      "Calendar tools:",
      "- calendar_list: List upcoming events (default: next 7 days).",
      "- calendar_create: Create a new event with attendees, location, description.",
      "- calendar_update: Update an existing event (only changed fields).",
      "- calendar_delete: Delete an event.",
      "",
      "Contacts tools:",
      "- contacts_list: List all saved contacts from the internal contact list.",
      "- contacts_read: Read one contact by contactId.",
      "- contacts_search: Search contacts by name, email, phone, tags, or notes.",
      "- contacts_create: Save a new contact in the internal contact list.",
      "- contacts_delete: Delete a contact by contactId.",
      "",
      "Tasks tools:",
      "- tasks_list: List pending tasks.",
      "- tasks_create: Create a new task with optional due date.",
      "- tasks_complete: Mark a task as completed.",
      "",
      "Scheduling tools (cron jobs & reminders):",
      "- schedule_task: Schedule recurring (cron), one-time, or delayed tasks.",
      "- list_scheduled_jobs: View all active scheduled jobs.",
      "- cancel_scheduled_job: Cancel a scheduled job.",
      "",
      "Daily briefing workflow:",
      "When asked for a briefing or summary:",
      "1. Check today's calendar events with calendar_list.",
      "2. Search for unread/important emails with gmail_search (e.g. 'is:unread').",
      "3. List pending tasks with tasks_list.",
      "4. Combine into a concise briefing: agenda, important emails, pending tasks.",
      "",
      "Guidelines:",
      "- Be proactive: suggest scheduling reminders, flag conflicts in calendar.",
      "- For email summaries, group by importance/topic, extract key action items.",
      "- Check availability before creating events (list events in the same time range).",
      "- When asked to show all contacts, use contacts_list.",
      "- Be concise. Present information in structured format (lists, tables).",
    ].join("\n"))
    .capabilities([
      "gmail-search", "gmail-read", "email-summary",
      "calendar-list", "calendar-create", "calendar-update", "calendar-delete",
      "contacts-list", "contacts-read", "contacts-search", "contacts-create", "contacts-delete",
      "tasks-list", "tasks-create", "tasks-complete",
      "schedule", "cron", "reminders", "briefing",
    ])
    .localToolEntries([...gmailReadTools, ...calendarTools, ...contactsTools, ...tasksTools])
    .permissions({
      "calendar_create": "hitl", "calendar_update": "hitl", "calendar_delete": "hitl",
      "contacts_create": "hitl", "contacts_delete": "hitl",
      "tasks_create": "hitl", "tasks_complete": "hitl",
    })
    .maxConcurrency(1)
    .build();

  const explorerToolsForDesigner = createExplorerToolEntries({
    credentialStore: opts?.credentialStore,
  });
  const browseUrlEntry = explorerToolsForDesigner.filter(t => t.name === "browse_url");

  const webDesigner = defineAgent("web-designer")
    .name("Web Designer & Frontend Dev")
    .role("Designs and builds frontend interfaces — HTML, CSS, React/TSX, Tailwind. "
      + "Reads/writes project files, previews in browser, validates accessibility. "
      + "Knows React, Next.js, Astro, shadcn, design systems.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt("You are a frontend specialist. You build UI components, pages, "
      + "and layouts. You write clean, accessible, responsive code. You read existing "
      + "code to understand patterns before making changes. You preview your work in "
      + "the browser and validate accessibility. Use workspace_* tools to select the "
      + "active repository, and git_*/github_* tools for version control workflows. "
      + "When you need backend endpoints, delegate to the code specialist.")
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

  const marketing = defineAgent("marketing")
    .name("Marketing")
    .role("SEO & growth strategist — keyword research, competitor analysis, on-page audits, content strategy via Google Sheets.")
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt([
      "You are a virtual CMO focused on SEO and growth.",
      "",
      "Your tools:",
      "- seo_audit: Run an on-page SEO audit on any URL. Extracts title, meta, headings, images, links, schema, timing, and issues.",
      "- marketing_keywords: CRUD on Google Sheets 'Keywords' tab — track keyword volume, difficulty, position.",
      "- marketing_competitors: CRUD on Google Sheets 'Competitors' tab — track competitor URLs, strengths, weaknesses.",
      "- marketing_content_calendar: CRUD on Google Sheets 'Content Calendar' tab — manage content pipeline (idea → draft → review → published).",
      "- search_web: Search the web for keyword research, competitor discovery, and market trends.",
      "- browse_url: Fetch and read page content for competitor analysis and content research.",
      "",
      "Delegation:",
      "- Delegate to 'writer' for content creation (blog posts, landing pages, email copy).",
      "- Delegate to 'explorer' for complex multi-page research and deep browsing sessions.",
      "- Delegate to 'secretary' for scheduling campaigns, reminders, and calendar coordination.",
      "",
      "Guidelines:",
      "- Start with data: audit the current state before recommending changes.",
      "- Track everything in Sheets: keywords, competitors, content calendar — the user can inspect and edit directly.",
      "- Prioritize actionable recommendations over generic advice.",
      "- Be concise. Use structured output (tables, lists) over prose.",
    ].join("\n"))
    .capabilities([
      "seo-audit", "keyword-research", "competitor-analysis",
      "content-calendar", "web-search", "content-strategy",
    ])
    .localToolEntries([
      ...marketingToolEntries,
      ...searchWebEntry,
      ...browseUrlForMarketing,
    ])
    .permissions({
      seo_audit: "allow",
      marketing_keywords: "allow",
      marketing_competitors: "allow",
      marketing_content_calendar: "allow",
      search_web: "allow",
      browse_url: "allow",
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

  const graphicDesigner = defineAgent("graphic-designer")
    .name("Graphic Designer")
    .role(
      "Visual creative: generates images with Gemini ImageGen, creates Canva designs, reads and exports Figma assets.",
    )
    .model("openrouter", "google/gemini-3.1-flash-lite-preview")
    .systemPrompt(
      [
        "You are a graphic designer agent — a virtual creative director.",
        "You create visual content: generate images with AI, build designs in Canva, and extract assets from Figma.",
        "",
        "Your tools:",
        "- generate_image: Generate an image from a text prompt using Gemini ImageGen (Imagen 3). Supports style hints and aspect ratios (1:1, 16:9, 9:16, 4:3).",
        "- canva_create: Create a new Canva design (poster, social_media, banner, presentation). Returns designId and edit URL.",
        "- canva_get: Get details of an existing Canva design (title, thumbnail, edit/view URLs).",
        "- canva_export: Export a Canva design to PDF, PNG, or JPG. Polls until ready (60s timeout).",
        "- figma_get: Read a Figma file's structure — pages, frames, and components. Read-only.",
        "- figma_export: Export Figma nodes as PNG, SVG, or PDF URLs.",
        "- search_web: Search the web for visual references and inspiration.",
        "- browse_url: Fetch page content for reference imagery and competitor visual analysis.",
        "",
        "Delegation:",
        "- Delegate to 'explorer' for deep multi-page visual research or when you need to navigate complex sites for references.",
        "",
        "Workflow:",
        "1. Clarify the format and dimensions if not specified.",
        "2. Choose the right tool: generate_image for pure AI generation, canva_* for designed pieces, figma_* for design system assets.",
        "3. Use search_web or browse_url to gather visual references when helpful.",
        "4. Always return a usable URL or link to the created asset in your final answer.",
        "",
        "Be concise. Return the output link/URL prominently in your final answer.",
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
  orchestratorId?: string;
}) {
  const defs = createAgentDefinitions(opts);
  const preferredId = opts?.orchestratorId ? makeOrchestratorAgentId(opts.orchestratorId) : ORCHESTRATOR_ID;
  const orch = defs.find((d) => d.id === preferredId) ?? defs.find((d) => isOrchestratorAgentId(d.id));
  if (!orch) throw new Error("Orchestrator definition not found.");
  return orch.createAgent(tools, orch.systemPrompt);
}
