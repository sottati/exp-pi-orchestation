---
name: image-generation
description: "When the user wants to generate, create, or produce an image, illustration, artwork, photo, visual, logo, icon, or any graphic using AI. Also use when the user mentions 'generate an image,' 'create a picture,' 'make an illustration,' 'AI image,' 'text to image,' 'I need a visual,' 'draw,' 'AI art,' 'hero image,' 'thumbnail,' 'product mockup,' 'generate a photo,' 'create artwork,' 'generar imagen,' 'crear imagen,' 'generá una imagen,' 'ilustración,' 'artwork,' or 'hacer una imagen.'"
metadata:
  version: 1.0.0
---

# Image Generation with Gemini Imagen 3

## Before Generating

Extract these details before writing the prompt. Ask only what's missing:

1. **Sujeto principal** — ¿Qué es lo central de la imagen? (persona, objeto, escena, logo, etc.)
2. **Estilo visual** — ¿fotorrealista, ilustración, flat design, minimalista, acuarela, 3D render, pixel art?
3. **Uso final** — ¿Dónde se va a usar? Esto determina el aspect ratio correcto.
4. **Paleta/Mood** — ¿Colores dominantes, temperatura, sensación? (azul corporativo, warm pastel, dark dramatic)
5. **Restricciones** — ¿Qué NO debe aparecer? ¿Hay guías de marca?

---

## Aspect Ratio por Caso de Uso

| Uso | Ratio |
|-----|-------|
| Post de Instagram (cuadrado), avatar, logo | 1:1 |
| Story, Reels, TikTok vertical | 9:16 |
| Banner web, YouTube thumbnail, hero image | 16:9 |
| Post LinkedIn / Facebook horizontal | 4:3 |

---

## Cómo Escribir un Prompt Efectivo

**Estructura**: `[sujeto] + [contexto/entorno] + [estilo visual] + [composición] + [paleta/iluminación]`

### Ejemplos

❌ **Prompt malo**: "una persona en una oficina"

✅ **Prompt bueno**: "profesional joven con laptop en oficina moderna minimalista, fotografía editorial corporativa, luz natural lateral cálida, paleta azul y blanco, encuadre horizontal con espacio negativo a la derecha, ultra realista"

---

❌ **Prompt malo**: "un logo de tecnología"

✅ **Prompt bueno**: "icono minimalista de un circuito neuronal estilizado, flat design, líneas geométricas limpias, color azul eléctrico sobre fondo blanco, estilo logotipo SaaS moderno, sin texto, alta resolución"

---

### Modificadores de Estilo

**Fotografía**: editorial, portrait photography, product photography, studio lighting, golden hour, cinematic, shallow depth of field

**Ilustración**: flat design, vector illustration, line art, watercolor, digital painting, isometric, hand-drawn, geometric

**3D y render**: 3D render, clay render, glass morphism, product visualization, hyperrealistic 3D, octane render

**Mood**: dark and moody, bright and airy, minimalist, vibrant, corporate clean, vintage, futuristic, pastel soft

---

## Iteración

Si el primer resultado no es el esperado:
- Más especificidad en el sujeto principal
- Agregar modificadores de estilo más concretos
- Especificar qué elementos NO deben aparecer
- Cambiar la paleta o temperatura de color

Generá 2-3 variaciones con prompts distintos si el usuario necesita opciones.

---

## Límites de generate_image

- **No genera texto legible** dentro de la imagen — para diseños con texto, combiná con Canva (ver `canva-design`)
- No garantiza composiciones exactas ni posicionamiento preciso de elementos
- Para imágenes con personas, genera representaciones genéricas, no personas reales identificables
