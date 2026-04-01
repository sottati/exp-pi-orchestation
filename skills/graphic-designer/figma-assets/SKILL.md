---
name: figma-assets
description: "When the user wants to extract, export, or inspect assets from a Figma file. Also use when the user mentions 'Figma,' 'design system,' 'export from Figma,' 'get Figma assets,' 'components from Figma,' 'icons from Figma,' 'export SVG,' 'get icons,' 'inspect Figma,' 'Figma file,' 'extraer de Figma,' 'exportar Figma,' 'assets de Figma,' or 'componentes de Figma.'"
metadata:
  version: 1.0.0
---

# Figma Assets

## Flujo de Trabajo

### 1. Inspeccionar el archivo
`figma_get` con el `fileId` → Devuelve la estructura: páginas, frames, componentes y sus `nodeId`.

### 2. Identificar los nodos a exportar
Buscá en la estructura devuelta los frames o componentes por nombre. Anotá sus `nodeId`.

### 3. Exportar
`figma_export` con los `nodeIds` y el formato elegido → Devuelve URLs de descarga.

---

## Formatos de Exportación

| Formato | Cuándo usarlo |
|---------|---------------|
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

Si el usuario no tiene el nodeId, usá `figma_get` primero para listar la estructura y encontrar el elemento por nombre.

---

## Límites

- `figma_get` y `figma_export` son **solo lectura** — no modifican el archivo.
- Solo accedés a archivos con permiso del token de acceso configurado (`FIGMA_ACCESS_TOKEN`).
- Los componentes con fuentes no instaladas pueden renderizarse con fuente de fallback.
