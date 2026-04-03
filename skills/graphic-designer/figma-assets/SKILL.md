---
name: figma-assets
description: "When the user wants to extract, export, or inspect assets from a Figma file. Also use when the user mentions 'Figma,' 'design system,' 'export from Figma,' 'get Figma assets,' 'components from Figma,' 'icons from Figma,' 'export SVG,' 'get icons,' 'inspect Figma,' 'Figma file,' 'extraer de Figma,' 'exportar Figma,' 'assets de Figma,' or 'componentes de Figma.'"
metadata:
  version: 1.1.0
---

# Figma Assets

## Cómo Conecta Figma

Figma está conectado vía el MCP server oficial (`@figma/mcp`). Cuando `FIGMA_ACCESS_TOKEN` está configurado, el runtime auto-conecta el server y las herramientas aparecen como `mcp:figma/*` en tu tool set.

No hay tools locales para Figma — todo pasa por el MCP server.

---

## Flujo de Trabajo

### 1. Inspeccionar el archivo
Usá la herramienta MCP de Figma para leer la estructura del archivo con el `fileId`. Devuelve páginas, frames, componentes y sus `nodeId`.

### 2. Identificar los nodos a exportar
Buscá en la estructura devuelta los frames o componentes por nombre. Anotá sus `nodeId`.

### 3. Exportar
Usá la herramienta MCP de Figma para exportar nodos con el formato elegido → Devuelve URLs de descarga.

---

## Formatos de Exportación

| Formato | Cuándo usarlo |
| ------- | ------------- |
| SVG | Iconos, logos, ilustraciones — escalable, ideal para web y UI |
| PNG | Assets raster, thumbnails, imágenes con transparencia |
| PDF | Documentos, impresión, presentaciones |

---

## Cómo Obtener los IDs

**fileId** — Está en la URL del archivo Figma:
```
https://www.figma.com/file/[fileId]/nombre-del-archivo
```

**nodeId** — Aparece en la URL al seleccionar un elemento en Figma:
```
?node-id=[nodeId]
```

Si el usuario no tiene el nodeId, inspeccioná el archivo primero para listar la estructura y encontrar el elemento por nombre.

---

## Límites

- Las herramientas Figma son **solo lectura** — no modifican el archivo.
- Solo accedés a archivos con permiso del token de acceso configurado (`FIGMA_ACCESS_TOKEN`).
- Los componentes con fuentes no instaladas pueden renderizarse con fuente de fallback.
- Si `FIGMA_ACCESS_TOKEN` no está configurado, el MCP server no se conecta y las tools no estarán disponibles.

**Para más detalle sobre URL parsing y tipos de nodos**: Ver [references/figma-api-guide.md](references/figma-api-guide.md)
