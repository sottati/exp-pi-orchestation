---
name: mercadolibre
description: Skill para automatizar interacciones en MercadoLibre via browser-use
metadata:
  version: 1.0.0
---

# MercadoLibre — Guía de automatización

## Notas generales

MercadoLibre es accesible sin login para la mayoría de las búsquedas y páginas de productos. Solo necesitás login para ver información de ventas propias, compras o dashboard de vendedor.

## Búsqueda de productos

Para buscar productos:
1. Navegá a `https://www.mercadolibre.com.ar/` (o `.com.mx`, `.com.br`, etc. según el país del task)
2. Usá la barra de búsqueda o construí la URL directamente: `https://listado.mercadolibre.com.ar/[query-con-guiones]`
3. Filtrá por categoría, precio, condición (nuevo/usado) si el task lo especifica

### Formato de salida para resultados de búsqueda:
```
## Resultados de búsqueda: [query]

| Título | Precio | Condición | Vendedor | URL |
|--------|--------|-----------|---------|-----|
| ...    | $...   | Nuevo     | ...     | URL |
```

## Extracción de detalle de producto

Para un producto específico:
1. Hacé click en el resultado o navegá directamente a la URL del producto
2. Extraé: título completo, precio, precio tachado/descuento si hay, condición, stock disponible, descripción, características técnicas (tabla de specs), vendedor, calificación del vendedor, cantidad de ventas, fotos (URLs si son útiles)

### Formato de salida para producto:
```
Título: ...
Precio: $... (descuento X% sobre $...)
Condición: Nuevo/Usado
Stock: X unidades disponibles
Vendedor: [nombre] (calificación X, X ventas)
Envío: Gratis/[costo] / MercadoEnvíos
Descripción: ...
Especificaciones:
  - [Atributo]: [Valor]
URL: ...
```

## Análisis de competidores / precios de mercado

Para analizar rangos de precios de un producto:
1. Buscá el producto
2. Extraé los primeros 10-15 resultados con precio
3. Calculá o reportá: precio mínimo, máximo, promedio, precio más frecuente
4. Identificá si hay vendedores MercadoLibre oficial vs. terceros

## Perfil de vendedor

Para ver la información de un vendedor:
1. Desde un producto, hacé click en el nombre del vendedor
2. Extraé: nombre, reputación (color: verde/amarillo/rojo + porcentaje), cantidad de ventas, calificación, tiempo en la plataforma, ubicación

## Preguntas y respuestas de un producto

Para extraer las preguntas de un listado:
- Las Q&A están en la misma página del producto, más abajo
- Hacé scroll para cargarlas
- Extraé las más recientes y relevantes (título de pregunta + respuesta del vendedor)

## Login (para dashboard de vendedor)

Si el task requiere ver ventas/órdenes propias:
1. Navegá a `https://www.mercadolibre.com.ar/`
2. Hacé click en "Ingresá"
3. Completá el email: `{{credential:email}}`
4. Completá la contraseña: `{{credential:password}}`
5. Si hay verificación por SMS/email: pará y reportá `BLOCKED: MercadoLibre requires 2FA`

Para acceder al panel de ventas una vez logueado: navegá a `https://vendedores.mercadolibre.com.ar/`

## Países disponibles

Si el task menciona un país distinto de Argentina, usá el dominio correcto:
- México: `mercadolibre.com.mx`
- Brasil: `mercadolivre.com.br`
- Colombia: `mercadolibre.com.co`
- Chile: `mercadolibre.cl`
- Uruguay: `mercadolibre.com.uy`

## Límites que nunca cruzar

- No publiques ni modifiques listados
- No hagas compras ni inicies el proceso de checkout
- No enviés preguntas ni mensajes a vendedores salvo pedido explícito
- No hagas modificaciones en el dashboard del vendedor
