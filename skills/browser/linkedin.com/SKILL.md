---
name: linkedin
description: Skill para automatizar interacciones en LinkedIn via browser-use
metadata:
  version: 1.0.0
---

# LinkedIn — Guía de automatización

## Anti-bot: comportamiento crítico

LinkedIn detecta automatización agresiva. Para evitar bloqueos:
- **Nunca hagas más de 3-5 acciones seguidas sin una pausa** (el agente incluye delays naturales, pero no apures las acciones)
- Si aparece un captcha o verificación de seguridad: pará inmediatamente y reportá `BLOCKED: LinkedIn security check`
- Si te redirige a `/checkpoint/`: pará y reportá `BLOCKED: LinkedIn checkpoint — posible detección de bot`
- No hagas scroll infinito — extraé solo lo que necesitás y terminá

## Login

Si el task incluye credenciales (`{{credential:username}}`, `{{credential:password}}`):
1. Navegá a `https://www.linkedin.com/login`
2. Completá el campo `username` con el email
3. Completá el campo `password`
4. Hacé click en "Sign in"
5. Esperá a que cargue el feed (URL cambia a `linkedin.com/feed` o similar)
6. Si aparece verificación de 2FA: pará y reportá `BLOCKED: LinkedIn requires 2FA verification`
7. Si las credenciales fallan: pará y reportá `BLOCKED: LinkedIn login failed — check credentials`

Si el task menciona cookies o session guardada: usá eso en lugar de usuario/contraseña.

## Extracción de perfiles

Para extraer datos de un perfil (`/in/nombre-apellido`):
- Extraé: nombre completo, headline, empresa actual, cargo, ubicación, resumen (About), experiencias, educación
- Hacé scroll hacia abajo para cargar las secciones dinámicas (experiencias se carga lazy)
- No hagas click en "Connect" ni "Message" salvo que el task lo pida explícitamente

### Formato de salida esperado para perfiles:
```
Nombre: ...
Headline: ...
Empresa actual: ...
Cargo: ...
Ubicación: ...
Resumen: ...
Experiencias:
  - [Cargo] en [Empresa] (desde - hasta): descripción breve
Educación:
  - [Título] en [Institución] (año)
```

## Búsqueda de personas y empresas

Para búsqueda de personas:
1. Usá la barra de búsqueda de LinkedIn
2. Escribí el término de búsqueda
3. Filtrá por "People" si es necesario
4. Extraé los resultados de la primera página (nombre, cargo actual, empresa, URL del perfil)
5. No cargues más páginas salvo que se pida explícitamente

Para búsqueda de empresas:
1. Buscá el nombre de la empresa
2. Filtrá por "Companies"
3. Hacé click en la empresa correcta
4. Extraé: descripción, industria, tamaño, sede, website, empleados destacados si son visibles

## Extracción de posts / actividad

- Navegá a `linkedin.com/in/[usuario]/recent-activity/all/`
- Extraé: texto del post, fecha, cantidad de likes/comentarios si son visibles
- No interactúes con los posts (no likes, no comentarios) salvo pedido explícito

## Jobs (búsqueda de trabajo)

- Navegá a `linkedin.com/jobs/search/?keywords=[query]&location=[ubicacion]`
- Extraé: título, empresa, ubicación, fecha de publicación, URL de la oferta
- Para ver el detalle de un trabajo: hacé click y extraé la descripción completa

## Límites que nunca cruzar

- No enviés mensajes InMail ni DMs salvo que sea explícitamente el objetivo del task
- No enviés solicitudes de conexión salvo pedido explícito
- No hagas like/comment/share de posts
- No descargues listas de contactos ni exportes datos de forma masiva
- No hagas scraping de más de 20 perfiles en una sola sesión
