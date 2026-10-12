# Audit Findings

## Purpose

Este documento registra hallazgos reales detectados durante auditorías que no necesariamente bloquean el MVP. No sustituye la documentación de arquitectura, contratos, planificación ni estructura del proyecto.

## Status definitions

- OPEN
- IN_PROGRESS
- RESOLVED
- ACCEPTED

## Findings

### FINDING-001

- **Fecha:** 2026-08-11
- **Área:** Tooling / formato
- **Descripción:** `npm run format:check` reporta problemas de formato preexistentes en múltiples archivos del repositorio. La versión de `tests/phase-3-expense-api-functional.cjs` presente en `HEAD` ya fallaba la comprobación individual de Prettier antes de incorporar la cobertura de `GET /api/expenses/{id}`. La comprobación global actual continúa reportando 47 archivos, incluidos archivos fuera del alcance de este incremento.
- **Impacto:** La validación global de formato no puede usarse como PASS del repositorio completo sin modificar deuda preexistente ajena al incremento.
- **Prioridad:** MENOR
- **Estado:** ACCEPTED
- **Origen/detección:** Auditoría de `GET /api/expenses/{id}` del 2026-08-11 mediante `npm run format:check` y comparación de Prettier contra `HEAD`.
- **Criterio de resolución:** Abordar la deuda de formato en un incremento separado y explícito, sin mezclarla con funcionalidades del MVP.

### FINDING-002

- **Fecha:** 2026-08-13
- **Área:** Web/PWA / contexto de miembros
- **Descripción:** La Web/PWA recibía identificadores de miembros desde Balance y Sharing Rules, pero no existía un endpoint HTTP de lectura de miembros que expusiera sus nombres.
- **Impacto:** Los selectores y resúmenes mostraban `memberId` en lugar del nombre legible.
- **Prioridad:** MENOR
- **Estado:** RESOLVED
- **Origen/detección:** Validación manual de Web/PWA del 2026-08-13.
- **Criterio de resolución:** `GET /api/household-members` reutiliza el contexto controlado, filtra por `household_id` y expone únicamente `id` y `displayName`.

### FINDING-003

- **Fecha:** 2026-08-13
- **Área:** Web/PWA / Categories
- **Descripción:** Existe únicamente `GET /api/categories`; no existe Service, Repository ni endpoint HTTP para crear categorías. Categories permanece como catálogo global durante el MVP, sin `household_id` ni ownership por hogar. Una futura escritura podrá operar sobre el catálogo global; las categorías privadas por household quedan fuera de este alcance y requerirán una decisión posterior.
- **Impacto:** La UI no puede crear una categoría nueva cuando el catálogo seed no contiene una opción adecuada.
- **Prioridad:** MENOR
- **Estado:** OPEN
- **Origen/detección:** Auditoría de APIs y módulos durante la validación manual de Web/PWA del 2026-08-13.
- **Criterio de resolución:** Aprobar un incremento independiente de escritura sobre el catálogo global y decidir posteriormente si se requieren categorías privadas por household.

### FINDING-004

- **Fecha:** 2026-08-13
- **Área:** Web/PWA / Agent HTTP
- **Descripción:** Agent y Conversation Service están implementados para canales controlados, pero no existe un Route Handler HTTP para enviar mensajes, resolver propuestas o confirmar/rechazar desde Web/PWA.
- **Impacto:** La UI no puede probar el flujo Agent sin crear un endpoint HTTP adicional.
- **Prioridad:** MENOR
- **Estado:** RESOLVED
- **Origen/detección:** Auditoría de `app/api` y `modules/agent` durante la validación manual de Web/PWA del 2026-08-13.
- **Criterio de resolución:** `POST /api/agent` reutiliza el contexto HTTP controlado y `conversation.service.ts`; las propuestas y confirmaciones siguen el flujo textual existente sin exponer persistencia al cliente.

### FINDING-005

- **Fecha:** 2026-08-13
- **Área:** Web/PWA / Agent HTTP
- **Descripción:** La interfaz Web utiliza el `HOUSEMATE_MVP_CONVERSATION_KEY` configurado server-side; no existe una sesión Web independiente ni historial persistente.
- **Impacto:** Las conversaciones Web comparten la continuidad limitada por la configuración del MVP.
- **Prioridad:** MENOR
- **Estado:** OPEN
- **Origen/detección:** Implementación de `POST /api/agent` del 2026-08-13.
- **Criterio de resolución:** Diseñar sesiones Web independientes únicamente en un incremento posterior si el MVP lo requiere.

### FINDING-006

- **Fecha:** 2026-08-13
- **Área:** Agent / Expense UX
- **Descripción:** El Agent asume que el pagador es el actor controlado cuando el mensaje no especifica otro pagador. La interpretación de pagadores distintos por nombre o identificador permanece fuera del MVP.
- **Impacto:** No es posible registrar mediante Agent un gasto pagado por un integrante distinto del actor actual.
- **Prioridad:** MENOR
- **Estado:** OPEN
- **Origen/detección:** Implementación de defaults de `CREATE_EXPENSE` del 2026-08-13.
- **Criterio de resolución:** Aprobar un incremento independiente que defina y valide la resolución segura de pagadores distintos sin aceptar identidad desde el cliente.

### FINDING-009

- **Fecha:** 2026-10-11
- **Área:** Notifications / autorización PostgreSQL Realtime
- **Descripción:** La política SELECT de `0031` consultaba `tb_users` directamente y obtenía la identidad solo de `request.jwt.claim.sub`. En el proyecto de desarrollo, `authenticated` no tenía SELECT sobre esa tabla ni sobre las columnas utilizadas; una lectura bajo ese rol falló con `42501: permission denied for table tb_users`. La función desplegada `realtime.apply_rls` configuraba `request.jwt.claims`, mientras la política no contemplaba ese formato JSON.
- **Impacto:** La unión del canal y los heartbeats funcionaban, pero un INSERT confirmado para el receptor correcto no producía un frame `postgres_changes` ni ejecutaba el callback. El GET administrativo recuperaba la notificación y no demostraba autorización Realtime.
- **Prioridad:** HIGH
- **Estado:** RESOLVED (política SELECT y entrega observada en desarrollo)
- **Corrección:** `0039_fix_notifications_realtime_select_policy.sql` añade `fn_notifications_current_user_id()`, sin parámetros, con `SECURITY DEFINER`, referencias calificadas y `search_path` vacío. Resuelve únicamente la identidad propia mediante `auth.uid()` y cambia la condición SELECT para comparar `recipient_user_id` con ese resultado, sin conceder SELECT general de `tb_users`. Las migraciones anteriores permanecen intactas.
- **Evidencia de resolución:** El usuario aplicó 0039 manualmente y comunicó la política y el helper desplegados; EXECUTE estaba permitido a `authenticated` y denegado a `anon` y PUBLIC. Una lectura simulando el formato JSON bajo `authenticated` resolvió la identidad, mostró notificaciones propias y no mostró ajenas. Después, el usuario observó un INSERT controlado en el WebSocket, callback INSERT, reconciliación, carga HTTP, actualización de estado y aumento del contador sin abrir la campana; también reportó llegada inmediata en una prueba funcional real adicional.
- **Límites:** La evidencia remota procede de resultados y observaciones aportados por el usuario; el agente no ejecutó consultas remotas ni pruebas automatizadas. No se validaron todos los escenarios de negocio. 0039 no cambia la política UPDATE de lectura definida en 0031, que conserva el patrón anterior.
