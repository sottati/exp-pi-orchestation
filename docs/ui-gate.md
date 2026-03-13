# UI Gate for MPV

Este documento define cuando activar una UI y migrar a monorepo con Turbo.

## Regla de decisión

Mantener terminal-first mientras no exista fricción operativa fuerte.

Activar UI cuando se cumpla al menos una:

- `maxParallelTasks > 1`
- `taskQueued >= 5` por sesión
- `traceEvents >= 400` por sesión

## Comando

```sh
bun run ui:gate
```

Opcional:

```sh
bun run ui:gate --session my-session
```

## Resultado esperado

- `STAY_TERMINAL`: seguir con CLI como interfaz principal.
- `ENABLE_UI`: habilitar fase de monorepo con Turbo.

## Estructura recomendada si se activa UI

- `apps/cli`
- `apps/web`
- `packages/agent-runtime`
- `packages/contracts`
- `packages/store`
