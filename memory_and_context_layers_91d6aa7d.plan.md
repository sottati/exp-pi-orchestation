---
name: Memory and context layers
overview: "Agregar tres capas de memoria y contexto al runtime multi-agente: context header por interlocutor, summary prefix para threads largos, y scratchpad de sesion compartido entre agents."
todos:
  - id: phase1-context-header
    content: "Fase 1: Inyectar context header por interlocutor en routeMessage de runtime.ts"
    status: pending
  - id: phase1-tests
    content: "Fase 1: Tests para context header en runtime.test.ts"
    status: pending
  - id: phase2-store
    content: "Fase 2: Agregar ThreadSummary, getSummary(), saveSummary() en thread-store.ts"
    status: pending
  - id: phase2-runtime
    content: "Fase 2: Implementar getOrCreateSummary() y modificar routeMessage para inyectar summary prefix"
    status: pending
  - id: phase2-tests
    content: "Fase 2: Tests para summary persistence y summary injection"
    status: pending
  - id: phase3-store
    content: "Fase 3: Agregar ScratchpadEntry, appendScratchpadEntry(), getScratchpad() en thread-store.ts"
    status: pending
  - id: phase3-tools
    content: "Fase 3: Agregar tools write_note y read_notes en tools.ts, ampliar OrchestratorToolDeps"
    status: pending
  - id: phase3-wiring
    content: "Fase 3: Wiring de scratchpad en runtime.ts e inyeccion de notas en contexto del orchestrator"
    status: pending
  - id: phase3-tests
    content: "Fase 3: Tests para scratchpad store y tools"
    status: pending
  - id: update-docs
    content: Actualizar README.md, CLAUDE.md y AGENTS.md con las nuevas features
    status: pending
isProject: false
---

# Capas de memoria y contexto para el runtime multi-agente

Tres mejoras incrementales al manejo de contexto en conversaciones intra-agente. Cada fase es independiente y entrega valor por si sola.

---

## Fase 1: Context header por interlocutor

**Problema**: Los specialists no saben si les habla un humano o el orchestrator. Responden igual en ambos casos.

**Cambio**: En `routeMessage` de [packages/core/runtime.ts](packages/core/runtime.ts), antes de construir el `userMessage`, prepender un header contextual basado en `input.initiator`.

**Logica**:

```ts
const contextHeader =
  input.initiator === "orchestrator"
    ? `[Delegated task from orchestrator. chatId=${input.chatId ?? "direct"}. Respond with the result only.]`
    : input.initiator === "specialist"
      ? `[Report from specialist ${input.fromAgentId}.]`
      : `[Direct conversation with user.]`;
```

Se concatena al inicio de `input.content` en el `userMessage`.

**Archivos a modificar**:

- [packages/core/runtime.ts](packages/core/runtime.ts): modificar `routeMessage` (linea ~642) para inyectar el header

**No se modifica**: el system prompt de los agents en `agents.ts` permanece igual. El header viaja como parte del mensaje, no del prompt.

---

## Fase 2: Summary prefix para threads largos

**Problema**: Cuando un thread supera la ventana de contexto (`historyWindowMessages`, default 50), los mensajes antiguos desaparecen silenciosamente del contexto del modelo.

**Cambio**: Cuando hay overflow, generar un resumen de los mensajes truncados y prependirlo como primer mensaje del contexto.

### 2.1 Persistencia del summary

Agregar a [packages/core/thread-store.ts](packages/core/thread-store.ts):

- Nuevo archivo por thread: `{threadHash}.summary.json` junto al `.jsonl` existente
- Estructura del summary:

```ts
interface ThreadSummary {
  threadId: string;
  summarizedUpTo: number; // cantidad de mensajes que cubre el summary
  content: string; // texto del resumen
  updatedAt: number;
}
```

- Metodos nuevos: `getSummary(threadId)`, `saveSummary(threadId, summary)`

### 2.2 Generacion del summary

Agregar un metodo privado en [packages/core/runtime.ts](packages/core/runtime.ts):

- `getOrCreateSummary(threadId, overflowMessages, existingSummary?)`:
  - Si no hay summary o `summarizedUpTo < overflowMessages.length`, generar uno nuevo
  - Usar el mismo modelo del agente destinatario (via `modelFor`) con un prompt de compactacion
  - El prompt de compactacion solo pide resumir los puntos clave de la conversacion en 3-5 oraciones
  - Persistir el resultado via `store.saveSummary()`
  - Cachear en memoria para evitar lecturas repetidas en el mismo run

### 2.3 Inyeccion en routeMessage

Modificar el bloque de contexto en `routeMessage` (lineas 636-640):

```ts
const history = await this.store.getThreadMessages(threadId);
const messages = history.map((h) => h.message);

let contextMessages: AgentMessage[];
if (messages.length > this.historyWindowMessages) {
  const overflow = messages.slice(0, -this.historyWindowMessages);
  const window = messages.slice(-this.historyWindowMessages);
  const summary = await this.getOrCreateSummary(threadId, overflow);
  contextMessages = [
    {
      role: "user",
      content: `[Conversation summary]\n${summary}`,
      timestamp: 0,
    },
    ...window,
  ];
} else {
  contextMessages = messages;
}
agent.replaceMessages(contextMessages);
```

**Archivos a modificar**:

- [packages/core/thread-store.ts](packages/core/thread-store.ts): `getSummary()`, `saveSummary()`, interfaz `ThreadSummary`
- [packages/core/runtime.ts](packages/core/runtime.ts): `getOrCreateSummary()`, modificar `routeMessage`

---

## Fase 3: Scratchpad de sesion

**Problema**: Lo que el orchestrator aprende en un thread con math no esta disponible cuando habla con code (ni al reves). No hay memoria compartida entre threads.

**Cambio**: Un store key-value por sesion que el orchestrator puede leer/escribir, inyectado automaticamente en su system prompt.

### 3.1 Persistencia

Agregar a [packages/core/thread-store.ts](packages/core/thread-store.ts):

- Archivo: `scratchpad.jsonl` en el directorio de sesion
- Estructura por entrada:

```ts
interface ScratchpadEntry {
  key: string;
  value: string;
  updatedAt: number;
}
```

- Metodos: `appendScratchpadEntry(entry)`, `getScratchpad(): ScratchpadEntry[]`
- `getScratchpad` devuelve la ultima version de cada key (dedup por key, queda la mas reciente)

### 3.2 Tools del orchestrator

Agregar en [packages/core/tools.ts](packages/core/tools.ts) dos tools nuevas dentro de `createOrchestratorTools`:

- `write_note`: parametros `{ key: string, value: string }`. Persiste via nuevo callback en `OrchestratorToolDeps`
- `read_notes`: sin parametros. Lee todas las notas actuales

Agregar a `OrchestratorToolDeps`:

```ts
writeNote: (key: string, value: string) => Promise<void>;
readNotes: () => Promise<ScratchpadEntry[]>;
```

### 3.3 Inyeccion en system prompt

En [packages/core/runtime.ts](packages/core/runtime.ts), en `createAgentForRoute`, cuando el agente es orchestrator, leer el scratchpad e inyectarlo al final del system prompt como bloque de contexto:

```
Session notes:
- key1: value1
- key2: value2
```

Esto requiere que `createAgentForRoute` (o el paso previo en `routeMessage`) sea async para leer el scratchpad de disco. Alternativa mas simple: inyectar las notas como primer mensaje `user` sintetico en lugar de modificar el system prompt, consistente con el patron del summary.

### 3.4 Wiring en runtime

En `createOrchestratorToolsForRun`, conectar los callbacks:

```ts
writeNote: (key, value) => this.store.appendScratchpadEntry({ key, value, updatedAt: now() }),
readNotes: () => this.store.getScratchpad(),
```

**Archivos a modificar**:

- [packages/core/thread-store.ts](packages/core/thread-store.ts): `ScratchpadEntry`, `appendScratchpadEntry()`, `getScratchpad()`
- [packages/core/tools.ts](packages/core/tools.ts): `write_note`, `read_notes`, ampliar `OrchestratorToolDeps`
- [packages/core/runtime.ts](packages/core/runtime.ts): wiring de callbacks, inyeccion de notas en contexto

---

## Tests

Cada fase incluye tests en los archivos existentes:

- **Fase 1**: test en `runtime.test.ts` que verifica que el content del mensaje incluye el header correcto segun `initiator`
- **Fase 2**: test en `thread-store.test.ts` (si existe) o nuevo, para `getSummary`/`saveSummary`. Test en `runtime.test.ts` que verifica que el summary se inyecta cuando hay overflow
- **Fase 3**: test en `thread-store.test.ts` para scratchpad CRUD. Test en `tools.test.ts` para las tools `write_note`/`read_notes`

## Documentacion

Actualizar [README.md](README.md), [CLAUDE.md](CLAUDE.md) y [AGENTS.md](AGENTS.md) despues de cada fase, como indican los guardrails del proyecto.
