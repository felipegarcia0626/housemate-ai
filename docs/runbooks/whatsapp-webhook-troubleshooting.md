# Runbook: diagnóstico y recuperación del webhook de WhatsApp

Este runbook describe el procedimiento mínimo para diagnosticar y recuperar la
integración textual de WhatsApp de HouseMate AI sin modificar código de negocio
ni exponer secretos.

## 1. Separar las capas

La recepción de un mensaje depende de varias configuraciones independientes:

1. **App de Meta**: callback URL, token de verificación y campo `messages`.
2. **WABA**: la aplicación debe estar suscrita al WhatsApp Business Account.
3. **Número**: el `phone_number_id` debe pertenecer al WABA correcto.
4. **Vercel**: variables de entorno server-side.
5. **HouseMate**: permisos de Supabase y asociación del remitente al household.
6. **Agent/OpenAI**: interpretación del texto después de recibir el evento.

Que el botón de prueba de Meta funcione no demuestra que el WABA real esté
suscrito a la aplicación correcta.

## 2. Identificadores del MVP

No confundir estos identificadores:

| Recurso | Valor del MVP | Uso |
| --- | --- | --- |
| App HouseMate AI | `2997322823942248` | Aplicación de Meta |
| WABA | `2078778822751282` | Cuenta sobre la que se consulta/suscribe `subscribed_apps` |
| Número de prueba | `+1 (555) 659-4928` | Número visible para la prueba manual |
| `phone_number_id` | `1173188975886685` | Remitente para Graph API outbound y metadata del evento |

El `message.from` de un evento es el remitente que escribe al número de
prueba; no es el `phone_number_id` del negocio.

## 3. Verificar Meta antes de tocar el código

En Meta Developers, dentro de la configuración de WhatsApp, comprobar:

- Callback URL: `https://housemate-ai.vercel.app/api/webhooks/whatsapp`.
- Token de verificación igual a `WHATSAPP_VERIFY_TOKEN` de Vercel.
- Campo `messages` en estado suscrito.
- App publicada y número de prueba disponible.

Después comprobar la suscripción del WABA en Graph Explorer. Usar un token
temporal o de sistema con acceso al WABA; nunca pegarlo en el repositorio ni en
el chat.

```text
GET https://graph.facebook.com/v26.0/2078778822751282/subscribed_apps
```

La respuesta debe incluir la aplicación `2997322823942248` (HouseMate AI).
La ruta de suscripción es la misma:

```text
POST https://graph.facebook.com/v26.0/2078778822751282/subscribed_apps
```

El `POST` cambia configuración externa y debe ejecutarse solo después de una
confirmación explícita. Repetir el `GET` después para verificar el resultado.

En el incidente de referencia, el WABA estaba suscrito inicialmente a
`WA DevX Webhook Events 1P App` (`2202427980234937`) y no a HouseMate AI. La
solución fue suscribir también HouseMate AI. No eliminar la aplicación anterior
sin confirmar que ningún otro flujo dependa de ella.

## 4. Variables de Vercel

Comprobar únicamente presencia, nunca imprimir valores:

| Variable | Función |
| --- | --- |
| `WHATSAPP_APP_SECRET` | Validar `X-Hub-Signature-256` |
| `WHATSAPP_VERIFY_TOKEN` | Verificación inicial `GET` del webhook |
| `WHATSAPP_ACCESS_TOKEN` | Enviar respuestas mediante Graph API |
| `WHATSAPP_PHONE_NUMBER_ID` | Número usado para enviar respuestas |
| `SUPABASE_URL` | Cliente server-side de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Persistencia server-side; nunca cliente/logs |
| `HOUSEMATE_MVP_HOUSEHOLD_ID` | Household controlado del MVP |
| `OPENAI_API_KEY` | Interpretación del Agent |

El `WHATSAPP_ACCESS_TOKEN` no controla la entrega entrante por sí solo; se
utiliza para llamadas Graph API, especialmente outbound y administración de
activos. La entrega entrante depende de la configuración de Meta y de la
suscripción del WABA.

## 5. Interpretar los logs del webhook

Los logs permitidos deben ser booleanos, estados, longitudes y códigos; nunca
deben contener secretos, payloads completos, firmas, números telefónicos,
UUIDs completos ni respuestas crudas de proveedores.

Secuencia esperada:

```text
[whatsapp-hmac-diagnostic] hmacMatches=true
[whatsapp-debug] stage=hmac_validated
[whatsapp-debug] stage=json_parsed
[whatsapp-debug] stage=payload_parsed recognized=true
[whatsapp-debug] stage=text_extracted ...
[whatsapp-debug] stage=processing_started
[whatsapp-debug] stage=processing_completed result_status=PROCESSED
[whatsapp-debug] stage=response_sent status=200
```

Diagnóstico por punto de corte:

| Evidencia | Capa probable | Acción |
| --- | --- | --- |
| No hay ningún `POST` en Vercel | Meta/WABA/número/suscripción | Verificar `subscribed_apps`, callback y `messages` |
| `hmacMatches=false` | Secret o firma | Comparar App Secret en Meta/Vercel; no relajar HMAC |
| `json_parse_failed` | Payload/transporte | Revisar entrega de Meta; no registrar body |
| `payload_parsed recognized=false` | Parser/evento | Verificar `object`, `field`, `messages` y `phone_number_id` |
| `CONTEXT_UNAVAILABLE` | Supabase/identidad/configuración | Verificar permisos de lectura y asociación `external_identifier` → usuario → household |
| `processing_failed` | Agent, persistencia o outbound | Usar el código sanitizado del error |
| `response_sent status=200` con respuesta de error al usuario | Agent devolvió `ERROR` o `UNSUPPORTED` y WhatsApp outbound funcionó | Diagnosticar interpretación; no asumir fallo del webhook |

Una respuesta HTTP `200` con el texto “No pude procesar la solicitud en este
momento” significa que el webhook sí procesó el evento y envió una respuesta,
pero el Agent devolvió `ERROR` con código `INTERPRETATION_ERROR`. No se debe
interpretar como un fallo de HMAC ni como una escritura financiera.

## 6. Diagnóstico de `CONTEXT_UNAVAILABLE`

El servicio resuelve el contexto con:

```text
message.from
  → tb_users.external_identifier
  → tb_household_members.user_id
  → HOUSEMATE_MVP_HOUSEHOLD_ID
```

Solo deben ejecutarse consultas `SELECT` para comprobar la asociación. El
`service_role` necesita `SELECT` sobre `tb_users` y `tb_household_members`; la
migración de permisos correspondiente debe estar aplicada en la base remota.

La consulta conceptual es:

```sql
SELECT EXISTS (
  SELECT 1
  FROM public.tb_users AS u
  JOIN public.tb_household_members AS hm ON hm.user_id = u.id
  WHERE u.external_identifier = '<message.from>'
    AND hm.household_id = '<HOUSEMATE_MVP_HOUSEHOLD_ID>'
) AS whatsapp_context_exists;
```

No mostrar nombres, teléfonos completos, credenciales ni UUIDs en logs o
reportes públicos. No crear asociaciones automáticamente durante un
diagnóstico.

## 7. Diagnóstico de `INTERPRETATION_ERROR`

`processAgentMessage()` convierte cualquier error no perteneciente al dominio
que ocurra en `interpretExpenseMessage()` en:

```text
{ type: "ERROR", code: "INTERPRETATION_ERROR" }
```

WhatsApp lo presenta como “No pude procesar la solicitud en este momento”. Con
la instrumentación normal no se distingue si la causa fue:

- `OPENAI_API_KEY` ausente;
- error de red;
- respuesta HTTP no-2xx de OpenAI;
- JSON no parseable;
- ausencia de `output_text`;
- respuesta incompatible con el esquema esperado.

Si se repite, añadir temporalmente instrumentación **solo** en
`infrastructure/openai/openai.adapter.ts` para registrar:

- `apiKeyPresent`;
- etapa (`request`, `response`, `body`, `output`, `schema`);
- status HTTP, si existe;
- un código técnico sanitizado.

Reproducir una sola vez, retirar la instrumentación inmediatamente y verificar
que el working tree vuelva al estado inicial. Nunca registrar claves, tokens,
body, prompts, mensajes completos ni respuestas crudas de OpenAI.

## 8. Regla de seguridad y cierre

- No relajar HMAC.
- No aceptar `householdId`, `actorMemberId` o `conversationKey` desde WhatsApp.
- No ejecutar escrituras financieras durante un diagnóstico.
- No ejecutar `GRANT`, `REVOKE`, `INSERT`, `UPDATE` o `DELETE` sin un alcance
  explícito.
- No modificar migraciones aplicadas; crear una nueva solo si un cambio de
  esquema o permisos está aprobado.
- Tras cada ajuste externo, repetir una prueba única y revisar logs sanitizados.
