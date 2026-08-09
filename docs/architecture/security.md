# Security

## 1. Propósito

Este documento define las medidas de seguridad necesarias para el MVP de HouseMate AI.

HouseMate AI es inicialmente un proyecto personal y no pretende resolver desde el primer momento los requerimientos de seguridad de una plataforma SaaS multiusuario.

Por lo tanto, la seguridad del MVP debe enfocarse en proteger:

- credenciales y secretos;
- información financiera;
- imágenes de facturas;
- comunicación con WhatsApp;
- operaciones realizadas por el agente;
- integridad de los datos.

El objetivo es implementar controles simples y efectivos sin introducir infraestructura o procesos innecesarios.

---

# 2. Principio general

La seguridad del MVP seguirá una regla fundamental:

> **Implementar únicamente los controles necesarios para proteger correctamente el proyecto actual, dejando preparada la arquitectura para incorporar mecanismos más avanzados en el futuro.**

No se implementarán sistemas empresariales de autenticación, autorización o infraestructura de seguridad que no sean necesarios para la demo y el uso personal inicial.

---

# 3. Modelo de usuario del MVP

Durante el MVP se trabajará inicialmente con un único usuario y un único hogar.

Conceptualmente:

```text
User
  │
  ▼
Household
  │
  ├── Members
  ├── Expenses
  ├── Incomes
  ├── Receipts
  └── PendingProposals
```

La estructura de datos debe conservar una separación razonable entre usuario, hogar y gastos para permitir una futura evolución a múltiples usuarios.

Sin embargo, no se implementará todavía un sistema completo de gestión multiusuario.

# 4. Autenticación

La autenticación formal queda fuera del alcance inicial si no es necesaria para el flujo de la demo.

El acceso al dashboard podrá utilizar un mecanismo simple y apropiado para el entorno de desarrollo/demostración.

No se implementarán inicialmente:

OAuth complejo;
múltiples proveedores de identidad;
roles empresariales;
recuperación avanzada de cuentas;
gestión sofisticada de sesiones;
permisos granulares.

Si HouseMate AI evoluciona a un producto multiusuario, se deberá incorporar un sistema formal de autenticación y autorización.

# 5. Identificación mediante WhatsApp

Para el MVP, el número de WhatsApp del remitente puede utilizarse como identificador práctico del usuario.

Flujo:

WhatsApp
│
▼
Número del remitente
│
▼
HouseMate AI
│
▼
Usuario/Hogar configurado

Esto permite evitar la creación de un sistema de cuentas adicional para la demostración.

El número deberá utilizarse únicamente como identificador del usuario dentro del contexto de la aplicación y no deberá exponerse innecesariamente.

# 6. Autorización

No se implementará un sistema complejo de roles durante el MVP.

Sin embargo, las operaciones internas deberán mantener una separación clara entre:

datos del sistema;
datos del usuario;
operaciones permitidas al agente.

El agente no podrá utilizar identificadores arbitrarios para acceder a información que no corresponda al contexto configurado.

Toda operación deberá resolver primero el hogar actual y validar las relaciones sensibles contra ese contexto:

- `Expense.created_by` y `Expense.paid_by` pertenecerán al hogar del gasto;
- `Income.created_by` y `Income.member_id` pertenecerán al hogar del ingreso;
- los integrantes de `ExpenseDistribution` pertenecerán al mismo hogar;
- cualquier recurso actualizado o eliminado pertenecerá al hogar actual;
- los identificadores recibidos desde el agente nunca cambiarán el contexto resuelto por backend.

Esta separación permitirá implementar autorización formal posteriormente sin tener que rediseñar toda la aplicación.

# 7. Seguridad del agente

El agente no tendrá acceso directo a la base de datos.

El flujo será:

Usuario
│
▼
Agente
│
▼
Tool
│
▼
Service
│
▼
Database

El agente no podrá:

ejecutar SQL arbitrario;
modificar directamente tablas;
acceder a credenciales;
ejecutar operaciones administrativas;
inventar resultados de operaciones.

Las operaciones importantes pasarán por herramientas y servicios controlados por la aplicación.

# 8. Validación de operaciones

Aunque el agente interprete correctamente una solicitud, el backend deberá validar las operaciones antes de persistirlas.

Por ejemplo, al crear un gasto:

Agente
│
▼
create_expense
│
▼
Validación
├── monto válido
├── categoría válida
├── miembros válidos
└── reparto válido
│
▼
Database

El agente propone la operación.

El backend determina si la operación es válida.

# 9. Confirmación de gastos

Cuando la información proporcionada por el usuario sea suficientemente clara, el agente podrá preparar el gasto para su registro.

Cuando exista incertidumbre relevante, deberá solicitar confirmación.

Ejemplo:

Usuario:
"Compré en D1 por 185 mil."

Agente:
"¿Quieres registrarlo como Alimentación y dividirlo 50/50?"

El objetivo es evitar registros incorrectos sin convertir cada operación en un formulario manual.

Las confirmaciones entre requests utilizarán `PendingProposal`. El backend consultará por `household_id + conversation_key` y validará también el `PendingProposal.id` presentado. Si existe otra propuesta pendiente, no la sobrescribirá. Una propuesta confirmada o rechazada se eliminará; una respuesta tardía no ejecutará ninguna operación si el identificador ya fue consumido o no coincide.

Las operaciones `update` y `delete` de Expense o Income validarán primero la pertenencia del recurso al hogar. La eliminación física de Income y de Expense `PENDING`, cuando ese estado exista en el futuro, solo ocurrirá después de esa validación. Expense `CONFIRMED` se convertirá en `CANCELLED` y repetir la eliminación de un `CANCELLED` no producirá cambios.

# 10. WhatsApp Webhook

El webhook de WhatsApp deberá utilizar los mecanismos de validación proporcionados por Meta.

Se deberá comprobar:

verificación inicial del webhook;
estructura de los eventos;
tipo de mensaje recibido;
identificador del remitente;
identificador del evento/mensaje cuando esté disponible.

No se deberá asumir que cualquier solicitud recibida en el endpoint es un mensaje válido de WhatsApp.

# 11. Idempotencia

Los mensajes de WhatsApp pueden ser recibidos más de una vez.

Cuando el evento proporcione un identificador único, se deberá utilizar para evitar procesamientos duplicados.

El backend persistirá ese valor en `ProcessedWhatsAppEvent.external_event_id`, que tendrá una restricción de unicidad en PostgreSQL. La deduplicación no dependerá de memoria del proceso.

La inserción del identificador será atómica. Un conflicto de unicidad indicará un reintento y se responderá sin ejecutar nuevamente el agente o las operaciones financieras.

Conceptualmente:

WhatsApp Event
│
▼
¿Ya fue procesado?
┌──┴──┐
Sí No
│ │
▼ ▼
Ignorar Procesar

Si el identificador ya existe, el backend responderá al reintento sin volver a ejecutar el agente, tools ni operaciones financieras.

Este mecanismo debe mantenerse sencillo.

No es necesario construir inicialmente un sistema distribuido de procesamiento de eventos.

# 12. Secretos

Las credenciales y secretos deberán mantenerse fuera del código fuente.

Ejemplos:

DATABASE_URL
OPENAI_API_KEY
WHATSAPP_ACCESS_TOKEN
WHATSAPP_APP_SECRET

Los valores reales se almacenarán mediante variables de entorno.

Nunca deberán incluirse en:

código fuente;
repositorio Git;
documentación pública;
capturas de pantalla;
logs.

# 13. .env

Durante desarrollo se utilizará:

.env

Este archivo deberá estar incluido en .gitignore.

El repositorio podrá contener:

.env.example

con las variables necesarias pero sin valores reales.

Ejemplo:

DATABASE_URL=
OPENAI_API_KEY=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=

# 14. Base de datos

La base de datos no deberá ser accesible directamente desde el frontend.

El flujo será:

Frontend
│
▼
Backend
│
▼
Database

Esto permite centralizar:

validaciones;
lógica de negocio;
operaciones de escritura;
acceso a los datos.

Para el MVP no se requiere infraestructura avanzada de aislamiento de base de datos.

# 15. SQL Injection

Las consultas deberán utilizar:

ORM;
query builder;
consultas parametrizadas;

según el mecanismo elegido en tech_stack.md.

No se deberán construir consultas concatenando directamente información proporcionada por el usuario.

Incorrecto:

"SELECT * FROM expenses WHERE merchant = '" + userInput + "'"

Correcto:

Consulta parametrizada

# 16. Validación de entradas

Las entradas externas deberán validarse antes de utilizarlas.

Esto incluye:

datos recibidos por API;
mensajes de WhatsApp;
parámetros del frontend;
información proporcionada por el agente;
archivos enviados por el usuario.

Las validaciones deberán cubrir principalmente:

tipos;
campos obligatorios;
rangos;
formatos;
tamaños máximos;
valores permitidos.

No se necesita implementar un framework de validación excesivamente complejo.

# 17. Facturas e imágenes

Las imágenes enviadas por el usuario deben considerarse contenido no confiable.

El MVP deberá limitar:

formatos aceptados;
tamaño máximo;
cantidad razonable de imágenes procesadas.

Inicialmente se podrán soportar formatos comunes como:

JPEG
PNG
WEBP

No es necesario soportar todos los formatos existentes.

# 18. Almacenamiento de facturas

Las imágenes de facturas podrán almacenarse en el servicio de Storage definido para el proyecto.

La base de datos deberá conservar únicamente la referencia necesaria al archivo.

Conceptualmente:

Storage
└── receipt-image.jpg

Database
└── storage_path

No es necesario almacenar las imágenes directamente dentro de PostgreSQL.

Cada `Receipt` tendrá `household_id` y `conversation_key` controlados desde su creación, incluso cuando `expense_id` sea `NULL`. El backend verificará el hogar antes de analizar, continuar una aclaración, reintentar, cancelar o asociar el receipt. Un `receiptId` de otro hogar se rechazará y nunca podrá asociarse a un Expense del contexto actual. El `analysis_payload` parcial se tratará como información financiera sensible y no se expondrá fuera de ese contexto.

Solo un receipt `PROCESSED` podrá asociarse a un gasto. Un fallo técnico conservará el registro `FAILED` y el archivo referenciado por `storage_path` para un reintento explícito del mismo hogar. Una extracción incompleta conservará el estado `PENDING` y el archivo mientras se aclaran los datos. La cancelación eliminará tanto el registro como el archivo.

# 19. Privacidad de las facturas

Las imágenes de facturas pueden contener información financiera o personal.

Por ello:

no deberán publicarse innecesariamente;
no deberán incluirse en logs;
no deberán enviarse a servicios externos adicionales sin necesidad;
deberán eliminarse si el proyecto posteriormente implementa políticas de retención.

Para el MVP no es necesario implementar un sistema avanzado de gestión documental.

# 20. Logs

Los logs deberán utilizarse para diagnosticar errores y problemas de integración.

No deberán almacenar:

tokens;
contraseñas;
API keys;
contenido completo de conversaciones;
imágenes;
información financiera innecesaria.

Ejemplo adecuado:

expense_created
expense_id=abc123
source=WHATSAPP

No:

OPENAI_API_KEY=sk-...
WHATSAPP_ACCESS_TOKEN=...

# 21. Manejo de errores

Los errores técnicos no deberán mostrarse directamente al usuario.

Incorrecto:

PostgreSQL connection failed:
password authentication failed for user...

Correcto:

{
"error": {
"code": "INTERNAL_ERROR",
"message": "No fue posible completar la operación."
}
}

Los detalles técnicos pueden permanecer en los logs de desarrollo.

# 22. Protección contra llamadas excesivas al agente

El agente no deberá ejecutar llamadas indefinidamente.

Cada interacción deberá tener un límite razonable de:

llamadas a herramientas;
reintentos;
procesamiento de imágenes;
tamaño del contexto.

Ejemplo:

Usuario
│
▼
Agent
│
├── Tool
├── Tool
└── Tool
│
▼
Respuesta final

Si el flujo supera el límite definido, deberá finalizar de forma controlada.

Esto también permite controlar costos del proveedor de IA.

# 23. Seguridad específica del MVP

No se implementarán inicialmente:

sistema avanzado de roles;
RBAC;
OAuth empresarial;
MFA;
rate limiting avanzado;
SIEM;
auditoría empresarial;
WAF dedicado;
arquitectura multi-región;
gestión avanzada de secretos;
microservicios de seguridad;
infraestructura zero-trust.

Estas capacidades solo deberán incorporarse si una futura versión del producto realmente las necesita.

# 24. Qué queda preparado para el futuro

Aunque el MVP utilice un único usuario/hogar, la arquitectura deberá evitar decisiones que dificulten una futura expansión.

Por ejemplo, las entidades financieras deberán mantener una relación conceptual con el hogar:

Household
│
├── Members
├── Expenses
├── Incomes
└── Receipts

Esto permitirá posteriormente introducir:

User
│
▼
Household
│
├── Member
├── Member
└── Expense

sin necesidad de rediseñar completamente el dominio.

No se implementará esta funcionalidad hasta que sea necesaria.

# 25. Checklist de seguridad del MVP

Antes del despliegue de la demo:

Secretos fuera del repositorio.
.env incluido en .gitignore.
.env.example sin valores reales.
Base de datos accesible únicamente desde el backend.
Consultas parametrizadas/ORM.
Validación de entradas.
Validación de archivos.
Webhook de WhatsApp correctamente verificado.
Eventos de WhatsApp deduplicados persistentemente mediante su identificador externo único.
El agente no tiene acceso directo a SQL.
El backend valida las operaciones del agente.
Los logs no contienen secretos.
Los errores internos no se exponen al usuario.
Existe un límite para llamadas/reintentos del agente.

# 26. Evolución futura

Si HouseMate AI deja de ser un proyecto personal y comienza a utilizarse por múltiples hogares, se deberá evaluar la incorporación de:

autenticación formal;
autorización por hogar;
roles y permisos;
gestión de sesiones;
protección avanzada de APIs;
rate limiting;
auditoría;
políticas de retención de datos;
gestión avanzada de secretos;
monitoreo de seguridad.

Estas funcionalidades no forman parte del MVP.

# 27. Principio final

La seguridad de HouseMate AI debe ser proporcional al proyecto.

Durante el MVP:

Protegemos correctamente los secretos, los datos y las operaciones críticas sin construir infraestructura empresarial que todavía no necesitamos.

La prioridad es entregar una aplicación funcional, segura para su contexto y fácil de evolucionar.
