---
name: twitter-x
description: Skill para automatizar interacciones en Twitter/X via browser-use
metadata:
  version: 1.0.0
---

# Twitter / X — Guía de automatización

## Notas generales

Desde 2023, Twitter/X requiere login para ver la mayoría del contenido en la web. El acceso sin login está muy limitado. Asumí que necesitás credenciales para cualquier tarea de extracción.

## Login

1. Navegá a `https://x.com/i/flow/login`
2. Ingresá el username o email: `{{credential:username}}`
3. Puede aparecer un paso intermedio pidiendo el username (distinto del email) — ingresalo
4. Ingresá la contraseña: `{{credential:password}}`
5. Si aparece verificación o "Confirm your identity": pará y reportá `BLOCKED: X requires additional verification`
6. Una vez logueado, deberías estar en el feed

## Extracción de perfil

Para extraer información de una cuenta (`x.com/[handle]`):
- Extraé: nombre, @handle, bio, ubicación, website, fecha de unión, seguidores, siguiendo, si está verificado
- El contenido del feed del perfil (tweets recientes) también es visible en esta URL

### Formato de salida:
```
Handle: @...
Nombre: ...
Bio: ...
Ubicación: ...
Website: ...
Miembro desde: ...
Seguidores: ...
Siguiendo: ...
Verificado: Sí/No
```

## Extracción de tweets de un perfil

1. Navegá a `x.com/[handle]` para ver los tweets recientes
2. Para ver solo los tweets (sin respuestas): `x.com/[handle]` (es el default)
3. Para respuestas también: `x.com/[handle]/with_replies`
4. Para media: `x.com/[handle]/media`
5. Extraé por tweet: texto, fecha, likes, RTs, replies, URLs en el tweet

## Búsqueda

Para buscar tweets o cuentas:
1. Usá la barra de búsqueda o navegá a `x.com/search?q=[query]&src=typed_query`
2. Filtrá por "Latest" para resultados recientes: añadí `&f=live` a la URL
3. Para tweets de una cuenta específica: buscar `from:[handle] [query]`
4. Extraé: texto del tweet, cuenta, fecha, engagement (likes/RTs/replies)

### Queries de búsqueda útiles:
- Menciones de una marca: `[marca] -filter:retweets` (excluye RTs para ver opiniones directas)
- Tweets con sentimiento negativo: `[marca] lang:es (problema OR falla OR mal OR horrible)`
- Discusiones de industria: `[tema] lang:es filter:verified` (solo cuentas verificadas)

## Hilo (Thread)

Para leer un hilo completo:
1. Hacé click en el tweet inicial o navegá a su URL
2. El hilo aparece expandido debajo del tweet
3. Hacé scroll para cargar todos los tweets del hilo
4. Extraé todos los tweets en orden con el texto de cada uno

## Trending Topics

- Navegá a `x.com/explore/tabs/trending`
- Extraé los trending topics visibles y, si están disponibles, el volumen de tweets

## Límites que nunca cruzar

- No publiques tweets ni respuestas
- No retweetees ni des like
- No sigas ni dejes de seguir cuentas
- No enviés DMs
- No hagas reporte de cuentas o contenido
- No hagas scraping masivo de followers (máx 50-100 resultados por sesión)
