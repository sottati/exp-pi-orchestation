---
name: browser-results
description: Cuando recibís un resultado de interact_page y necesitás interpretarlo, decidir si fue exitoso, recuperarte de bloqueos, extraer la información útil, o decidir si encadenar con browse_url o search_web.
metadata:
  version: 1.0.0
---

# Interpreting interact_page Results

`interact_page` devuelve un **Interaction Report** estructurado. Esta skill te enseña a leerlo y actuar en consecuencia.

---

## Estructura del reporte

```
Interaction Report
Status: <STATUS>
Final URL: <url>
Steps executed: <n>
Actions observed: <navigate, click, extract, ...>

Visited URLs (<n>):
1. <url>
2. <url>

Main findings:
<contenido principal extraído>

Additional extracted findings:
1. <hallazgo complementario>
2. ...

Warnings/Errors:
1. <error o advertencia>
```

- **Main findings** es el resultado principal: el contenido, datos, o respuesta que browser-use extrajo.
- **Additional extracted findings** son hallazgos secundarios — pueden complementar o duplicar el principal.
- **Visited URLs** muestra el recorrido; si hay redirecciones inesperadas, es una señal de problema.
- **Actions observed** da contexto sobre qué hizo el agente (navigate, click, input, extract, scroll, etc.).

---

## Decisión por Status

### SUCCESS
El agente completó la tarea y tiene datos confiables.
- Usá **Main findings** como fuente primaria.
- Revisá **Additional extracted findings** para datos complementarios — descartá duplicados.
- Si el contenido está truncado (`...[truncated]`), podés recuperar la versión completa con `browse_url` en **Final URL**.

### DONE
Completó sin errores pero sin confirmación explícita de éxito.
- Tratalo igual que SUCCESS. Verificá que **Main findings** tenga contenido relevante.

### DONE_WITH_WARNINGS
Completó pero con advertencias.
- Leé **Warnings/Errors** primero para entender qué falló parcialmente.
- Si el hallazgo principal igual es válido, usalo. Si los warnings sugieren datos incompletos, considerá `browse_url` en **Final URL** para validar.

### PARTIAL o PARTIAL_WITH_ERRORS
El agente no llegó al final de la tarea o tuvo errores en el camino.
- No confíes en **Main findings** como respuesta definitiva.
- Estrategia de recuperación:
  1. Intentá `browse_url` en **Final URL** para extraer el estado actual de la página.
  2. Si el problema fue navegación, reformulá la tarea con más precisión y reintentá `interact_page`.
  3. Si después de 2 intentos sigue parcial, reportá lo que tenés y marcá el hallazgo como incompleto.

### BLOCKED
El agente encontró un obstáculo infranqueable. Lee el motivo exacto en **Main findings**:

| Patrón en Main findings | Acción |
|------------------------|--------|
| `BLOCKED: CAPTCHA detected at <url>` | No reintentes. Reportá que la página requiere resolución manual de CAPTCHA. |
| `BLOCKED: authentication failed - <reason>` | Verificá si hay credenciales disponibles con `get_credential_fields`. Si no hay credenciales, solicitá con `request_credentials`. No reintentes sin credenciales válidas. |
| `BLOCKED: paywall at <url>` | Buscá alternativas: `search_web` para versiones cacheadas, fuentes alternativas, o fragmentos públicos de la misma información. |

---

## Cuándo usar interact_page vs browse_url

| Situación | Tool |
|-----------|------|
| Página estática, solo necesitás leer el contenido | `browse_url` |
| Necesitás hacer login, rellenar formularios, navegar paginación | `interact_page` |
| Querés confirmar/ampliar un resultado PARTIAL o truncado | `browse_url` en Final URL |
| La página tiene contenido dinámico que requiere JS para cargarse | `browse_url` con `waitFor` o `interact_page` |
| Tenés una URL exacta y no necesitás interacción | `browse_url` — es más rápido y sin costo de LLM |

---

## Síntesis cuando combinás múltiples interact_page

Si encadenaste varias llamadas (distintas URLs o reintentos):
1. Priorizá los resultados con status SUCCESS o DONE.
2. Marcá explícitamente qué datos vienen de qué URL.
3. Si dos resultados contradicen, preferí el de mayor status y mayor cantidad de steps ejecutados.
4. Si un resultado tiene `...[truncated]`, indícalo en tu respuesta final como "datos posiblemente incompletos".

---

## Formato de respuesta al orquestador

Cuando reportás el resultado de un `interact_page`:

```
Fuente: [Final URL]
Estado: [Status del reporte]

[Hallazgos principales — sin narrar los clicks, solo los datos]

[Si hubo advertencias o bloqueos, mencionarlos al final]
```

Nunca describas los pasos que browser-use ejecutó (clicks, navegaciones) a menos que el orquestador lo pida explícitamente. Solo reportá los datos extraídos.
