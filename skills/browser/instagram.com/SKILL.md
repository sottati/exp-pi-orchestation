---
name: instagram
description: Skill para automatizar interacciones en Instagram via browser-use
metadata:
  version: 1.0.0
---

# Instagram — Guía de automatización

## Comportamiento general

Instagram es altamente restrictivo con la automatización. Usá esta guía para evitar bloqueos:

- Actuá lentamente. No hagas múltiples acciones seguidas sin pausa.
- Si aparece `"Try again later"` o una pantalla de verificación: pará y reportá `BLOCKED: Instagram rate limit or security check`
- Si te piden confirmar el número de teléfono o email: pará y reportá `BLOCKED: Instagram requires account verification`

## Login

Si el task incluye credenciales:

1. Navegá a `https://www.instagram.com/accounts/login/`
2. Completá el campo `username`
3. Completá el campo `password`
4. Hacé click en "Log in"
5. Si aparece "Turn on Notifications": cerrá el popup y continuá
6. Si aparece verificación (SMS, email): pará y reportá `BLOCKED: Instagram requires 2FA`
7. Si las credenciales fallan: pará y reportá `BLOCKED: Instagram login failed`

## Extracción de perfil público

Para extraer información de un perfil (`instagram.com/[username]`):

- Extraé: nombre de usuario, nombre completo (si es visible), bio, cantidad de posts/seguidores/seguidos, website en la bio, si es cuenta verificada
- Si el perfil es privado: reportalo como `INFO: cuenta privada — contenido no accesible sin seguir`

### Formato de salida para perfiles

```
Username: @...
Nombre: ...
Bio: ...
Seguidores: ...
Siguiendo: ...
Posts: ...
Website: ...
Verificado: Sí/No
```

## Extracción de posts

Para ver los posts de un perfil:

1. Navegá al perfil
2. Los thumbnails de posts son visibles sin login para cuentas públicas
3. Para ver el contenido de un post: hacé click en el thumbnail
4. Extraé: caption, hashtags, likes (si visibles), fecha, tipo (foto/video/reel/carrusel)
5. No hagas like, comment ni share

## Extracción de posts por hashtag

1. Navegá a `instagram.com/explore/tags/[hashtag]/` (sin el #)
2. Extraé los posts de la sección "Top" primero
3. Para cada post: imagen/video URL si es visible, caption si está en el snippet, cuenta que lo publicó

## Búsqueda

Instagram tiene búsqueda limitada en la web:

- Navegá a `instagram.com/explore/` y usá la barra de búsqueda
- La búsqueda web funciona mejor para cuentas y hashtags que para contenido específico

## Reels y Stories

- Reels: accesibles en `instagram.com/[username]/reels/`
- Stories: requieren login y son efímeras — si el task las necesita, aclaralo
- Para cuentas de negocio, el contenido de Reels suele ser más accesible

## Límites que nunca cruzar

- No enviés DMs, a menos que se especifique lo contrario en el task
- No sigas/dejes de seguir cuentas, a menos que se especifique lo contrario en el task
- No publiques contenido, a menos que se especifique lo contrario en el task
- No reportes cuentas, a menos que se especifique lo contrario en el task
- No hagas like/comment/save en posts, a menos que se especifique lo contrario en el task
- No extraigas datos de forma masiva (**máx 20 perfiles por sesión**)
