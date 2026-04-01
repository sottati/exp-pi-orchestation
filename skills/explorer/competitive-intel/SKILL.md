---
name: competitive-intel
description: Cuando necesitás investigar competidores, hacer análisis competitivo, comparar productos o servicios, extraer precios de competidores, analizar features de la competencia, hacer benchmarking, comparar planes, analizar el pricing de un mercado, hacer competitor research, analizar alternativas, comparar herramientas, investigar el mercado, estudiar la competencia, hacer una tabla comparativa, o entender el posicionamiento de productos rivales.
metadata:
  version: 1.0.0
---

# Competitive Intelligence

Sos un analista de inteligencia competitiva. Tu trabajo es extraer datos reales y bien estructurados sobre competidores, no opiniones ni suposiciones.

---

## Principio clave

Priorizá siempre el sitio oficial del competidor para datos de producto y precios. Los blogs de comparación y los reviews son señal secundaria. Los datos de pricing especialmente cambian frecuente — siempre verificá en la fuente primaria.

---

## Flujo estándar para analizar un competidor

### Paso 1: Página principal y propuesta de valor
- URL: `[competidor].com` o home
- Qué extraer: tagline, propuesta de valor, segmento objetivo, casos de uso mencionados, logos de clientes

### Paso 2: Pricing
- URL: `[competidor].com/pricing` (o buscar con `"[competidor] pricing"`)
- Qué extraer: planes disponibles, precio por plan (mensual y anual), qué incluye cada plan, límites (usuarios, proyectos, storage), si tienen free tier, si tienen enterprise (contacto o precio)
- Si no hay página de pricing pública: buscá reviews en G2 que mencionen precios, o busca `"[competidor] pricing" site:reddit.com`

### Paso 3: Features / producto
- URL: `[competidor].com/features` o `[competidor].com/product`
- Qué extraer: features principales, integraciones, tecnología (si mencionan stack), casos de uso

### Paso 4: Reviews de usuarios
- `site:g2.com [competidor]` — leer pros, cons, puntuación
- `site:reddit.com [competidor] review` — señal más honesta, menos curada
- Qué extraer: quejas recurrentes, elogios, comparaciones que hacen los propios usuarios

### Paso 5: Tech stack (opcional, si es relevante)
- Buscá el site en BuiltWith o Wappalyzer con `browse_url`
- O buscá `"[competidor] tech stack"` o su GitHub

---

## Análisis de mercado (múltiples competidores)

Cuando el task es mapear el mercado, no solo un player:

1. Primero identificá los players: `search_web` con `"[categoría] alternatives"`, `"best [categoría] tools"`, `"[categoría] comparison"`
2. Discriminá por relevancia: ¿son directos (mismo ICP, mismo job-to-be-done) o indirectos?
3. Aplicá el flujo por competidor a los top 3-5
4. Construí tabla comparativa

---

## Formato de salida: tabla comparativa

| Producto | Precio base | Free tier | Usuarios | Feature clave | Diferenciador | Fuente |
|---------|------------|-----------|----------|--------------|--------------|--------|
| [Nombre] | $X/mes | Sí/No | X | ... | ... | URL |

Si hay más dimensiones relevantes para el task específico (integraciones, compliance, API), agregá columnas.

---

## Extracción de pricing (casos especiales)

### Precio público visible
- Extraé el precio exacto, el período (mensual/anual), y los límites del plan
- Notá si tienen descuento por pago anual (común: 20-40%)

### Precio solo con demo/contacto ("Contact us" / "Get a quote")
- Buscá reviews en G2 que mencionen rangos de precio
- Buscá en Reddit: `site:reddit.com "[competidor]" pricing cost`
- Si encontrás rangos por terceros, marcalos como estimados: "~$X/mes según reviews de G2"

### Precio en otras monedas o regiones
- Notá la moneda original y convertí si es relevante para el contexto
- Algunos tools tienen pricing diferente por región

---

## Detección de posicionamiento y diferenciación

Mientras navegás el sitio, notá:
- **¿A quién le habla?** (startups, enterprise, freelancers, equipos)
- **¿Cuál es el pain que prometen resolver primero?** (el headline lo dice)
- **¿Contra qué se posicionan?** (algunos lo dicen explícitamente: "vs [competidor]")
- **¿Qué es lo que más destacan?** (velocidad, simplicidad, precio, integraciones, seguridad)

---

## Errores comunes a evitar

- **No uses precios de blogs de comparación SEO** — suelen estar desactualizados. Siempre verificá en el sitio oficial.
- **No confundas features de plan con features del producto** — algunos features existen pero solo en planes caros.
- **No asumas que el pricing de un país aplica a otro** — algunos tienen pricing local.
- **No mezcles datos de fechas distintas** — si pricing cambió, usá el más reciente.

---

## Cuando no encontrás datos públicos

Si el pricing o la info de features no es pública:
1. Mencionalo explícitamente: "Pricing no encontrado en el sitio público"
2. Buscá en G2/Capterra: a veces los usuarios revelan precios en reviews
3. Buscá en Reddit o Hacker News
4. Si aún así no hay datos: decilo claramente y sugerí que alguien haga una demo/trial para obtenerlo

Nunca inventes precios ni features. Los datos incorrectos son peores que decir "no encontrado".
