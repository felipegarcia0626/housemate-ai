1. Introducción
   1.1 Objetivo

Describe el propósito del documento y deja claro que este define los requisitos funcionales y no funcionales del MVP.

1.2 Alcance

Explica qué cubre este PRD (el MVP) y qué queda fuera.

1.3 Definiciones

Incluye un pequeño glosario para evitar ambigüedades:

Agente
Tool
Hogar
Gasto compartido
Gasto personal
Regla de reparto
Dashboard
Canal
Factura
OCR

# 2. Actores y responsabilidades

## Objetivo

Esta sección identifica todos los actores que interactúan con HouseMate AI y define claramente sus responsabilidades dentro del sistema. Esto permitirá establecer posteriormente los permisos, casos de uso, reglas de negocio y funcionalidades asociadas a cada uno.

---

# 2.1 Usuario

El usuario representa cualquier persona que utiliza HouseMate AI para gestionar sus finanzas personales o las finanzas compartidas de un hogar.

En el MVP no existirán diferencias funcionales entre usuarios propietarios o invitados; todos los integrantes de un mismo hogar tendrán las mismas capacidades.

### Responsabilidades

- Registrar gastos mediante lenguaje natural.
- Registrar gastos enviando fotografías de facturas.
- Confirmar o corregir la información interpretada por el agente.
- Configurar las reglas de reparto de gastos.
- Consultar balances, estadísticas e indicadores.
- Realizar preguntas al agente sobre su información financiera.
- Editar o eliminar registros cuando sea necesario.

---

# 2.2 Agente de IA

El agente constituye el núcleo del sistema y será la interfaz principal entre el usuario y la plataforma.

Su responsabilidad no consiste únicamente en responder preguntas, sino en comprender el contexto, razonar sobre la información disponible y utilizar las herramientas necesarias para ejecutar acciones dentro del sistema.

### Responsabilidades

- Comprender instrucciones escritas en lenguaje natural.
- Interpretar fotografías de facturas.
- Extraer información relevante de las compras.
- Clasificar automáticamente los gastos.
- Aplicar las reglas de reparto configuradas.
- Solicitar aclaraciones cuando exista incertidumbre.
- Ejecutar herramientas para consultar o modificar información.
- Responder consultas utilizando información almacenada en el sistema.
- Generar recomendaciones o alertas basadas en los datos disponibles.

---

# 2.3 Herramientas (Tools)

Las herramientas representan las capacidades operativas que el agente puede utilizar para interactuar con el sistema.

Las herramientas no toman decisiones; únicamente ejecutan acciones solicitadas por el agente.

Ejemplos de herramientas que formarán parte del MVP:

- Registrar un gasto.
- Consultar gastos.
- Registrar un ingreso.
- Consultar ingresos.
- Obtener balances.
- Actualizar un gasto.
- Eliminar un gasto.
- Actualizar un ingreso.
- Eliminar un ingreso.
- Consultar categorías.
- Obtener indicadores para el dashboard.

La definición detallada de cada herramienta se encuentra en `docs/architecture/agent_architecture.md`.

---

# 2.4 Backend

El backend expone las capacidades del sistema mediante una API y concentra la lógica de negocio que no depende del razonamiento del agente.

### Responsabilidades

- Validar las solicitudes recibidas.
- Gestionar autenticación y autorización.
- Ejecutar la lógica de negocio.
- Persistir la información.
- Exponer las herramientas consumidas por el agente.
- Garantizar la integridad de los datos.

---

# 2.5 Base de datos

La base de datos constituye la fuente única de verdad para toda la información del sistema.

### Responsabilidades

- Almacenar usuarios, hogares y gastos.
- Almacenar reglas de reparto.
- Mantener el historial de transacciones.
- Garantizar consistencia e integridad de los datos.

---

# 2.6 Canales de interacción

Los canales representan distintos medios para acceder a las mismas capacidades del sistema. El agente atiende interacciones conversacionales y Web/PWA puede consumir casos de uso controlados del backend.

Todos deberán ofrecer una experiencia funcionalmente equivalente.

### Canales incluidos en el MVP

- WhatsApp.
- Aplicación web responsive.

### Canales considerados para futuras versiones

- Aplicaciones móviles nativas.
- Telegram.
- Integraciones por voz.
- Otros canales conversacionales.

---

# Principio arquitectónico

El agente es la interfaz conversacional principal. Web/PWA también puede consumir directamente casos de uso controlados del backend para vistas y operaciones explícitas.

Ningún canal accederá directamente a la base de datos ni contendrá lógica de negocio. Tanto el agente como Web/PWA utilizarán el mismo backend y dominio.

Del mismo modo, las herramientas nunca conocerán desde qué canal fue originada una solicitud.

Esta separación garantiza que nuevas interfaces puedan incorporarse en el futuro sin modificar el comportamiento del agente ni de la lógica de negocio.

# 3. Modelo conceptual del dominio

## Objetivo

Esta sección define los conceptos fundamentales sobre los cuales se construye HouseMate AI. Su propósito es establecer un lenguaje común para todo el proyecto y garantizar que las decisiones de diseño, arquitectura e implementación utilicen el mismo modelo mental.

El modelo conceptual describe entidades del negocio, no componentes técnicos. Por esta razón, permanece independiente de la base de datos, la arquitectura o la tecnología utilizada.

---

# Principios del dominio

El dominio de HouseMate AI se basa en los siguientes principios:

- Un usuario puede pertenecer a uno o varios hogares (el MVP soportará un único hogar por usuario).
- Un hogar puede estar compuesto por uno o varios integrantes.
- Toda la actividad financiera del hogar se registra mediante entidades independientes `Expense` e `Income`.
- “Movimiento financiero” se utiliza únicamente como término funcional colectivo para referirse a gastos e ingresos; no representa una entidad, tabla, jerarquía ni tipo persistente.
- Todo gasto puede afectar a uno o varios integrantes.
- Las reglas de reparto determinan cómo se distribuye el valor de un gasto.
- El balance de compensación de cada integrante se calcula automáticamente a partir de los gastos compartidos, sus pagadores y distribuciones.
- El agente interpreta la intención del usuario; las reglas del dominio determinan cómo se almacena y procesa esa información.

---

# Conceptos principales

## Hogar (Household)

El hogar representa la unidad principal del sistema.

Toda la información financiera se organiza alrededor de un hogar.

Un hogar contiene:

- Integrantes.
- Gastos e ingresos.
- Reglas de reparto.
- Categorías.
- Balances.
- Historial financiero.

En el MVP cada usuario pertenecerá a un único hogar.

La arquitectura deberá permitir soportar múltiples hogares por usuario en versiones futuras sin requerir cambios estructurales.

---

## Integrante

Un integrante es cualquier persona que forma parte de un hogar.

Cada integrante puede:

- Registrar gastos e ingresos.
- Consultar información.
- Realizar preguntas al agente.
- Consultar y aplicar reglas compartidas preconfiguradas.
- Participar en el reparto de gastos.

Todos los integrantes poseen los mismos permisos durante el MVP.

---

## Gastos e ingresos como registros financieros

“Movimiento financiero” es solo una expresión funcional para hablar conjuntamente de los registros económicos del hogar. El modelo implementará dos entidades independientes:

- Ingreso.
- Gasto.

Ambas entidades contienen conceptualmente:

- Responsable del registro.
- Valor.
- Fecha.
- Descripción.

La categoría dependerá del tipo de registro y será opcional para los ingresos.

Cada entidad define sus propios atributos y reglas. No existirá un campo común `type`, una entidad base ni una abstracción técnica compartida.

---

## Ingreso

Un ingreso representa cualquier entrada de dinero al hogar o a uno de sus integrantes.

Ejemplos:

- Salario.
- Honorarios.
- Venta de un artículo.
- Regalo.
- Reembolso.
- Ingreso ocasional.

Los ingresos no requieren reglas de reparto ni análisis de productos.

Su propósito es complementar la información financiera y permitir un análisis más completo del flujo de dinero.

Para el MVP, un ingreso podrá registrarse, consultarse, editarse y eliminarse físicamente. Tendrá fecha, monto, descripción, integrante asociado y una categoría opcional.

`Income` será una entidad independiente. No existirá una entidad base compartida ni una abstracción técnica genérica entre ingresos y gastos.

Quedan fuera del alcance de ingresos la recurrencia, nómina, impuestos, proyecciones, presupuestos, integraciones bancarias, automatizaciones y workflows.

---

## Gasto

Un gasto representa cualquier salida de dinero registrada dentro del hogar.

Un gasto podrá incluir:

- Participantes afectados.
- Regla de reparto aplicada.
- Comercio.
- Imagen de la factura.
- Productos detectados.
- Observaciones.

Los gastos constituyen el principal foco funcional del MVP.

---

## Producto

Un producto representa cada artículo identificado dentro de una factura.

No todos los gastos tendrán productos asociados, pero cuando exista una factura el agente intentará identificarlos individualmente.

Esto permitirá:

- Clasificaciones más precisas.
- Estadísticas por tipo de compra.
- Reglas de reparto diferentes dentro de un mismo gasto.
- Mayor capacidad analítica.

Ejemplo:

Compra en supermercado:

- Leche.
- Shampoo.
- Arena para gato.
- Papel higiénico.

Aunque pertenezcan a la misma factura, podrán clasificarse en categorías distintas.

---

## Categoría

Las categorías permiten agrupar movimientos financieros con características similares.

Ejemplos de categorías de gastos:

- Mercado.
- Restaurantes.
- Transporte.
- Mascotas.
- Salud.
- Entretenimiento.

Ejemplos de categorías de ingresos:

- Salario.
- Freelance.
- Venta.
- Reembolso.
- Otros ingresos.

El agente propondrá automáticamente la categoría más adecuada, aunque el usuario siempre podrá modificarla.

---

## Regla de reparto

Una regla de reparto determina cómo se distribuye económicamente un gasto entre los integrantes del hogar.

Ejemplos:

- 50% / 50%.
- 70% / 30%.
- 100% para un integrante.
- Reparto personalizado.

Las reglas podrán reutilizarse en diferentes gastos.

Los ingresos no utilizan reglas de reparto.

---

## Balance

El balance de compensación representa cuánto debe compensar un integrante a otro por gastos compartidos.

Se calcula exclusivamente a partir de los gastos confirmados, el integrante que pagó y las distribuciones aplicables. Los ingresos no modifican este balance.

El resultado financiero es un concepto diferente y puede incorporar ingresos y gastos para mostrar el total de ingresos, el total gastado y el resultado neto.

---

## Agente

El agente constituye la interfaz principal del sistema.

No almacena información financiera.

Su responsabilidad consiste en:

- Comprender la intención del usuario.
- Obtener contexto.
- Solicitar aclaraciones cuando sea necesario.
- Seleccionar las herramientas adecuadas.
- Presentar respuestas comprensibles.

El agente nunca debe realizar cálculos utilizando información parcial ni generar respuestas basadas en suposiciones.

---

# Relaciones conceptuales

El dominio puede resumirse mediante el siguiente modelo:

```text
Usuario
    │
    ▼
 Hogar
    │
    ├───────────────┐
    │               │
    ▼               ▼
Integrantes      Expense e Income
                      │
          ┌───────────┴────────────┐
          ▼                        ▼
      Ingresos                 Gastos
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                    Productos         Regla de reparto
                         │                     │
                         └──────────┬──────────┘
                                    ▼
                                Balance
                                    │
                                    ▼
                               Dashboard
                                    │
                                    ▼
                           Consultas al agente
```

---

# Principios del modelo

Todo el sistema deberá respetar los siguientes principios:

- El hogar es la unidad organizacional principal.
- Todo Expense e Income pertenece exactamente a un hogar.
- Expense e Income permanecen como entidades independientes.
- Ningún balance o resultado financiero derivado se almacena manualmente. El balance de compensación se calcula con gastos y el resultado financiero con ingresos y gastos.
- El agente interpreta la información, pero nunca modifica las reglas del dominio.
- Las reglas de reparto son exclusivas de los gastos.
- El dashboard y las respuestas del agente utilizan exactamente la misma información y siempre deben producir resultados consistentes.

Este modelo conceptual servirá como base para el diseño de la base de datos, la arquitectura del sistema, el diseño del agente y la implementación de las herramientas.

# 4. Casos de uso

## Objetivo

Esta sección describe las capacidades funcionales que deberá ofrecer HouseMate AI durante el MVP.

Cada caso de uso representa una interacción completa entre el usuario y el sistema orientada a resolver una necesidad del negocio.

Los casos de uso son independientes del canal de interacción (WhatsApp o aplicación web) y describen el comportamiento esperado del sistema, no la implementación de la interfaz.

---

# UC-001 Registrar un gasto

## Objetivo

Permitir que el usuario registre un gasto utilizando lenguaje natural o una fotografía de una factura, minimizando el esfuerzo requerido para ingresar la información.

## Actor principal

Usuario.

## Disparador

El usuario informa al agente que realizó una compra.

## Flujo principal

1. El usuario comunica el gasto mediante texto o imagen.
2. El agente interpreta la información disponible.
3. El agente identifica el comercio, productos, categorías, monto y participantes cuando sea posible.
4. Si existe información faltante o ambigua, el agente solicita únicamente las aclaraciones necesarias.
5. El agente presenta un resumen del registro.
6. El usuario confirma la información.
7. El sistema registra el gasto.
8. El balance y el dashboard se actualizan automáticamente.

## Flujos alternativos

- La factura no puede interpretarse completamente.
- El usuario modifica la propuesta realizada por el agente.
- El gasto corresponde únicamente a un integrante del hogar.

## Resultado esperado

El gasto queda registrado correctamente y disponible para consultas posteriores.

---

# UC-002 Registrar un ingreso

## Objetivo

Permitir registrar cualquier ingreso económico del hogar utilizando lenguaje natural.

## Actor principal

Usuario.

## Flujo principal

1. El usuario informa el ingreso.
2. El agente identifica el monto, descripción, fecha, integrante asociado y categoría opcional.
3. Si es necesario, solicita aclaraciones.
4. Presenta el resumen para confirmación.
5. El usuario confirma.
6. El sistema registra el ingreso.
7. El dashboard y el resultado financiero se actualizan automáticamente. El balance de compensación no cambia por registrar un ingreso.

## Resultado esperado

El ingreso queda almacenado y participa en los resúmenes y resultados financieros, pero no en el balance de compensación entre integrantes.

---

# UC-003 Administrar un movimiento financiero

## Objetivo

Permitir corregir información previamente registrada.

## Actor principal

Usuario.

## Alcance

Incluye:

- Editar movimientos.
- Eliminar movimientos.

## Flujo principal

1. El usuario solicita modificar un movimiento.
2. El agente identifica el registro correspondiente.
3. Presenta la información actual.
4. El usuario indica las modificaciones.
5. El sistema actualiza la información.
6. Todos los cálculos derivados se recalculan automáticamente.

## Resultado esperado

La información financiera permanece consistente después de cualquier modificación.

---

# UC-004 Explorar información financiera

## Objetivo

Permitir que el usuario consulte la información financiera del hogar mediante visualizaciones y consultas conversacionales.

## Actor principal

Usuario.

## Capacidades

- Dashboard.
- Balance entre integrantes.
- Historial de movimientos.
- Tendencias.
- Indicadores por categoría.
- Indicadores por período.

## Flujo principal

1. El usuario solicita información.
2. El agente identifica la intención.
3. Obtiene la información necesaria utilizando las herramientas del sistema.
4. Presenta la respuesta mediante gráficos, tablas o lenguaje natural según corresponda.

## Resultado esperado

El usuario obtiene una visión clara y actualizada del estado financiero del hogar.

---

# UC-005 Consultar al agente

## Objetivo

Permitir que el usuario obtenga respuestas utilizando lenguaje natural sin necesidad de conocer la estructura de los datos.

## Actor principal

Usuario.

## Ejemplos

- ¿Cuánto debo este mes?
- ¿Quién ha pagado más?
- ¿Cuánto gastamos en restaurantes?
- ¿Cuál fue nuestro gasto promedio?
- ¿Qué categoría aumentó más este mes?
- ¿Cuánto dinero ingresó este mes?

## Flujo principal

1. El usuario realiza una pregunta.
2. El agente interpreta la intención.
3. Selecciona las herramientas necesarias.
4. Obtiene la información.
5. Genera una respuesta clara y contextualizada.

## Resultado esperado

El usuario obtiene la información solicitada sin necesidad de navegar por la aplicación.

---

# UC-006 Consultar y aplicar reglas de reparto

## Objetivo

Permitir definir cómo se distribuyen los gastos compartidos dentro del hogar.

## Actor principal

Usuario.

## Capacidades

- Consultar reglas preconfiguradas.
- Aplicar reglas existentes.
- Ajustar la distribución propuesta para un gasto antes de confirmarlo.

## Ejemplos

- 50 / 50
- 70 / 30
- 100% para un integrante
- Reparto personalizado

## Resultado esperado

Las reglas quedan disponibles para que el agente las aplique automáticamente durante el registro de gastos.

---

# UC-007 Consultar categorías

## Objetivo

Permitir consultar el catálogo preconfigurado utilizado para clasificar gastos e ingresos.

## Actor principal

Usuario.

## Capacidades

- Consultar categorías existentes.
- Utilizar categorías iniciales cargadas mediante seed/configuración.

## Resultado esperado

El agente utiliza estas categorías como referencia para clasificar automáticamente los movimientos financieros.

---

# Consideraciones generales

Todos los casos de uso deberán cumplir los siguientes principios:

- El usuario puede interactuar mediante el agente o mediante vistas Web/PWA que delegan en el mismo backend; nunca accede directamente a la lógica de negocio ni a la base de datos.
- El agente solicita la menor cantidad posible de información adicional.
- Todas las operaciones deberán reflejarse inmediatamente en el dashboard y en las consultas posteriores.
- Ninguna funcionalidad dependerá del canal utilizado.
- Toda acción deberá preservar la consistencia del balance de compensación y de los resultados financieros derivados.
- Cuando exista incertidumbre, el agente preguntará antes de asumir información.

# 5. Requerimientos funcionales

## Objetivo

Esta sección define las capacidades funcionales que deberá implementar HouseMate AI para satisfacer los casos de uso del MVP.

Cada requerimiento describe un comportamiento esperado del sistema y será utilizado posteriormente como referencia para el diseño técnico, la implementación y las pruebas de aceptación.

---

# 5.1 Gestión de movimientos financieros

### RF-001

El sistema deberá permitir registrar las entidades independientes **Income** y **Expense**.

---

### RF-002

El registro de un movimiento podrá iniciarse mediante texto en lenguaje natural. Los gastos también podrán iniciarse mediante una fotografía de una factura.

---

### RF-003

Todo Expense e Income deberá permanecer asociado a un hogar y a un integrante responsable de su registro.

---

### RF-004

El sistema deberá permitir editar y eliminar movimientos previamente registrados.

---

### RF-005

Toda modificación de gastos deberá reflejarse en el balance de compensación. Las modificaciones de gastos o ingresos deberán reflejarse en el dashboard, los indicadores y cualquier resultado financiero derivado.

---

# 5.2 Interpretación mediante IA

### RF-006

El agente deberá interpretar instrucciones escritas utilizando lenguaje natural.

---

### RF-007

El agente deberá identificar automáticamente la mayor cantidad posible de información antes de solicitar aclaraciones al usuario.

---

### RF-008

Cuando exista incertidumbre, el agente solicitará únicamente la información estrictamente necesaria para completar el registro.

---

### RF-009

El agente deberá generar un resumen del movimiento antes de almacenarlo y solicitar la confirmación del usuario.

---

### RF-010

Cuando el usuario envíe una factura, el agente deberá identificar los productos detectados y proponer su clasificación automática.

---

### RF-011

El usuario podrá corregir cualquier información propuesta por el agente antes de confirmar el registro.

---

# 5.3 Dashboard

### RF-012

El sistema deberá generar automáticamente indicadores financieros utilizando la información registrada.

---

### RF-013

El dashboard deberá reflejar inmediatamente cualquier modificación realizada sobre los movimientos financieros.

---

### RF-014

El dashboard deberá permitir consultar la información por diferentes períodos de tiempo.

---

### RF-015

El dashboard deberá presentar indicadores tanto a nivel general del hogar como por integrante.

---

# 5.4 Consultas conversacionales

### RF-016

El usuario podrá consultar información financiera utilizando lenguaje natural.

---

### RF-017

El agente deberá seleccionar automáticamente las herramientas necesarias para responder cada consulta.

---

### RF-018

Las respuestas deberán utilizar exclusivamente información almacenada en el sistema.

---

### RF-019

Cuando la información disponible sea insuficiente, el agente deberá indicarlo explícitamente en lugar de generar respuestas especulativas.

---

# 5.5 Reglas de reparto

### RF-020

El sistema deberá permitir consultar y aplicar reglas preconfiguradas reutilizables para distribuir gastos compartidos.

---

### RF-021

El agente deberá aplicar automáticamente la regla correspondiente durante el registro de un gasto cuando exista una configuración válida.

---

### RF-022

El usuario podrá modificar la regla propuesta antes de confirmar el registro.

---

### RF-023

Las reglas de reparto solo aplicarán a movimientos de tipo gasto.

---

# 5.6 Categorías

### RF-024

El sistema deberá mantener un catálogo preconfigurado de categorías para ingresos y gastos, cargado mediante seed/configuración y consultable desde el backend.

---

### RF-025

El agente propondrá la categoría más adecuada cuando exista información suficiente. Un ingreso podrá registrarse sin categoría.

---

### RF-026

El usuario podrá aceptar o modificar la categoría sugerida.

---

# 5.7 Persistencia y consistencia

### RF-027

Toda operación realizada por el usuario deberá persistirse antes de generar una confirmación exitosa.

---

### RF-028

El balance de compensación y los resultados financieros deberán calcularse siempre a partir de la información registrada y nunca almacenarse manualmente.

---

### RF-029

El dashboard y las respuestas del agente deberán utilizar exactamente la misma fuente de datos.

---

### RF-030

Todas las operaciones deberán preservar la consistencia del modelo de dominio incluso cuando un movimiento sea modificado o eliminado.

---

# Principios funcionales

Todos los requerimientos definidos anteriormente deberán cumplir los siguientes principios:

- El agente constituye el punto principal de interacción con el sistema.
- El usuario siempre podrá revisar y confirmar la información antes de que sea almacenada.
- El sistema deberá minimizar la cantidad de interacción necesaria para completar una tarea.
- El comportamiento del sistema deberá ser independiente del canal utilizado.
- Ningún cálculo financiero podrá depender de información no confirmada por el usuario.
- Toda respuesta generada por el agente deberá ser consistente con la información almacenada.

# 6. Reglas de negocio

## Objetivo

Esta sección define las reglas que gobiernan el comportamiento del dominio de HouseMate AI.

Las reglas de negocio representan decisiones propias del producto y deberán cumplirse independientemente de la tecnología utilizada, el canal de interacción o la implementación del sistema.

Cuando exista conflicto entre una implementación técnica y una regla de negocio, deberá prevalecer la regla de negocio.

---

# 6.1 Hogar e integrantes

### RN-001

Todo Expense e Income deberá pertenecer exactamente a un hogar.

---

### RN-002

Todo Expense e Income deberá tener un responsable de su registro.

---

### RN-003

El balance de compensación se calculará únicamente con gastos pertenecientes al mismo hogar. Los resúmenes de ingresos también se limitarán al hogar correspondiente.

---

### RN-004

En el MVP, cada usuario pertenecerá a un único hogar.

La arquitectura deberá permitir soportar múltiples hogares en versiones futuras.

---

# 6.2 Movimientos financieros

### RN-005

Los registros financieros del MVP serán exclusivamente Expense e Income independientes. No se implementará una entidad o tipo genérico de movimiento.

---

### RN-006

Expense e Income deberán contener como mínimo:

- Fecha.
- Valor.
- Responsable.
  La categoría será opcional para los ingresos.

---

### RN-007

Ningún gasto afectará el balance de compensación hasta haber sido confirmado. Ningún gasto o ingreso afectará los indicadores hasta haber sido confirmado y persistido.

---

### RN-008

La modificación o eliminación de un movimiento deberá reflejarse inmediatamente en todos los cálculos derivados.

---

# 6.3 Gastos

### RN-009

Todo gasto deberá afectar al menos a un integrante del hogar.

---

### RN-010

Un gasto podrá distribuirse entre varios integrantes utilizando una regla de reparto.

---

### RN-011

Cuando un gasto no tenga una regla explícita, el agente propondrá una distribución, pero nunca la aplicará sin confirmación del usuario.

---

### RN-012

Cuando una factura contenga múltiples productos, el agente intentará clasificarlos individualmente antes de clasificarlos como una única compra.

---

# 6.4 Ingresos

### RN-013

Los ingresos no utilizarán reglas de reparto.

---

### RN-014

Los ingresos incrementarán el resultado financiero del integrante al que pertenezcan.

No modificarán el balance de compensación entre integrantes, que se calcula exclusivamente a partir de gastos compartidos.

---

# 6.5 Reglas de reparto

### RN-015

Toda regla de reparto deberá distribuir el 100 % del valor del gasto.

---

### RN-016

Una regla de reparto podrá reutilizarse en múltiples gastos.

---

### RN-017

El usuario podrá modificar la regla aplicada antes de confirmar el registro.

---

# 6.6 Categorías

### RN-018

Los gastos podrán clasificarse mediante las categorías definidas para el producto. Para los ingresos, la categoría será opcional.

---

### RN-019

El agente propondrá automáticamente una categoría utilizando el contexto disponible.

---

### RN-020

La decisión final sobre la categoría siempre corresponderá al usuario.

---

# 6.7 Agente

### RN-021

El agente nunca deberá asumir información cuando exista incertidumbre relevante.

---

### RN-022

El agente realizará únicamente las preguntas necesarias para completar una operación con un nivel razonable de confianza.

---

### RN-023

Antes de ejecutar cualquier operación que modifique la información financiera, el agente deberá presentar un resumen para confirmación.

---

### RN-024

El agente nunca modificará información previamente registrada sin una instrucción explícita del usuario.

---

### RN-025

Las respuestas del agente deberán construirse exclusivamente utilizando información almacenada en el sistema y herramientas autorizadas.

---

# 6.8 Dashboard y consultas

### RN-026

El dashboard y las respuestas conversacionales deberán utilizar exactamente la misma fuente de datos.

---

### RN-027

Los indicadores financieros nunca podrán calcularse utilizando información pendiente de confirmación.

---

### RN-028

Toda consulta deberá reflejar el estado más reciente de la información registrada.

---

# 6.9 Consistencia del dominio

### RN-029

El balance de compensación nunca se almacenará como un valor persistente; siempre deberá calcularse a partir de gastos confirmados, pagadores y distribuciones. Los ingresos no participarán en este cálculo.

Los totales de ingresos y el resultado neto también serán calculados y no se almacenarán como agregados derivados.

---

### RN-030

Toda modificación en los movimientos financieros deberá mantener la consistencia del modelo de dominio.

---

### RN-031

Las reglas del dominio deberán comportarse de la misma manera independientemente del canal desde el cual se origine la solicitud (WhatsApp, aplicación web u otros canales futuros).

---

# Principios generales

Las siguientes reglas deberán considerarse principios transversales del producto:

- El hogar constituye la unidad organizacional del sistema.
- Expense e Income persistidos representan la fuente de verdad para los cálculos financieros.
- El agente interpreta la intención del usuario, pero no reemplaza las reglas del dominio.
- Toda información financiera deberá ser verificable a partir de los datos almacenados.
- El sistema priorizará minimizar la fricción del usuario sin comprometer la consistencia de la información.

# 7. Requerimientos no funcionales

## Objetivo

Esta sección define los atributos de calidad que deberá cumplir HouseMate AI independientemente de las funcionalidades implementadas.

Estos requisitos garantizan que el sistema ofrezca una experiencia consistente, confiable y escalable durante el MVP y sirva como base para futuras versiones.

---

# 7.1 Rendimiento

### RNF-001

Las consultas al backend deberán responder en un tiempo adecuado para ofrecer una experiencia fluida al usuario.

---

### RNF-002

El dashboard deberá reflejar los cambios inmediatamente después de confirmar un movimiento financiero.

---

### RNF-003

El sistema deberá soportar múltiples consultas consecutivas sin degradar significativamente la experiencia del usuario.

---

# 7.2 Disponibilidad

### RNF-004

La aplicación deberá continuar funcionando incluso cuando uno de los canales de interacción no se encuentre disponible.

Por ejemplo, si WhatsApp presenta una interrupción, la aplicación web deberá seguir operando normalmente.

---

# 7.3 Consistencia

### RNF-005

Toda respuesta presentada al usuario deberá reflejar información consistente con la base de datos.

---

### RNF-006

No podrán existir diferencias entre la información mostrada por el dashboard y la obtenida mediante consultas conversacionales.

---

# 7.4 Experiencia del usuario

### RNF-007

La interacción deberá minimizar la cantidad de pasos necesarios para completar una operación.

---

### RNF-008

El sistema deberá priorizar conversaciones naturales sobre formularios estructurados siempre que sea posible.

---

### RNF-009

Cuando una operación requiera información adicional, únicamente deberá solicitarse la información indispensable.

---

# 7.5 Inteligencia del agente

### RNF-010

El agente deberá utilizar el contexto disponible antes de solicitar información adicional.

---

### RNF-011

El agente deberá mantener coherencia durante toda la conversación.

---

### RNF-012

El agente nunca deberá inventar información financiera inexistente.

---

### RNF-013

Cuando exista incertidumbre suficiente para afectar un registro o una respuesta, el agente deberá solicitar confirmación al usuario.

---

### RNF-014

El agente deberá explicar claramente cualquier limitación cuando no disponga de información suficiente para responder una consulta.

---

# 7.6 Seguridad

### RNF-015

Cada usuario únicamente podrá acceder a la información correspondiente a su hogar.

---

### RNF-016

Todas las operaciones que modifiquen información financiera deberán quedar registradas.

---

### RNF-017

El sistema nunca deberá exponer información financiera de otros hogares.

---

# 7.7 Escalabilidad

### RNF-018

La arquitectura deberá permitir incorporar nuevos canales de interacción sin modificar la lógica del dominio.

---

### RNF-019

La arquitectura deberá permitir incorporar nuevas herramientas al agente sin afectar las existentes.

---

### RNF-020

La evolución futura podrá incorporar nuevas capacidades mediante módulos independientes, sin exigir una jerarquía genérica compartida.

---

# 7.8 Mantenibilidad

### RNF-021

La lógica del negocio deberá permanecer desacoplada de la interfaz de usuario y del proveedor de modelos de IA.

---

### RNF-022

Las herramientas utilizadas por el agente deberán representar capacidades del dominio y no depender del canal desde el cual son invocadas.

---

### RNF-023

Toda decisión relevante del dominio deberá implementarse mediante reglas de negocio y no mediante instrucciones específicas del modelo de IA.

---

# Principios de calidad

Todos los componentes del sistema deberán respetar los siguientes principios:

- El agente es reemplazable.
- Los canales son reemplazables.
- El modelo de IA es reemplazable.
- La fuente de verdad financiera son Expense e Income persistidos.
- El dominio constituye el núcleo del sistema.
- La experiencia conversacional nunca deberá comprometer la consistencia de la información.
- El modelo de IA es un detalle de implementación.

# 8. Criterios de aceptación del MVP

## Objetivo

Esta sección define las condiciones que deberán cumplirse para considerar que el MVP de HouseMate AI satisface los objetivos establecidos en este documento.

Los criterios descritos corresponden al comportamiento esperado del producto completo y servirán como referencia durante el desarrollo, las pruebas y la demostración final.

---

# 8.1 Registro de movimientos financieros

## CA-001

El usuario podrá registrar un gasto utilizando lenguaje natural.

---

## CA-002

El usuario podrá registrar un gasto enviando una fotografía de una factura.

---

## CA-003

El agente identificará automáticamente la mayor cantidad posible de información antes de solicitar aclaraciones.

---

## CA-004

Antes de registrar un movimiento financiero, el agente presentará un resumen para confirmación.

---

## CA-005

El usuario podrá registrar ingresos utilizando lenguaje natural.

---

## CA-006

El usuario podrá modificar o eliminar movimientos previamente registrados.

---

# 8.2 Interpretación mediante IA

## CA-007

El agente comprenderá instrucciones redactadas en lenguaje natural sin depender de comandos específicos.

---

## CA-008

Cuando exista incertidumbre, el agente solicitará aclaraciones en lugar de asumir información.

---

## CA-009

Cuando el usuario corrija una propuesta realizada por el agente, dicha corrección deberá reflejarse en el registro final.

---

## CA-010

El agente utilizará el contexto disponible durante la conversación para reducir la cantidad de preguntas necesarias.

---

# 8.3 Dashboard

## CA-011

Después de confirmar un movimiento financiero, el dashboard reflejará automáticamente la información actualizada.

---

## CA-012

El dashboard permitirá visualizar indicadores financieros del hogar.

---

## CA-013

El dashboard permitirá visualizar información por integrante cuando corresponda.

---

## CA-014

Los indicadores presentados deberán coincidir con la información almacenada.

---

# 8.4 Consultas conversacionales

## CA-015

El usuario podrá realizar preguntas financieras utilizando lenguaje natural.

---

## CA-016

Las respuestas del agente deberán coincidir con la información disponible en el sistema.

---

## CA-017

Cuando no exista información suficiente para responder una consulta, el agente deberá comunicar dicha limitación.

---

# 8.5 Reglas de reparto

## CA-018

El sistema permitirá aplicar reglas de reparto reutilizables.

---

## CA-019

El usuario podrá modificar la regla propuesta antes de confirmar un gasto.

---

## CA-020

Los balances reflejarán correctamente el reparto configurado.

---

# 8.6 Consistencia del dominio

## CA-021

Toda modificación de un gasto deberá reflejarse en el balance de compensación y el dashboard. Toda modificación de un ingreso deberá reflejarse en el dashboard sin alterar dicho balance.

---

## CA-022

El dashboard y las respuestas del agente deberán producir resultados consistentes.

---

## CA-023

El balance de compensación siempre deberá corresponder a los gastos compartidos registrados y sus distribuciones.

---

# 8.7 Experiencia del usuario

## CA-024

El usuario podrá registrar un movimiento sin necesidad de completar formularios tradicionales.

---

## CA-025

El agente solicitará únicamente la información indispensable para completar una operación.

---

## CA-026

El mismo flujo funcional deberá operar independientemente del canal utilizado (WhatsApp o aplicación web).

---

# Definition of Done del MVP

El MVP de HouseMate AI se considerará terminado cuando sea posible demostrar, de forma consistente, el siguiente recorrido:

1. El usuario registra un gasto mediante una conversación o una fotografía de una factura.
2. El agente interpreta la información y solicita aclaraciones únicamente cuando sea necesario.
3. El usuario confirma el registro.
4. El movimiento financiero queda almacenado correctamente.
5. El dashboard refleja inmediatamente la actualización.
6. El usuario realiza preguntas sobre sus finanzas utilizando lenguaje natural.
7. El agente responde utilizando la información almacenada en el sistema.
8. Los balances y las reglas de reparto permanecen consistentes después de registrar, editar o eliminar gastos; los resultados financieros permanecen consistentes después de registrar, editar o eliminar ingresos.

Si este recorrido puede ejecutarse satisfactoriamente desde cualquiera de los canales soportados, se considerará que el producto cumple los objetivos funcionales definidos para el MVP.

# 9. Decisiones de diseño

## Objetivo

Esta sección documenta las principales decisiones de diseño adoptadas durante la definición de HouseMate AI.

Cada decisión responde a una necesidad del producto y busca garantizar que la arquitectura futura permanezca alineada con la visión del proyecto.

Estas decisiones deberán considerarse principios guía durante el desarrollo.

---

# DD-001 El agente es el producto

## Decisión

El agente de IA constituye la interfaz principal entre el usuario y el sistema.

## Justificación

El objetivo del proyecto no es construir una aplicación tradicional de control de gastos, sino un asistente financiero inteligente que reduzca la fricción del registro y consulta de información.

WhatsApp utiliza al agente como interfaz conversacional. Web/PWA puede utilizar al agente y consumir directamente casos de uso controlados del mismo backend.

---

# DD-002 El dominio es independiente del modelo de IA

## Decisión

La lógica del negocio nunca dependerá de un proveedor específico de modelos de lenguaje.

## Justificación

El dominio debe permanecer estable aunque el modelo utilizado cambie en el futuro.

La IA interpreta la intención del usuario, pero las reglas del negocio pertenecen exclusivamente al dominio.

Esto permitirá sustituir GPT, Claude, Gemini u otros modelos sin modificar la lógica del sistema.

---

# DD-003 Los canales son intercambiables

## Decisión

Todas las capacidades del sistema deberán funcionar independientemente del canal desde el cual sean invocadas.

## Justificación

Registrar un gasto desde WhatsApp o desde la aplicación debe producir exactamente el mismo resultado.

Los canales reutilizan el mismo backend y dominio. El agente es la interfaz conversacional principal, mientras Web/PWA puede exponer vistas y operaciones explícitas sin duplicar lógica de negocio.

---

# DD-004 El balance nunca se almacena

## Decisión

El balance de compensación siempre será calculado a partir de gastos compartidos, pagadores y distribuciones. Los resultados financieros generales se calcularán a partir de ingresos y gastos.

## Justificación

Expense e Income persistidos constituyen la fuente de verdad financiera del sistema.

Esta decisión elimina inconsistencias y evita mantener información duplicada.

---

# DD-005 Confirmación antes de persistir

## Decisión

Toda operación que modifique información financiera requerirá confirmación explícita del usuario.

## Justificación

El agente puede interpretar incorrectamente información ambigua.

Solicitar confirmación antes de persistir datos reduce errores y aumenta la confianza del usuario.

---

# DD-006 La IA propone, el usuario decide

## Decisión

El agente podrá realizar sugerencias automáticas, pero la decisión final siempre corresponderá al usuario.

## Justificación

La IA debe asistir al usuario, no reemplazarlo.

Esto aplica para categorías, reglas de reparto, productos detectados y cualquier información inferida.

---

# DD-007 El sistema pregunta solo cuando es necesario

## Decisión

El agente utilizará todo el contexto disponible antes de solicitar información adicional.

## Justificación

Reducir la cantidad de preguntas es fundamental para disminuir la fricción y mejorar la experiencia conversacional.

---

# DD-008 Las herramientas representan capacidades del dominio

## Decisión

Las herramientas utilizadas por el agente estarán alineadas con las capacidades del negocio y no con pantallas o endpoints.

## Justificación

Una herramienta debe representar una acción significativa del dominio, como registrar un gasto o consultar un balance.

Esto favorece una arquitectura más mantenible y facilita la incorporación de nuevos canales.

---

# DD-009 El dominio precede a la interfaz

## Decisión

Las reglas del negocio se definirán antes del diseño de pantallas o componentes visuales.

## Justificación

La interfaz puede evolucionar con el tiempo, pero el dominio representa el conocimiento central del producto.

Diseñar primero el dominio reduce el riesgo de que la lógica quede distribuida entre distintas interfaces.

---

# DD-010 El MVP prioriza profundidad sobre amplitud

## Decisión

El MVP implementará un conjunto reducido de funcionalidades, pero cada una deberá ofrecer una experiencia completa y coherente.

## Justificación

El objetivo es demostrar el valor del agente resolviendo un problema real, no construir una plataforma financiera completa.

Funcionalidades como presupuestos, integraciones bancarias o múltiples hogares quedan explícitamente fuera del alcance inicial.

---

# Resumen

Las decisiones descritas anteriormente establecen los principios arquitectónicos y de diseño que guiarán el desarrollo de HouseMate AI.

Cualquier decisión futura deberá respetar estos principios o justificar explícitamente por qué resulta necesario modificarlos.

# 10. Riesgos y estrategias de mitigación

## Objetivo

Esta sección identifica los principales riesgos asociados al desarrollo y operación de HouseMate AI, así como las estrategias definidas para reducir su impacto.

Reconocer estos riesgos desde el inicio permite tomar decisiones de diseño más robustas y establecer expectativas realistas sobre el comportamiento del sistema.

---

# 10.1 Riesgos del producto

## R-001 Baja adopción del hábito de registro

### Descripción

Aunque el sistema reduzca la fricción, los usuarios podrían continuar olvidando registrar parte de sus movimientos financieros.

### Impacto

Alto.

La utilidad del producto depende de la calidad y completitud de la información registrada.

### Mitigación

- Registro mediante conversación natural.
- Integración con WhatsApp.
- Análisis automático de facturas.
- Reducción del número de preguntas necesarias para completar un registro.

---

## R-002 Clasificación incorrecta de movimientos

### Descripción

El agente podría asignar una categoría diferente a la esperada por el usuario.

### Impacto

Medio.

Afecta principalmente la calidad de los indicadores.

### Mitigación

- Proponer siempre una categoría editable.
- Solicitar confirmación antes del registro.
- Permitir modificaciones posteriores.

---

# 10.2 Riesgos relacionados con IA

## R-003 Interpretación incorrecta del lenguaje natural

### Descripción

El agente podría interpretar de forma errónea la intención del usuario.

Ejemplo:

> "Gasté 120 mil, pero mi hermano me devolvió 30."

### Impacto

Alto.

Podría generar registros financieros incorrectos.

### Mitigación

- Confirmación previa al almacenamiento.
- Solicitud de aclaraciones cuando exista ambigüedad.
- Uso del contexto conversacional para mejorar la interpretación.

---

## R-004 Errores en el análisis de facturas

### Descripción

El OCR o el modelo multimodal podrían no identificar correctamente productos, cantidades o valores.

### Impacto

Medio.

### Mitigación

- Mostrar siempre el resultado detectado.
- Permitir correcciones antes de confirmar.
- Registrar únicamente la información validada por el usuario.

---

## R-005 Respuestas no fundamentadas

### Descripción

El modelo de IA podría generar respuestas basadas en inferencias no respaldadas por los datos del sistema.

### Impacto

Muy alto.

La confianza del usuario depende de la exactitud de la información financiera.

### Mitigación

- Todas las consultas deberán resolverse utilizando herramientas del sistema.
- El agente nunca responderá utilizando conocimiento inventado.
- Ante información insuficiente, el agente deberá indicarlo explícitamente.

---

# 10.3 Riesgos técnicos

## R-006 Dependencia de servicios externos

### Descripción

El funcionamiento del sistema depende de proveedores externos como servicios de IA, APIs de WhatsApp u otros componentes de terceros.

### Impacto

Medio.

### Mitigación

- Mantener el dominio desacoplado de los proveedores.
- Diseñar adaptadores para facilitar el reemplazo de servicios.
- Permitir operar mediante la aplicación web cuando un canal externo no esté disponible.

---

## R-007 Incremento en los costos de IA

### Descripción

El costo de procesamiento puede aumentar conforme crece el uso del agente.

### Impacto

Medio.

### Mitigación

- Utilizar el modelo únicamente cuando aporte valor.
- Evitar llamadas innecesarias mediante validaciones locales y reutilización de contexto.
- Diseñar el sistema para poder cambiar de proveedor o modelo según criterios de costo y rendimiento.

---

## R-008 Escalabilidad futura

### Descripción

Nuevas funcionalidades podrían aumentar significativamente la complejidad del dominio.

### Impacto

Medio.

### Mitigación

- Arquitectura modular.
- Separación clara entre dominio, agente e infraestructura.
- Modelo conceptual extensible mediante módulos de dominio independientes.

---

# 10.4 Riesgos operativos

## R-009 Calidad de los datos

### Descripción

Los análisis financieros serán tan precisos como la información registrada.

### Impacto

Alto.

### Mitigación

- Confirmación antes de almacenar.
- Posibilidad de editar movimientos.
- Dashboard actualizado automáticamente para facilitar la detección de inconsistencias.

---

## R-010 Privacidad de la información

### Descripción

El sistema gestionará información financiera sensible del hogar.

### Impacto

Muy alto.

### Mitigación

- Acceso restringido por hogar.
- Autenticación de usuarios.
- Protección de la información en tránsito y en almacenamiento.
- Principio de mínimo privilegio para el acceso a datos.

---

# Riesgos aceptados

Durante el MVP se aceptan los siguientes riesgos de manera consciente:

- La clasificación automática no alcanzará una precisión del 100 %.
- Algunas facturas requerirán correcciones manuales.
- El sistema dependerá de proveedores externos para capacidades de IA y mensajería.
- El tiempo de respuesta podrá variar según la complejidad de la consulta y la disponibilidad de los servicios utilizados.

Estos riesgos se consideran aceptables dentro del alcance del MVP, siempre que existan mecanismos para informar al usuario, solicitar confirmaciones cuando sea necesario y preservar la consistencia de la información financiera.

---

# Principio general

HouseMate AI prioriza la confiabilidad de la información por encima de la automatización.

Cuando exista un conflicto entre rapidez y precisión, el sistema deberá favorecer la precisión y solicitar confirmación al usuario antes de realizar cambios en la información financiera.

# 11. Roadmap del producto

## Objetivo

Esta sección describe la evolución prevista para HouseMate AI más allá del MVP.

El roadmap no representa un compromiso de implementación, sino una visión estratégica del crecimiento del producto.

Cada versión busca aumentar el valor entregado al usuario sin perder el principio fundamental del proyecto: reducir la fricción en la gestión financiera mediante un agente de IA.

---

# Versión 1.0 — Registrar

## Objetivo

Eliminar la fricción existente entre realizar una compra y registrarla correctamente.

## Capacidades

- Registro conversacional de gastos.
- Registro conversacional de ingresos.
- Registro mediante fotografías de facturas.
- Clasificación automática.
- Reglas de reparto.
- Dashboard financiero.
- Consultas mediante lenguaje natural.
- Integración con WhatsApp.
- Aplicación web.
- Arquitectura centrada en un agente.

Al finalizar esta versión el usuario podrá llevar un control financiero completo sin depender de hojas de cálculo ni formularios tradicionales.

---

# Versión 1.1 — Comprender

## Objetivo

Mejorar la capacidad del agente para interpretar información y reducir aún más la intervención del usuario.

## Posibles funcionalidades

- Aprendizaje de categorías frecuentes.
- Aprendizaje de comercios habituales.
- Reutilización automática de reglas de reparto.
- Mejoras en el análisis de facturas.
- Detección automática de compras recurrentes.
- Sugerencias inteligentes basadas en el historial.

El agente comenzará a adaptarse progresivamente a los hábitos del hogar.

---

# Versión 2.0 — Planificar

## Objetivo

Ayudar al usuario a tomar decisiones financieras, no únicamente a registrar información.

## Posibles funcionalidades

- Presupuestos por categoría.
- Metas de ahorro.
- Proyección de flujo de caja.
- Alertas por sobrecostos.
- Comparativos entre períodos.
- Simulación de escenarios financieros.

El producto evolucionará desde un registro inteligente hacia un asistente de planificación financiera.

---

# Versión 3.0 — Integrar

## Objetivo

Reducir aún más la necesidad de registrar información manualmente.

## Posibles funcionalidades

- Integraciones bancarias.
- Sincronización con billeteras digitales.
- Importación automática de movimientos.
- Integración con plataformas de comercio electrónico.
- Conciliación automática entre registros manuales y movimientos bancarios.

El agente dejará de depender exclusivamente de la información ingresada por el usuario.

---

# Versión 4.0 — Anticipar

## Objetivo

Transformar HouseMate AI en un asistente financiero proactivo.

## Posibles funcionalidades

- Recomendaciones personalizadas.
- Predicción de gastos futuros.
- Detección de anomalías.
- Alertas preventivas.
- Recomendaciones de ahorro.
- Explicaciones sobre tendencias financieras.
- Automatización de tareas repetitivas.

El agente evolucionará desde responder preguntas hacia anticipar necesidades.

---

# Principios de evolución

La incorporación de nuevas funcionalidades deberá respetar siempre los siguientes principios:

- El agente continuará siendo el punto central de interacción.
- La experiencia conversacional tendrá prioridad sobre los formularios tradicionales.
- La automatización nunca comprometerá la confiabilidad de la información.
- Las nuevas capacidades deberán reutilizar el modelo conceptual existente siempre que sea posible.
- El dominio permanecerá independiente del proveedor de IA y de los canales de interacción.

---

# Funcionalidades explícitamente fuera del MVP

Las siguientes capacidades forman parte de la visión del producto, pero no serán desarrolladas durante la primera versión:

- Múltiples hogares por usuario.
- Integraciones bancarias.
- Presupuestos.
- Metas de ahorro.
- Recordatorios automáticos.
- Pagos desde la plataforma.
- Sincronización entre cuentas financieras.
- Importación automática de extractos bancarios.
- Predicciones financieras.
- Aprendizaje personalizado del agente.
- Soporte para múltiples monedas.
- Aplicación móvil nativa.

---

# Visión de largo plazo

HouseMate AI aspira a convertirse en el punto central desde el cual las personas gestionan sus finanzas personales y del hogar mediante inteligencia artificial.

El objetivo final no consiste en desarrollar una aplicación con funcionalidades financieras, sino en construir un agente capaz de comprender el contexto económico del usuario, ejecutar tareas utilizando herramientas especializadas, ofrecer recomendaciones fundamentadas y acompañar la toma de decisiones financieras cotidianas.

Cada nueva versión deberá acercar el producto a esa visión, manteniendo como principio fundamental la reducción de la fricción y la confianza en la información generada.
