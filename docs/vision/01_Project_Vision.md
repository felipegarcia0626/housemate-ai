# Project Vision

## Introducción

HouseMate AI nace de un problema cotidiano: aunque existen múltiples herramientas para gestionar las finanzas personales, mantener un registro actualizado de los gastos sigue siendo una tarea tediosa. El esfuerzo necesario para registrar cada compra hace que muchas personas posterguen el proceso o simplemente dejen de hacerlo.

Este proyecto propone un agente de inteligencia artificial que actúa como la interfaz principal entre el usuario y su información financiera. En lugar de obligar al usuario a adaptarse a una aplicación, HouseMate AI se adapta a la forma en que las personas ya interactúan con la tecnología, utilizando conversaciones naturales, automatización y análisis inteligente para reducir al mínimo la fricción del registro de gastos.

---

# Propuesta de valor

HouseMate AI permite registrar gastos desde los canales que el usuario ya utiliza diariamente, utilizando un agente de IA para interpretar la información, automatizar el trabajo operativo y transformar los datos financieros en información útil para la toma de decisiones.

Más que una aplicación para registrar gastos, HouseMate AI busca convertirse en un asistente financiero inteligente para el hogar.

---

# Diferenciación

La mayoría de herramientas existentes obligan al usuario a abrir una aplicación, completar formularios y realizar manualmente tareas como clasificar gastos, dividir montos o calcular balances.

HouseMate AI propone el enfoque contrario.

El usuario simplemente conversa con un agente o comparte una fotografía de una factura. El agente interpreta la información, realiza el trabajo operativo utilizando las herramientas del sistema y únicamente solicita aclaraciones cuando realmente existe incertidumbre.

El objetivo no es ofrecer más funcionalidades que una hoja de cálculo o una aplicación tradicional, sino reducir al mínimo el esfuerzo necesario para mantener un control financiero constante.

---

# Usuario objetivo

HouseMate AI está dirigido a cualquier persona que desee llevar un mejor control de sus finanzas personales sin invertir tiempo registrando manualmente cada gasto.

Aunque el caso de uso inicial está inspirado en parejas que viven juntas y comparten gastos, la solución debe diseñarse desde el inicio para soportar tanto usuarios individuales como múltiples integrantes de un mismo hogar.

La arquitectura nunca deberá asumir un número fijo de usuarios.

En futuras versiones, la plataforma podrá incorporar módulos como presupuestos, metas de ahorro, recordatorios, proyecciones financieras e integraciones con entidades financieras.

El registro de gastos representa únicamente el primer módulo del producto.

---

# Problema que resolvemos

El verdadero problema no es la ausencia de herramientas para registrar gastos.

El problema es la fricción existente entre realizar una compra y registrarla correctamente.

Cada paso adicional —abrir una aplicación, buscar un formulario, escribir montos, clasificar categorías o dividir porcentajes— incrementa la probabilidad de que el usuario posponga el registro o nunca llegue a realizarlo.

Como consecuencia, la información pierde precisión y deja de ser útil para comprender la situación financiera del hogar.

HouseMate AI elimina esa fricción utilizando un agente de IA como interfaz principal entre el usuario y el sistema.

---

# Objetivo del MVP

El objetivo del MVP es demostrar que un agente de IA puede reducir significativamente la fricción del registro de gastos e ingresos, manteniendo la información financiera organizada y accesible mediante conversaciones naturales.

El éxito del MVP no dependerá de la cantidad de funcionalidades implementadas, sino de demostrar que la interacción conversacional puede reemplazar gran parte del trabajo manual que actualmente realiza el usuario.

---

# Recorrido ideal del usuario

1. El usuario realiza una compra.

2. Desde el canal que le resulte más cómodo —principalmente WhatsApp o la aplicación web— informa el gasto utilizando lenguaje natural o enviando una fotografía de la factura.

3. El agente interpreta la información, identifica los productos, determina las categorías correspondientes, aplica automáticamente las reglas de reparto configuradas y solicita aclaraciones únicamente cuando existe incertidumbre.

4. Una vez el usuario confirma el resultado, el agente registra toda la información utilizando sus herramientas especializadas.

5. El dashboard se actualiza automáticamente.

6. El usuario puede consultar balances y resúmenes financieros basados en la información registrada mediante lenguaje natural.

Todo el recorrido debe minimizar el esfuerzo requerido por el usuario.

---

# Alcance del MVP

## Incluye

- Registro conversacional de gastos.
- Registro, consulta, edición y eliminación de ingresos.
- Integración con WhatsApp.
- Aplicación web responsive.
- Dashboard financiero.
- Consulta y aplicación de reglas preconfiguradas para el reparto de gastos.
- Análisis inteligente de facturas mediante imágenes.
- Consultas mediante lenguaje natural.
- Balance automático entre integrantes del hogar.

## No incluye

- Integraciones bancarias.
- Presupuestos.
- Metas de ahorro.
- Pagos.
- Recordatorios automáticos.
- Múltiples hogares.
- Aplicaciones móviles nativas.

---

# Experiencias diferenciadoras

El producto debe generar experiencias que hagan evidente el valor de utilizar un agente de IA.

## Registro conversacional

El usuario registra un gasto sin abrir formularios ni navegar entre pantallas.

La conversación ocurre en un canal que ya utiliza habitualmente.

---

## Comprensión del lenguaje natural

El usuario puede escribir mensajes como:

> "Compré en D1 por 185 mil, de los cuales 35 mil fueron comida para el gato."

El agente comprende el contexto, identifica los conceptos relevantes y realiza únicamente las preguntas estrictamente necesarias.

---

## Análisis inteligente de facturas

El usuario envía una fotografía de una factura.

El agente identifica automáticamente los productos, propone categorías, aplica las reglas de reparto y presenta un registro listo para confirmar.

La IA no se limita a extraer texto; interpreta el contenido de la compra.

---

## Dashboard vivo

Después de confirmar un gasto, el usuario observa inmediatamente el impacto sobre balances, categorías, indicadores y gráficos sin realizar ninguna acción adicional.

---

## Conversación financiera

El usuario puede realizar preguntas como:

- ¿Cuánto debo este mes?
- ¿Cuánto gastamos en restaurantes?
- ¿Quién ha pagado más este año?
- ¿En qué categoría aumentó más nuestro gasto?
- ¿Cuál fue nuestro gasto promedio el último trimestre?

El agente responde utilizando información real almacenada en el sistema.

---

# Emociones que queremos eliminar

La principal barrera que buscamos eliminar es la pereza.

Registrar gastos no suele ser difícil; mantener el hábito sí lo es cuando el proceso requiere demasiados pasos.

HouseMate AI busca que registrar un gasto resulte tan sencillo como enviar un mensaje.

También queremos reducir:

- Frustración provocada por formularios largos.
- Dudas sobre cómo clasificar una compra.
- Errores derivados de registros incompletos.
- Tiempo invertido realizando cálculos manuales.

---

# Visión del producto

HouseMate AI no pretende convertirse únicamente en otra aplicación para registrar gastos.

Su propósito es convertirse en el punto central desde el cual un hogar gestiona su información financiera mediante un agente de inteligencia artificial.

El agente debe comprender la información proporcionada por el usuario, tomar decisiones, utilizar herramientas, solicitar aclaraciones cuando sea necesario y transformar datos dispersos en conocimiento útil para apoyar la toma de decisiones.

El agente es la interfaz conversacional principal. WhatsApp accede al sistema mediante el agente; Web/PWA puede interactuar con el agente y también consumir directamente casos de uso controlados del mismo backend para vistas y operaciones explícitas. Ambos caminos reutilizan los mismos services y reglas de dominio, y el frontend nunca accede directamente a repositories ni PostgreSQL.

El verdadero producto es el agente.

---

# Principio fundamental

Cada decisión tomada durante el desarrollo deberá responder la siguiente pregunta:

> **¿Esta funcionalidad reduce la fricción del usuario y fortalece al agente como centro del producto?**

Si la respuesta es negativa, la funcionalidad no hace parte del MVP y deberá evaluarse para versiones posteriores.

---

# Métricas de éxito

El MVP se considerará exitoso si demuestra que es posible:

- Registrar un gasto en menos de 30 segundos.
- Minimizar la cantidad de preguntas necesarias para completar un registro.
- Clasificar automáticamente los productos detectados y solicitar confirmación únicamente cuando exista incertidumbre.
- Actualizar el balance y el dashboard inmediatamente después de confirmar un gasto.
- Permitir que la mayoría de interacciones ocurran mediante conversaciones naturales.
- Reducir la cantidad de gastos olvidados respecto al proceso manual utilizado anteriormente.

---

# La historia que queremos contar

Al finalizar la demostración queremos que cualquier persona pueda resumir el proyecto de la siguiente manera:

> "HouseMate AI demuestra que un agente de inteligencia artificial puede convertirse en la interfaz principal para gestionar las finanzas del hogar. En lugar de obligar al usuario a registrar manualmente cada gasto, permite hacerlo mediante conversaciones naturales o fotografías de facturas, interpreta automáticamente la información, aplica reglas de reparto, mantiene actualizado el estado financiero del hogar y responde preguntas utilizando lenguaje natural.

> El valor del producto no está únicamente en el dashboard o en la automatización de tareas, sino en haber reducido significativamente la fricción del proceso mediante un agente capaz de comprender, razonar y ejecutar acciones utilizando herramientas especializadas."

---

# Conclusión

Este documento define la visión del producto y constituye la referencia principal para todas las decisiones de producto, arquitectura e implementación durante el desarrollo del proyecto.

Cualquier nueva funcionalidad deberá alinearse con esta visión y contribuir a fortalecer el papel del agente como núcleo del sistema.
