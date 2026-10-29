# Audit Findings

### FINDING-013

- **Área:** Elegibilidad financiera / transición de permisos 0042.
- **Estado:** OPEN.
- **Prioridad:** HIGH.
- **Descripción:** 0042 añade entradas financieras protegidas y el código migra a
  ellas, pero conserva por compatibilidad los grants históricos de service_role
  para DML y las RPC antiguas. Esas vías SQL todavía pueden omitir la elegibilidad.
- **Evidencia:** migraciones 0003–0009, 0018–0021 y 0042; la prueba SQL de
  elegibilidad comprueba explícitamente que el grant histórico sigue presente.
- **Cierre:** verificar el despliegue de todos los repositorios nuevos y retirar
  las vías anteriores mediante un corte autorizado y pruebas de privilegios
  efectivos. No restaurar grants amplios para recuperar una versión antigua.

### FINDING-014

- **Área:** Elegibilidad 0042 / orden de bloqueos.
- **Estado:** RESOLVED (local; pendiente de despliegue).
- **Descripción:** El guard bloqueaba membership antes del hogar requerido por FK;
  salida/remoción bloqueaban hogar antes de membership, permitiendo deadlock.
- **Corrección:** 0042 adquiere SHARE de hogar antes de usuario interno/membership.
- **Evidencia:** financial-eligibility-races.cjs reinstala el helper anterior solo
  en PostgreSQL descartable y reproduce 40P01 con fn_leave_household; el helper
  corregido valida salida/remoción en ambos órdenes y el estado final.

### FINDING-015

- **Área:** Contrato HTTP de elegibilidad transaccional.
- **Estado:** RESOLVED (local; pendiente de despliegue).
- **Descripción:** La denegación del guard llegaba como error técnico 500.
- **Corrección:** Marker SQL específico, mapping de repositorio/dominio y 403
  ACCOUNT_NOT_ELIGIBLE en gastos, ingresos y Agent Web; 42501 genérico sigue 500.
- **Evidencia:** harnesses HTTP y Agent con señal válida y errores genéricos,
  comprobando que no se escriben movimientos ni se exponen detalles SQL.

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
- **Descripción:** En la auditoría de `GET /api/expenses/{id}` del 2026-08-11, `npm run format:check` reportó problemas de formato preexistentes en múltiples archivos; el reporte de entonces enumeró 47. La versión de `tests/phase-3-expense-api-functional.cjs` comparada en esa auditoría ya fallaba la comprobación individual de Prettier antes de incorporar la cobertura de `GET /api/expenses/{id}`. Ese recuento es histórico: el estado global actual de formato queda pendiente y no se volvió a comprobar en esta actualización.
- **Impacto:** La ejecución del 2026-08-11 no fue PASS para el repositorio completo. El resultado global de formato en el estado actual es desconocido y requiere una comprobación futura; cualquier deuda que persista debe abordarse en un incremento separado, sin mezclarla con funcionalidades del MVP.
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
- **Descripción:** Las rutas HTTP de Categories inspeccionadas para Web/PWA son de lectura y no hay un endpoint HTTP directo para administrar o crear categorías desde esa UI. No es correcto afirmar que no exista lógica de creación: `modules/categories/category.service.ts` y su repositorio implementan crear o reutilizar microcategorías, invocadas por el flujo de confirmación del Agent. Ese flujo no equivale a una API CRUD directa para Web/PWA. El catálogo continúa siendo global durante el MVP, sin `household_id` ni ownership por hogar; las categorías privadas requieren una decisión posterior.
- **Impacto:** La UI no tiene un endpoint directo para administrar o crear una categoría cuando el catálogo seed no contiene una opción adecuada. El flujo Agent de microcategorías no demuestra que ese requisito de UI esté cubierto.
- **Prioridad:** MENOR
- **Estado:** OPEN
- **Origen/detección:** Auditoría de APIs y módulos durante la validación manual de Web/PWA del 2026-08-13.
- **Criterio de resolución:** Definir un incremento independiente para la administración directa desde Web/PWA, aclarando si opera sobre el catálogo global o requiere categorías privadas por household; mantener separado el flujo de microcategorías del Agent.

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
- **Descripción:** `POST /api/agent` genera `conversationKey` como `web:${householdId}:${memberId}`; no usa `HOUSEMATE_MVP_CONVERSATION_KEY` ni separa el contexto por sesión de navegador. El esquema persiste propuestas pendientes y borradores asociados a `conversation_key`, pero esas filas no son una transcripción completa de mensajes. No se encontró una tabla de transcripción en el esquema inspeccionado.
- **Impacto:** Las propuestas y los borradores pueden continuar asociados al mismo hogar y miembro entre sesiones de navegador; no hay aislamiento de continuidad por sesión Web. La persistencia de ese estado no demuestra que se guarde una transcripción completa.
- **Prioridad:** MENOR
- **Estado:** OPEN
- **Origen/detección:** Implementación de `POST /api/agent` del 2026-08-13.
- **Criterio de resolución:** Diseñar sesiones Web independientes únicamente en un incremento posterior si el MVP lo requiere.

### FINDING-006

- **Fecha:** 2026-08-13
- **Área:** Agent / Expense UX
- **Descripción:** Si no se especifica otro pagador, el Agent usa el actor controlado. Cuando se indica otro integrante por nombre, resuelve el nombre normalizado contra los miembros del household controlado y requiere una coincidencia única. Un nombre ausente o ambiguo produce una solicitud de aclaración; no se acepta un identificador arbitrario de miembro como identidad enviada por el cliente.
- **Impacto:** Ya es posible registrar un gasto pagado por otro miembro con nombre único. Siguen requiriendo aclaración los nombres ausentes, desconocidos o ambiguos; no existe selección basada en un ID suministrado por el cliente.
- **Prioridad:** MENOR
- **Estado:** IN_PROGRESS
- **Origen/detección:** Implementación de defaults de `CREATE_EXPENSE` del 2026-08-13 y revisión del flujo posterior de resolución de pagadores por nombre.
- **Criterio de resolución:** Confirmar si la resolución por nombre único cubre el requisito del MVP y conservar las aclaraciones para entradas ausentes o ambiguas. Cualquier soporte futuro de selección por identificador debe resolverlo contra el contexto controlado, sin confiar en identidad suministrada por el cliente.

### FINDING-007

- **Fecha:** 2026-10-09
- **Área:** E2E / household autorizado
- **Descripción:** Una auditoría previa encontró que la selección de `E2E_AGENT_HOUSEHOLD_ID` no estaba suficientemente vinculada al contexto central y que una comparación de UUID sensible a mayúsculas podía eludir el veto del household MVP. El código actual normaliza los UUID y exige que el household Agent coincida con el autorizado centralmente.
- **Impacto:** Antes de la corrección, la selección podía eludir el household permitido o el veto MVP antes de operaciones de prueba.
- **Prioridad:** BLOCKER (defecto específico corregido)
- **Estado:** RESOLVED
- **Origen/detección:** Auditoría local de aislamiento E2E; la corrección en `fixtures.cjs` normaliza y valida el contexto, y `authorizedAgentHouseholdId()` normaliza el ID Agent y exige igualdad con el household autorizado antes de su uso. El harness local `write-context-functional.cjs` cubre la normalización y el rechazo de un household distinto; el usuario comunicó previamente que pasó. No se volvió a ejecutar durante esta actualización.
- **Límites:** Este cierre cubre la comparación del household; no demuestra que la URL o referencia configurada apunte a un proyecto de pruebas aislado. `createE2EClient()` sigue construyendo un cliente Supabase con `service_role`; validar el household no reduce las capacidades administrativas de ese cliente.

### FINDING-008

- **Fecha:** 2026-10-09
- **Área:** E2E / propiedad y recuperación de recursos
- **Descripción:** La auditoría previa encontró cleanup Agent basado en diferencias de snapshots y una ruta Direct Split que podía fallar antes de registrar referencias. Se retiró la selección por snapshots y ahora se registran las referencias devueltas antes de assertions, pero una referencia no prueba propiedad. Agent puede persistir drafts sin exponer su ID. Una invitación puede confirmarse sin que el cliente reciba un identificador recuperable si no reintenta con la misma clave de idempotencia; el spec actual no ejercita ese contrato. El cleanup de Notifications depende de permisos DELETE no verificados.
- **Impacto:** Riesgo de eliminar datos concurrentes ajenos o dejar recursos sin recuperación segura.
- **Prioridad:** HIGH / BLOCKER para cleanup por snapshots
- **Estado:** IN_PROGRESS
- **Origen/detección:** Auditoría local y contrato actual de las rutas. Mientras el hold permanezca, los entrypoints Agent y el helper de solicitudes POST rechazan las escrituras conocidas, y el spec de creación Realtime lanza `E2E_RECOVERY_BLOCKED` al importarse. La configuración estándar bloquea antes de cargar entorno, iniciar servidor o registrar `globalSetup`; si una configuración alternativa invoca directamente `globalSetup`, `prepareExpenseFixtures()` conserva su propio guard antes del cliente y del RPC. Esto no constituye una barrera universal de solo lectura. Las referencias recogidas no prueban propiedad y `requireAdministrativeRecovery()` rechaza una recuperación no acreditada en vez de ejecutar DELETE automático. Al entrar en `main()` de `provision-test-user.cjs` con contexto válido, el script puede construir el cliente administrativo y ejecutar `auth.admin.listUsers` antes de alcanzar el guard que bloquea la creación; su helper de creación mantiene otro guard antes de crear el usuario.
- **Criterio de resolución:** Contrato de recuperación con propiedad inequívoca, mecanismo administrativo autorizado y verificación de cleanup por IDs exactos, seguido de auditoría independiente. Los dos IDs registrados en `tests/e2e/README.md` siguen pendientes de reconciliación administrativa; su existencia actual no se consultó. Ninguna variable de entorno desbloquea estos escenarios.
- **Incremento 1 (validación local comunicada):** `0038` y el backend de invitaciones añaden correlación por actor/clave y recuperación del ID sin regenerar el enlace cuando el cliente reutiliza la misma clave. Un registro previo documenta un bloqueo al arrancar Node por `EPERM ... lstat C:\Users\user`; posteriormente, el usuario comunicó que el harness HTTP pasó y que las dos fases del runner SQL/concurrencia terminaron sin error de cleanup. Esos resultados no se volvieron a ejecutar ni verificar en esta actualización, y no prueban el estado remoto de la migración. El hallazgo sigue `IN_PROGRESS`: recuperación administrativa, cleanup real y permisos efectivos no están verificados; `E2E_RECOVERY_BLOCKED` permanece activo.
- **Evidencia adicional:** La configuración de integración aplica el bloqueo central antes de cargar dotenv o iniciar servidor/fixtures; los helpers conocidos de escritura mantienen guards propios. El usuario comunicó previamente PASS para `write-context-functional.cjs`, `recovery-context-functional.cjs` y la suite Notifications mockeada de nueve casos; no se ejecutaron aquí y no prueban operaciones reales de Supabase. La suite de creación Realtime sigue bloqueada. El provisioning puede realizar la lectura administrativa indicada arriba antes del guard de creación.

### FINDING-009

- **Fecha:** 2026-10-11
- **Área:** Notifications / autorización PostgreSQL Realtime
- **Descripción:** La política SELECT de `0031` consultaba `tb_users` directamente y obtenía la identidad solo de `request.jwt.claim.sub`. En el proyecto de desarrollo, `authenticated` no tenía SELECT sobre esa tabla ni sobre las columnas utilizadas; una lectura bajo ese rol falló con `42501: permission denied for table tb_users`. La función desplegada `realtime.apply_rls` configuraba `request.jwt.claims`, mientras la política no contemplaba ese formato JSON.
- **Impacto:** La unión del canal y los heartbeats funcionaban, pero un INSERT confirmado para el receptor correcto no producía un frame `postgres_changes` ni ejecutaba el callback. El GET administrativo recuperaba la notificación y no demostraba autorización Realtime.
- **Prioridad:** HIGH
- **Estado:** RESOLVED (política SELECT en el código local; entrega real reportada por el usuario en desarrollo, no verificada en esta actualización)
- **Corrección:** `0039_fix_notifications_realtime_select_policy.sql` añade `fn_notifications_current_user_id()`, sin parámetros, con `SECURITY DEFINER`, referencias calificadas y `search_path` vacío. Resuelve únicamente la identidad propia mediante `auth.uid()` y cambia la condición SELECT para comparar `recipient_user_id` con ese resultado, sin conceder SELECT general de `tb_users`. Las migraciones anteriores permanecen intactas.
- **Evidencia de resolución:** El archivo local 0039 define el helper `SECURITY DEFINER` con `search_path` vacío, revoca EXECUTE a `PUBLIC`, lo concede a `authenticated` y actualiza la política SELECT para usar `recipient_user_id`. El usuario comunicó haber aplicado la migración en desarrollo y haber observado una lectura propia sin filas ajenas, además de un INSERT controlado que llegó por WebSocket, ejecutó el callback, reconcilió el estado HTTP y actualizó el contador; también reportó llegada inmediata en otra prueba funcional. Estos son reportes del usuario: esta auditoría no consultó el entorno ni confirma el estado remoto actual.
- **Diagnóstico temporal:** `__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__` registra todos los estados sucesivos con categoría conservadora, tiempo relativo, instancia local y datos numéricos/booleanos de cierre cuando se reconocen. Es independiente de la bandera E2E y está desactivada por defecto; no registra payloads, mensajes arbitrarios ni IDs de usuario o notificación.
- **Límites:** La evidencia remota procede de resultados y observaciones aportados por el usuario; no se verificó el entorno remoto en esta actualización ni se validaron todos los escenarios de negocio o permisos efectivos. El spec local de suscripción comprueba que los navegadores alcanzan `SUBSCRIBED`, pero no envía un INSERT ni comprueba su entrega. La suite mockeada simula los eventos y tampoco demuestra entrega real ni aislamiento RLS. La presencia local de 0039 no acredita que esté aplicada actualmente en el entorno remoto. 0039 no cambia la política UPDATE definida en 0031, que conserva el patrón anterior. Esta evidencia no desbloquea FINDING-008 ni acredita recuperación administrativa.

### FINDING-010

- **Fecha:** 2026-10-17
- **Área:** Agent / Dashboard / resumen financiero por periodo
- **Descripción:** Al ampliar la herramienta de resumen financiero para aceptar `categoryLevel` y `categoryName`, se pasaba el objeto completo al servicio Dashboard. `validateDashboardFilters()` solo admite `from` y `to`, por lo que rechazaba la lectura incluso en resúmenes financieros sin desglose y en resúmenes combinados. Además, la petición a Responses API permitía varias llamadas a funciones, aunque el adaptador solo acepta una por turno.
- **Impacto:** Las consultas de resumen financiero fallaban de forma cerrada antes de leer movimientos, y una interpretación con varias llamadas de función también se rechazaba antes del despacho.
- **Prioridad:** HIGH
- **Estado:** RESOLVED (harnesses, typecheck y funcionamiento manual reportados por el usuario el 2026-10-17; no repetidos durante esta actualización)
- **Origen/detección:** Fallo de `tests/phase-4-agent-period-summary-functional.cjs`, error de TypeScript y diagnósticos `invalid_call_count` reportados por el usuario; revisión de `getPeriodFinancialSummaryTool()` frente a `validateDashboardFilters()`.
- **Corrección:** La herramienta proyecta el intervalo a `{ from, to }` antes de llamar a Dashboard y correlaciona el tipo de respuesta con `categoryLevel`, rechazando estructuras inesperadas. El adaptador registra solo etapas y estado HTTP de fallos de interpretación, sin mensajes, argumentos, credenciales ni contenido del usuario; además envía `parallel_tool_calls: false` para limitar las llamadas de función a cero o una por respuesta. Los harnesses cubren el intervalo proyectado, el parámetro de llamadas paralelas y las respuestas inválidas.
- **Evidencia de resolución:** El usuario reportó PASS y código de salida `0` para los harnesses `phase-4-agent-period-summary-functional.cjs`, `phase-4-agent-period-expense-category-summary-functional.cjs` y `npm run typecheck`; también confirmó que la prueba manual ya funciona. Esta actualización registra esos resultados reportados y no realizó llamadas remotas.

### FINDING-011

- **Fecha:** 2026-10-18
- **Área:** Agent / resumen combinado por categoría
- **Descripción:** En una consulta manual que pidió el resumen financiero y el gasto por una categoría macro explícita entre comillas, la respuesta mostró únicamente los totales financieros. El código trata `categoryLevel=null` y `categoryName=null` como una solicitud financiera sin desglose; no se conservaría así la dimensión categórica pedida si el modelo omitiera esos campos.
- **Impacto:** La respuesta puede parecer completa aunque haya omitido una parte solicitada. En categorías ambiguas, podría presentar cifras financieras en vez de pedir que se especifique el nombre y fallar cerrado.
- **Prioridad:** MEDIUM
- **Estado:** RESOLVED
- **Origen/detección:** Resultado manual reportado por el usuario el 2026-10-18. Los argumentos originales enviados por el proveedor no están disponibles, por lo que la omisión del filtro por el modelo es la causa probable, no confirmada.
- **Corrección:** Cuando el mensaje expresa un gasto por categoría macro/micro con un nombre entre comillas, Conversation Service conserva el nivel y nombre explícitos antes de invocar la tool financiera; el calculador existente resuelve la categoría y mantiene el fallo cerrado ante nombres ambiguos o no resueltos.
- **Evidencia de resolución:** El usuario reportó PASS con código `0` para `phase-4-agent-period-expense-category-summary-functional.cjs` y `npm run typecheck`, y una nueva prueba manual devolvió “No encontré esa categoría en el nivel solicitado” sin incluir cifras financieras parciales. La respuesta demuestra fallo cerrado para el nombre usado; no demuestra que la taxonomía real tenga una categoría `Cafe` duplicada ni que no exista una variante activa bajo otro nivel. No se inspeccionaron datos remotos.

### FINDING-012

- **Fecha:** 2026-10-25
- **Área:** WhatsApp / idempotencia de respuesta outbound
- **Descripción:** El webhook reserva persistentemente el ID del evento antes de resolver el hogar y procesar el mensaje. Si el procesamiento o el envío outbound falla después de esa reserva, una redelivery del mismo evento se clasifica como duplicada y no vuelve a procesar ni enviar la respuesta.
- **Impacto:** Un fallo transitorio posterior a la reserva puede dejar al usuario sin respuesta aunque Meta reintente la entrega. La reserva sigue evitando que una redelivery repita mutaciones financieras.
- **Prioridad:** MEDIUM
- **Estado:** OPEN
- **Origen/detección:** Revisión del orden `reserveWhatsAppEvent()` → resolución/Agent → `sendWhatsAppReply()` en `modules/whatsapp/whatsapp.service.ts`; el incidente de producción reportado anteriormente mostró una redelivery clasificada como duplicada tras fallar el envío outbound.
- **Criterio de resolución:** Diseñar un incremento independiente de recuperación de entregas que permita reintentar respuestas sin volver a aplicar operaciones financieras, con pruebas de fallos antes y después de cualquier mutación.
