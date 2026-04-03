---
name: canva-design
description: "When the user wants to create a design in Canva, or needs a banner, poster, flyer, social media post, Instagram post, Facebook cover, LinkedIn banner, presentation slide, thumbnail, or any designed piece with text and layout. Also use when the user mentions 'social media design,' 'branded post,' 'create a banner,' 'make a flyer,' 'canva,' 'post template,' 'story design,' 'ad creative,' 'I need a designed piece,' 'diseño en Canva,' 'banner,' 'flyer,' 'poster,' 'diseño de post,' 'pieza gráfica,' or 'hacer un diseño.'"
metadata:
  version: 1.0.0
---

# Canva Design

## Cuándo Usar Canva vs. generate_image

| Necesidad | Herramienta |
| --------- | ----------- |
| Pieza editable con texto, logo, CTAs, layout | `canva_create` |
| Imagen pura artística o fotográfica sin texto | `generate_image` |
| Asset visual para insertar en un diseño Canva | `generate_image` primero, luego Canva para componer |
| Asset de design system existente | `figma_export` |

---

## Tipos de Diseño (`designType`)

| Tipo | Casos de uso |
| ---- | ------------ |
| `poster` | Flyers, afiches, eventos, comunicados, carteles |
| `social_media` | Posts de Instagram, Facebook, LinkedIn, stories |
| `banner` | Banners web, email headers, portadas de redes |
| `presentation` | Slides para pitches, reportes, demos, propuestas |

---

## Flujo de Trabajo

1. **`canva_create`** — Creá el diseño con `title` y `designType`. Devuelve `designId` y `editUrl`.
2. **`canva_get`** — Verificá el estado y obtené el thumbnail para confirmar con el usuario.
3. **`canva_export`** — Exportá a PDF/PNG/JPG cuando el diseño esté listo (timeout 60s).

> Compartí siempre la `editUrl` para que el usuario pueda personalizar el diseño en Canva.

---

## Formato de Exportación

| Formato | Cuándo usarlo |
| ------- | ------------- |
| PNG | Web, redes sociales, fondo transparente |
| JPG | Fotografías, email, menor peso de archivo |
| PDF | Impresión, presentaciones formales |

---

## Información a Recopilar Antes de Crear

Si el brief es vago o incompleto:

1. **Plataforma/canal** — ¿Instagram, LinkedIn, email, impresión, web?
2. **Mensaje principal y CTA** — ¿Qué dice y qué acción busca?
3. **Colores de marca** — ¿Hay brand kit o paleta definida?
4. **Texto a incluir** — Titular, subtítulo, logo, URL, disclaimer
5. **Referencias** — ¿Hay un diseño previo o estilo que tomar como base?

---

**Para dimensiones exactas, specs por plataforma y checklist de diseño**: Ver [references/design-specs.md](references/design-specs.md)

---

## Principios de Diseño

**Jerarquía visual**: El ojo sigue un camino — titular → visual → CTA. Lo más importante, más prominente.

**Espacio negativo**: El espacio vacío no es desperdicio — da respiro y dirige la atención.

**Contraste**: Texto siempre legible sobre el fondo. Texto claro sobre imagen → necesita overlay oscuro.

**Consistencia**: Mismos colores, fuentes y estilo en todas las piezas de una misma campaña.
