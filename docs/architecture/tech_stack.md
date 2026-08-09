# Tech Stack — HouseMate AI

Version: 1.0

---

# 1. Propósito

Este documento define las tecnologías seleccionadas para construir, ejecutar y desplegar HouseMate AI.

Las decisiones están orientadas a:

- Reducir complejidad.
- Minimizar costos.
- Permitir un desarrollo rápido del MVP.
- Mantener una arquitectura mantenible.
- Evitar infraestructura innecesaria.
- Permitir evolución futura sin sobreingeniería.

El stack deberá mantenerse deliberadamente pequeño durante el MVP.

No se incorporará una tecnología adicional únicamente porque pueda resolver un problema de forma más sofisticada si una solución existente dentro del stack es suficiente.

---

# 2. Resumen del stack

| Capa                 | Tecnología                   |
| -------------------- | ---------------------------- |
| Frontend             | Next.js                      |
| Lenguaje             | TypeScript                   |
| UI                   | React                        |
| Backend              | Next.js API / Route Handlers |
| Agente               | OpenAI Agents SDK            |
| Modelos de IA        | OpenAI API                   |
| Base de datos        | PostgreSQL                   |
| Plataforma de datos  | Supabase                     |
| Storage              | Supabase Storage             |
| Canal conversacional | WhatsApp Cloud API           |
| Hosting              | Vercel                       |
| Control de versiones | Git / GitHub                 |
| Gestor de paquetes   | npm                          |

---

# 3. Frontend

## 3.1 Next.js

Next.js será utilizado como framework principal de la aplicación web.

Responsabilidades:

- Renderizado de la interfaz.
- Routing.
- Construcción de la PWA.
- Consumo de APIs.
- Integración con el backend.
- Manejo de las páginas del dashboard.

### Justificación

Next.js permite mantener frontend y backend dentro del mismo proyecto, reduciendo la cantidad de infraestructura y repositorios necesarios para el MVP.

También proporciona una ruta sencilla hacia un despliegue en Vercel.

---

## 3.2 React

React será utilizado como biblioteca principal para construir la interfaz.

Responsabilidades:

- Componentes visuales.
- Formularios.
- Dashboard.
- Visualizaciones.
- Interacciones del usuario.

---

## 3.3 TypeScript

TypeScript será utilizado como lenguaje principal del proyecto.

Se utilizará tanto en frontend como en backend.

### Justificación

Permite mantener contratos claros entre las diferentes capas de la aplicación y reduce errores derivados del manejo de estructuras de datos complejas.

Utilizar TypeScript en todo el proyecto evita introducir lenguajes adicionales.

---

# 4. Backend

## 4.1 Next.js API / Route Handlers

El backend será implementado dentro del mismo proyecto Next.js.

Se utilizará para:

- APIs del frontend.
- Webhooks de WhatsApp.
- Coordinación del agente.
- Ejecución de herramientas.
- Validaciones.
- Casos de uso.
- Acceso a PostgreSQL.
- Acceso a Storage.
- Integraciones externas.

### Justificación

Para el tamaño y objetivo del MVP no se justifica mantener un backend independiente.

Utilizar Next.js permite desplegar frontend y backend como una única aplicación y reduce:

- infraestructura;
- configuración;
- mantenimiento;
- tiempo de desarrollo;
- costos operativos.

---

# 5. Agente de IA

## 5.1 OpenAI Agents SDK

El agente será implementado utilizando OpenAI Agents SDK.

Será responsable de:

- interpretar solicitudes;
- mantener contexto conversacional;
- seleccionar herramientas;
- solicitar información adicional;
- interpretar información de facturas;
- generar respuestas.

El agente no tendrá acceso directo a PostgreSQL.

Las operaciones del negocio se realizarán mediante herramientas controladas por el backend.

---

## 5.2 OpenAI API

OpenAI será el proveedor inicial de modelos de inteligencia artificial.

Se utilizará para:

- comprensión de lenguaje natural;
- extracción estructurada de información;
- análisis de imágenes de facturas;
- generación de respuestas.

La selección específica de modelos se realizará considerando:

- calidad;
- latencia;
- costo;
- capacidad multimodal;
- complejidad de la tarea.

No se fijará un modelo único para todas las operaciones si diferentes tareas pueden resolverse de forma más eficiente utilizando modelos distintos.

---

# 6. Base de datos

## 6.1 PostgreSQL

PostgreSQL será la base de datos principal del sistema.

Almacenará:

- gastos;
- ingresos;
- productos;
- categorías;
- reglas de reparto;
- distribuciones;
- referencias a facturas;
- propuestas pendientes de confirmación;
- identificadores externos de eventos de WhatsApp procesados;
- configuración necesaria para el funcionamiento del MVP.

### Justificación

PostgreSQL proporciona:

- modelo relacional;
- integridad referencial;
- transacciones;
- consultas SQL;
- soporte para estructuras JSON cuando sea necesario;
- amplia compatibilidad con herramientas y servicios administrados.

No se utilizará una base de datos NoSQL para el MVP.

---

## 6.2 Supabase

Supabase proporcionará PostgreSQL como servicio administrado.

También se utilizará para Storage.

Durante el MVP se evitará incorporar funcionalidades de Supabase que no sean necesarias.

En particular, no se implementará inicialmente:

- autenticación completa;
- autorización avanzada;
- Realtime;
- Edge Functions;
- funcionalidades adicionales que dupliquen responsabilidades del backend.

La lógica de negocio permanecerá en HouseMate AI.

---

# 7. Storage

## 7.1 Supabase Storage

Supabase Storage será utilizado para almacenar fotografías de facturas y otros archivos necesarios para el MVP.

La base de datos almacenará:

- identificador del archivo;
- referencia al storage;
- metadatos relevantes.

Los archivos no se almacenarán directamente dentro de PostgreSQL.

---

# 8. WhatsApp

## 8.1 WhatsApp Cloud API

WhatsApp Cloud API será el canal conversacional principal para la demostración del MVP.

Se utilizará para:

- recibir mensajes;
- recibir imágenes;
- enviar respuestas;
- recibir eventos mediante webhooks.

La integración estará aislada dentro del módulo correspondiente del backend.

El dominio no dependerá directamente de WhatsApp.

---

# 9. Hosting

## 9.1 Vercel

Vercel será utilizado para desplegar la aplicación Next.js.

Proporcionará:

- hosting;
- HTTPS;
- despliegue automático;
- ejecución de la aplicación;
- acceso público para los webhooks.

### Justificación

Vercel permite desplegar el proyecto sin administrar servidores.

Esto resulta especialmente adecuado para un proyecto personal con un MVP de alcance limitado.

---

# 10. Control de versiones

## 10.1 Git

Git será utilizado para control de versiones.

---

## 10.2 GitHub

GitHub será utilizado como repositorio remoto.

El repositorio contendrá:

- código fuente;
- documentación;
- configuración del proyecto;
- historial de cambios.

Los secretos y credenciales nunca deberán almacenarse en el repositorio.

---

# 11. Gestión de dependencias

## 11.1 npm

npm será utilizado como gestor de paquetes.

Se evitará agregar dependencias externas cuando la funcionalidad requerida pueda implementarse razonablemente con:

- capacidades nativas de JavaScript/TypeScript;
- Next.js;
- React;
- PostgreSQL;
- herramientas ya incluidas en el stack.

Cada dependencia adicional deberá tener una justificación clara.

---

# 12. Configuración y secretos

Las credenciales y configuraciones sensibles se manejarán mediante variables de entorno.

Ejemplos:

```text
OPENAI_API_KEY
WHATSAPP_ACCESS_TOKEN
WHATSAPP_VERIFY_TOKEN
WHATSAPP_PHONE_NUMBER_ID
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
```

# 13. Validación de datos

Las entradas externas deberán validarse antes de llegar a la lógica de negocio.

Las principales fuentes de entrada serán:

solicitudes del frontend;
webhooks de WhatsApp;
respuestas de proveedores externos;
resultados generados por el agente.

La validación deberá realizarse en el backend.

No se confiará únicamente en las validaciones realizadas por el frontend o por el modelo de IA.

# 14. Comunicación entre componentes

La comunicación seguirá principalmente los siguientes protocolos:

Comunicación Tecnología
Usuario → Web/PWA HTTPS
Web/PWA → Backend HTTPS / JSON
WhatsApp → Backend HTTPS / Webhook
Backend → WhatsApp HTTPS / REST API
Backend → OpenAI HTTPS / API
Backend → PostgreSQL PostgreSQL
Backend → Storage Supabase API / SDK

No se utilizarán sistemas de mensajería internos para el MVP.

No se utilizarán colas distribuidas.

# 15. PWA

La aplicación web podrá instalarse como Progressive Web App.

La PWA tendrá como objetivo proporcionar una experiencia similar a una aplicación móvil sin desarrollar una aplicación nativa independiente.

No se desarrollarán aplicaciones independientes para:

Android;
iOS.

durante el MVP.

# 16. Testing

El proyecto utilizará diferentes niveles de pruebas según el riesgo de cada componente.

Pruebas unitarias

Se utilizarán principalmente para:

reglas de reparto;
cálculos financieros;
validaciones;
casos de uso críticos.
Pruebas de integración

Se utilizarán para validar:

PostgreSQL;
Storage;
OpenAI;
WhatsApp;
APIs internas.
Pruebas manuales

Se utilizarán para validar principalmente:

experiencia conversacional;
flujo completo de registro;
dashboard;
interacción con facturas;
comportamiento de WhatsApp.

Durante el MVP no se buscará una cobertura exhaustiva de pruebas.

Se priorizarán las partes donde un error pueda producir información financiera incorrecta.

# 17. Observabilidad

Para el MVP se utilizará una estrategia de observabilidad simple.

Se registrarán:

errores de aplicación;
errores de integraciones;
solicitudes importantes;
fallos del agente;
errores de procesamiento de facturas.

No se implementará inicialmente una plataforma compleja de observabilidad.

Se utilizarán los mecanismos proporcionados por Vercel y logs de aplicación.

# 18. Costos

El stack deberá priorizar servicios con planes gratuitos o de bajo costo durante el MVP.

Los principales costos variables esperados serán:

consumo de modelos de OpenAI;
uso de WhatsApp según las condiciones aplicables de Meta;
almacenamiento y uso de Supabase si se superan los límites gratuitos.

No se contratarán servidores dedicados ni infraestructura propia.

# 19. Tecnologías deliberadamente descartadas

Para evitar sobreingeniería, no se utilizarán inicialmente:

FastAPI;
Express como backend independiente;
NestJS;
MongoDB;
Redis;
Docker como requisito de despliegue;
Kubernetes;
RabbitMQ;
Kafka;
microservicios;
servidores dedicados;
infraestructura cloud compleja;
aplicaciones móviles nativas.

Estas tecnologías podrían ser evaluadas posteriormente si las necesidades reales del sistema las justifican.

# 20. Criterio para incorporar nuevas tecnologías

Una nueva tecnología solo deberá incorporarse cuando:

Resuelva un problema real del proyecto.
La solución actual resulte insuficiente.
El beneficio justifique la complejidad adicional.
No exista una alternativa razonablemente simple dentro del stack actual.

El objetivo no es utilizar la mayor cantidad de tecnologías posible, sino construir una solución robusta con el menor nivel de complejidad necesario.

# 21. Decisiones tecnológicas principales

TECH-001

Next.js será utilizado como framework principal de frontend y backend.

TECH-002

TypeScript será utilizado como lenguaje principal.

TECH-003

PostgreSQL será la fuente de verdad de los datos financieros.

TECH-004

Supabase proporcionará PostgreSQL y Storage administrados.

TECH-005

OpenAI será el proveedor inicial de inteligencia artificial.

TECH-006

OpenAI Agents SDK será utilizado para implementar el agente.

TECH-007

WhatsApp Cloud API será el canal conversacional externo.

TECH-008

Vercel será la plataforma inicial de despliegue.

TECH-009

No se implementará autenticación formal durante el MVP.

TECH-010

No se utilizarán microservicios ni infraestructura distribuida durante el MVP.

# 22. Evolución futura

El stack deberá permitir incorporar posteriormente:

autenticación formal;
múltiples hogares;
múltiples usuarios;
aplicaciones móviles nativas;
integraciones bancarias;
nuevos proveedores de IA;
nuevos canales conversacionales;
procesamiento asíncrono;
caching;
servicios independientes.

Estas capacidades no forman parte del MVP y no deberán introducir complejidad anticipada en la implementación actual.

# 23. Documentos relacionados

Project Vision
Product Requirements Document
Architecture Overview
C4 Context
C4 Container
Data Model
Agent Architecture
API Contract (`api_contract.md`)
Security

### Una decisión que mantengo deliberadamente: FastAPI

Aquí queda documentado que **FastAPI no se utilizará**, pero no porque sea malo. De hecho, para un backend Python sería una excelente elección.

La razón es mucho más simple: **para este proyecto concreto, Next.js ya nos permite tener frontend + API + webhooks + despliegue en una sola aplicación**. Meter FastAPI significaría mantener dos runtimes y, probablemente, dos despliegues para resolver un problema que no tenemos.

Así que no estamos diciendo _"Next.js es mejor que FastAPI"_; estamos diciendo **"FastAPI no aporta suficiente valor adicional para justificar otra aplicación en este MVP"**.

Y esto encaja exactamente con la regla que hemos venido usando: **si una tecnología no resuelve una necesidad real, no la agregamos.**
