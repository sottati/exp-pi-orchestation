# Figma API Reference Guide

How to find IDs, understand file structure, and choose export formats.

---

## Extracting IDs from Figma URLs

### fileId
Located in the file URL:
```
https://www.figma.com/file/[fileId]/file-name
https://www.figma.com/design/[fileId]/file-name
```
Example: `https://www.figma.com/file/ABC123def456/My-Design-System` → fileId = `ABC123def456`

### nodeId
Appears in the URL when an element is selected in Figma:
```
https://www.figma.com/file/[fileId]/name?node-id=[nodeId]
```
Node IDs use the format `123:456` (page number : element number).

If the user doesn't have the nodeId, call `figma_get` first and find the element by name in the structure.

---

## figma_get Response Structure

```json
{
  "name": "Design System",
  "pages": [
    {
      "id": "0:1",
      "name": "Components",
      "children": [
        {
          "id": "1:23",
          "name": "Icons",
          "type": "FRAME",
          "children": [
            { "id": "1:24", "name": "icon-arrow", "type": "COMPONENT" },
            { "id": "1:25", "name": "icon-check", "type": "COMPONENT" }
          ]
        }
      ]
    }
  ]
}
```

Navigate the `children` hierarchy to find elements by `name`.

---

## Export Format Decision

| Format | Best for | Notes |
|--------|----------|-------|
| SVG | Icons, logos, UI components, illustrations | Scalable, small file size, editable in code |
| PNG | Screenshots, raster previews, documentation | Fixed resolution, supports transparency |
| PDF | Full artboards, multi-page documents, print | Vector preserved, multi-page support |

**Default recommendation by element type:**
- Icons → SVG
- Illustrations → SVG (if vector) or PNG
- Photos/images embedded in Figma → PNG
- Full page layout for reference → PNG or PDF
- Print-ready artboard → PDF

---

## Common Node Types in figma_get

| Type | Description |
|------|-------------|
| `FRAME` | Container/artboard, often represents a screen or section |
| `COMPONENT` | Reusable component definition |
| `INSTANCE` | Instance of a component |
| `GROUP` | Non-component grouping |
| `TEXT` | Text layer |
| `VECTOR` | Vector shape |
| `RECTANGLE` | Rectangle shape |

When exporting icons or components, target `COMPONENT` nodes.
When exporting screens or layouts, target `FRAME` nodes.

---

## Access Requirements

- Requires `FIGMA_ACCESS_TOKEN` configured in the credential store or env vars.
- Token must have at least `file:read` permission on the target file.
- For files in team spaces, the token owner must be a member of that team.
- figma_get and figma_export are **read-only** — they never modify the Figma file.
