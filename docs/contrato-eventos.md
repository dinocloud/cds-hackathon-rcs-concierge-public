# Contrato de eventos

Contratos entre End User Messaging, SNS, `inbound-router`, el agente y las Lambdas. La fuente de verdad en código es `lambdas/shared/contracts.ts` (espejo en `agent/contracts.py`).

> **VERIFICAR** todo lo marcado con (V) contra la documentación de AWS y contra eventos reales capturados en la cuenta dev:
> https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-rich-messaging.html y
> https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-fallback-per-message.html.
> Cuando tengamos un evento real de cada tipo, pegarlo acá sin el teléfono y ajustar `lambdas/inbound-router/events.ts`.

## 1. Topología

- Un solo topic SNS `rs-concierge-dev-rcs-events` recibe:
  - mensajes entrantes y postbacks (two-way channel del RCS agent, se configura a mano, ver `scripts/register-rcs-agent.md`);
  - eventos de entrega del configuration set `rs-concierge-dev-rcs` (event destination SNS, `MatchingEventTypes: ALL` por ahora).
- `inbound-router` está suscripto al topic y distingue el tipo de evento por los campos presentes.
- DLQ `rs-concierge-dev-inbound-router-dlq` (SQS, SSE-SQS, retención 4 días): recibe lo que SNS no pudo entregar a la Lambda (redrive de la suscripción) y lo que la Lambda no pudo procesar después de 2 reintentos asincrónicos (`onFailure`), incluido un envío fallido a mitad de respuesta (claim `FAILED`, sección 2.1).
  - **Datos sensibles:** cada mensaje de la DLQ guarda el payload SNS completo, o sea el teléfono del paciente (`originationNumber`) y su texto (`messageBody`). Por eso la retención es de 4 días y no de 14. Quien la lea no debe copiar el contenido a tickets, Slack ni logs; para reprocesar, se reinyecta el mensaje y se borra de la cola.
  - La alarma `rs-concierge-dev-inbound-router-dlq-depth` salta con 1 mensaje visible. **No tiene acción a propósito** (POC, sin topic de notificaciones ni email): se revisa en la consola de CloudWatch durante la demo. `TODO(leo)`: conectarla a un topic cuando exista.

## 2. Mensaje entrante (SNS `Message`, JSON)

Llega por el two-way channel del RCS agent (o del número SMS en el plan B). Fuente: https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-inbound.html y https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-events.html.

| Campo | Tipo | Uso | Estado |
| --- | --- | --- | --- |
| `originationNumber` | string | Teléfono del paciente. RCS lo manda sin `+`: se normaliza a E.164 con `normalizePhone` (`lambdas/shared/patient.ts`). Se hashea; nunca se loguea completo | (V) |
| `destinationNumber` | string | RCS agent (`rcs-...`) o número que recibió. Define el canal de entrada | (V) |
| `messageBody` | string | Texto plano del paciente, o un JSON serializado con `type` (tabla abajo) | (V) |
| `messageKeyword` | string | Palabra clave detectada (opt-out: `STOP` y variantes se ignoran) | (V) |
| `inboundMessageId` | string | Id del mensaje entrante. Si falta se usa el `MessageId` de SNS | (V) |
| `previousPublishedMessageId` | string | Mensaje saliente al que responde | (V) |
| `timestamp` | string ISO o epoch ms | Hora de recepción | (V) |

Tipos de `messageBody` JSON (campo `type`):

| `type` | Qué hace el router |
| --- | --- |
| `SUGGESTION` | Postback: saca `postbackData` y `text` del JSON (acciones en la sección 3) |
| `RCS_TYPING` | Se ignora |
| `CONVERSATION_STARTED` | Se ignora |
| Otro valor | Se ignora (se loguea el tipo) |
| Sin `type` | Se trata como texto libre |

Postbacks de telemetría: `view_profile` y `add_calendar` solo generan un log y la métrica `PostbackTelemetry` (dimensión `Action`). No invocan al agente ni mandan respuesta.

Ejemplo (hipotético, datos sintéticos):

```json
{
  "originationNumber": "15555550100",
  "destinationNumber": "<rcs-agent-id>",
  "messageBody": "I want rhinoplasty in Miami",
  "inboundMessageId": "in-0001",
  "timestamp": "2026-10-23T14:00:00Z"
}
```

Postback (el `messageBody` es un JSON serializado):

```json
{
  "originationNumber": "15555550100",
  "destinationNumber": "<rcs-agent-id>",
  "messageBody": "{\"type\":\"SUGGESTION\",\"text\":\"Confirm\",\"postbackData\":\"a=confirm&ap=apt_1a2b3c4d\"}",
  "inboundMessageId": "in-pb-0002"
}
```

### 2.1 Idempotencia del entrante (claim con lease)

SNS entrega al menos una vez. Cada entrante se reclama en `message-events` antes de invocar al agente:

| Atributo | Valor |
| --- | --- |
| `messageId` (pk) | `INBOUND#<HMAC-SHA256(sal, inboundMessageId)>`: el id puede tener la forma `<teléfono>-<timestamp>`, por eso se hashea con la misma sal del teléfono |
| `eventTimestamp` (sk) | `CLAIM` |
| `claimStatus` | `CLAIMED`, `SENDING`, `DONE` o `FAILED` |
| `claimedAt` | epoch ms del claim |
| `expiresAt` | TTL de 14 días |

- Put condicional: `attribute_not_exists(messageId) OR (claimStatus = CLAIMED AND claimedAt < now - lease)`. El lease sale de la variable `INBOUND_CLAIM_LEASE_MS`, que el `MessagingStack` calcula como timeout de la Lambda + 30 s (hoy 90 s + 30 s = 120 s); un test de infra verifica que sea mayor que el timeout.
- `CLAIMED` con lease vigente: otra invocación lo tiene; el router falla a propósito para que Lambda reintente más tarde. Si DynamoDB no devuelve el item existente en la excepción, se trata igual (se reintenta, no se descarta).
- `CLAIMED` con lease vencido: la invocación anterior cortó por timeout sin liberar el claim; el reintento lo toma.
- `SENDING` (el agente respondió y se están mandando los bloques) y `DONE`: duplicado, se descarta. Si la Lambda corta a mitad del envío, el reintento no reprocesa, para no duplicar bloques ya enviados.
- Si falla un envío y **no salió ningún bloque**: el claim se borra (`release`) y el error se propaga; el reintento asincrónico vuelve a invocar al agente.
- Si falla un envío y **ya salió algún bloque**: el claim pasa a `FAILED`, se loguea `error` (bloques enviados y totales, sin teléfono) y se emite la métrica `Failed`. La invocación termina en error y cada reintento que encuentra `FAILED` también falla sin reenviar, así el evento llega al `onFailure` (DLQ) y el paciente no recibe bloques duplicados.
- Si falla el agente, el claim se borra (`release`) y el error se propaga. Si el `release` también falla, se loguea y se propaga el error original; el lease cubre el reintento.
- La llamada a AgentCore tiene un timeout (`AGENT_REQUEST_TIMEOUT_MS`, 75 s: timeout de la Lambda de 90 s menos 15 s de margen) menor que el de la Lambda, así el `release` llega a correr. Los 75 s cubren el peor caso del agente (35 s de turno + 15 s de lectura en curso + 5 a 8 s de cold start); con un timeout menor el router abortaba un turno que igual terminaba en `book_appointment` y el reintento veía el slot tomado por el mismo paciente.

## 3. Postback de respuesta sugerida o botón

Mismo sobre que el texto, con el `PostbackData` que definimos en `rcs-templates`.

| Campo | Tipo | Uso | Estado |
| --- | --- | --- | --- |
| `postbackData` | string | Acción codificada (ver tabla abajo) | (V) nombre y ubicación: puede venir anidado (`postback.data`, `suggestionResponse.postbackData`); el normalizador prueba los tres |
| `messageBody` / `text` | string | Texto visible del botón | (V) |

Según la [doc de suggestions](https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-suggestions.html), el tap llega con `messageBody` igual a un JSON serializado: `{"type":"SUGGESTION","text":"Confirm","postbackData":"a=confirm&ap=apt_1"}`. El único parser del `messageBody` entrante es el del router (`lambdas/inbound-router/events.ts`): `rcs-templates` solo codifica y decodifica `PostbackData` (`encodePostback` / `decodePostback`), no parsea eventos (V: confirmar la forma con un evento real).

Acciones de postback: formato `application/x-www-form-urlencoded` con la acción en `a`, máximo 2048 caracteres (confirmado en la doc; `encodePostback` falla si se pasa en vez de recortar). El único campo de texto libre, `t` de `reply`, viene del LLM y se recorta a 256 caracteres antes de codificar, así que una sugerencia larga no rompe la respuesta. Se mantiene este formato y no `accion:valor` porque el agente ya lo parsea con `parse_qs` y los `slotId` llevan `#` y `:`. Los campos vacíos no se codifican.

| `a` | Parámetros | Origen | Qué hace el agente |
| --- | --- | --- | --- |
| `select_provider` | `p` = providerId | "See availability" / "Ver horarios" en la tarjeta del carrusel | `get_availability` |
| `view_profile` | `p` = providerId | "View profile" (`OpenUrl`, abre el perfil sintético) | No le llega: solo telemetría (ver abajo) |
| `select_slot` | `p`, `s` = slotId | Respuesta sugerida de horario | `book_appointment` |
| `add_calendar` | `ap` = appointmentId | "Add to calendar" (`CreateCalendarEvent`) en la confirmación | No le llega: el teléfono crea el evento, solo telemetría (ver abajo) |
| `confirm` | `ap`, `k?` = `T48` o `T24` | Recordatorio | Confirma (sin tool) |
| `reschedule` | `ap`, `p?` = providerId, `k?` | Confirmación o recordatorio | `get_availability` del mismo provider y luego `reschedule_appointment` (siempre mismo provider) |
| `cancel` | `ap`, `k?` | Confirmación o recordatorio | `cancel_appointment` |
| `reply` | `t` = texto | Sugerencia genérica del bloque `text` | Lo trata como texto |

`k` es nuevo y opcional: indica de qué recordatorio vino el tap. Quien no lo conozca lo puede ignorar.

`p` en `reschedule` es nuevo y opcional (aditivo, compatible hacia atrás): `bookingConfirmation` y `reminderCard` lo mandan con el `providerId` del turno. El recordatorio llega 24 o 48 h después, a una sesión nueva del agente que no tiene el turno en memoria: con `p` el agente pide horarios del mismo provider y reprograma (caso 2, paso 4). Sin `p` y sin el turno en la sesión, el agente pide tocar Reschedule en el último recordatorio; nunca ofrece otro especialista, porque la Lambda tools solo reprograma con el mismo provider. `smsKeywordToPostback(texto, appointmentId, providerId?)` acepta el `providerId` opcional para el mismo caso por SMS.

**Postbacks que no pasan por el modelo.** `select_slot`, `cancel`, `confirm` y `reschedule` con `ap` los resuelve el flujo determinista del agente directamente (menos latencia, y el modelo queda fuera del camino de escritura). `select_provider` y `reply` siguen pasando por el modelo.

**Acciones solo de telemetría.** `view_profile` y `add_calendar` no piden respuesta. El router no las tiene que reenviar al agente: solo registra log y métrica y termina, sin mandar nada al paciente. Para decidirlo usa `isTelemetryOnlyAction(accion)` (exportado por `rcs-templates`, `true` para esas dos). Si se le mandaran al agente, contestaría algo como "Got it. What would you like to do next?" cada vez que el paciente abre un perfil o agenda el turno.

Ejemplos:

```text
a=select_provider&p=prov_miami_01
a=select_slot&p=prov_miami_01&s=prov_miami_01%232026-10-27T14%3A00%3A00.000Z
a=confirm&ap=apt_1a2b3c4d&k=T24
a=reschedule&ap=apt_1a2b3c4d&p=prov_miami_01&k=T24
a=add_calendar&ap=apt_1a2b3c4d
```

### Respuestas por SMS (fallback y `CHANNEL_MODE=sms`)

Por SMS no hay postbacks. Cada plantilla trae una lista numerada ("Reply 1, 2 or 3" / "Responde 1, 2 o 3") y devuelve en `OutboundMessage.smsOptions` las acciones en el mismo orden:

Estado: el menú numerado todavía **no funciona de punta a punta**. `resolveSmsReply` y `smsOptions` son la pieza del plan B (`CHANNEL_MODE=sms`) y del fallback; el router no guarda las opciones ni las resuelve.

**Fuera de alcance de la POC:** en `CHANNEL_MODE=sms` las respuestas interactivas (`C/R/X`, palabras clave y números del menú) no se traducen a postback: llegan al agente como texto libre, así que un "C" al recordatorio no confirma el turno. El plan B por SMS no entra en la demo porque el origen SMS es un número SIMULATOR, que no entrega a teléfonos reales; el guion de la demo no muestra respuestas por SMS. Las funciones de abajo quedan listas para cuando el plan B sea real.

- `resolveSmsReply(texto, smsOptions)` traduce `1`, `2.`, `#3` o `3)` a la acción N del último menú. Es la única forma de resolver números, porque cada menú tiene su propio orden (en la confirmación 1 es reprogramar y 2 cancelar; en el recordatorio 1 es confirmar). El router tiene que guardar las `smsOptions` del último mensaje enviado al paciente.
- `smsKeywordToPostback(texto, appointmentId)` resuelve solo letras y palabras, sin estado: `C/R/X`, `CONFIRM`/`CONFIRMAR`/`YES`/`SI`, `RESCHEDULE`/`REPROGRAMAR`, `CANCEL`/`CANCELAR`. No acepta números. Necesita que el router conozca el `appointmentId` activo.
- Los textos SMS salen en GSM-7 (sin tildes que GSM-7 no tenga, sin comillas tipográficas) y con un tope propio de 459 septetos (3 segmentos), medido con `gsm7Length`: los caracteres extendidos (`[]{}€^~|\`) cuentan 2. Si no entra, se sacan opciones del final del menú: nunca se corta una opción a la mitad.

## 4. Evento de entrega (configuration set)

Fuente: https://docs.aws.amazon.com/sms-voice/latest/userguide/configuration-sets-event-format.html.

| Campo | Tipo | Uso | Estado |
| --- | --- | --- | --- |
| `eventType` | string | Canal (prefijo `RCS`) y estado si no hay `messageStatus`. Los eventos RCS de estado llegan todos como `RCS_DELIVERED` | (V) valores exactos para RCS y para el fallback |
| `messageStatus` | string | Estado real del mensaje. Tiene prioridad sobre `eventType` | (V) |
| `messageId` | string | Id devuelto por `SendRcsMessage` o `SendTextMessage` | (V) |
| `originationPhoneNumber` | string | Id del RCS agent si salió por RCS, E.164 si salió o cayó a SMS. También define el canal | (V) |
| `destinationPhoneNumber` | string | No se guarda | (V) |
| `eventTimestamp` | epoch ms | Se guarda como `occurredAt`. No forma parte de la clave | (V) |
| `isFinal` | boolean | Se guarda | (V) |
| `context` | map | El `Context` que mandamos en el envío (`sessionId`, `blockType`, `channelMode`; el recordatorio agrega `appointmentId`, `reminder`) | (V) si el SMS de fallback lo conserva |

### 4.1 Clasificación (`classifyDeliveryEvent`)

Canal: RCS si `eventType` empieza con `RCS` o si `originationPhoneNumber` es un RCS agent (`rcs-...`); SMS en cualquier otro caso.

Estado: mapa explícito (`DELIVERY_STATUS_MAP` en `lambdas/inbound-router/events.ts`), sin búsqueda por substring (`UNDELIVERED` contiene `DELIVERED`). Orden: override por `eventType`, después `messageStatus`, después `eventType`, y `OTHER` si no está en el mapa.

| Estado | Valores |
| --- | --- |
| FALLBACK | override `eventType=RCS_FALLBACK` (V) nombre real; `messageStatus=FALLBACK` |
| EXPIRED | override `eventType=TTL_EXPIRATION_REVOKED`; `TTL_EXPIRED`, `EXPIRED`, `TEXT_TTL_EXPIRED` |
| READ | `READ`, `RCS_READ` |
| DELIVERED | `DELIVERED`, `SUCCESSFUL`, `RCS_DELIVERED`, `TEXT_DELIVERED`, `TEXT_SUCCESSFUL` |
| SENT | `PENDING`, `QUEUED`, `SENT`, `ACCEPTED`, `TEXT_PENDING`, `TEXT_QUEUED` |
| FAILED | `UNDELIVERABLE`, `UNDELIVERED`, `REJECTED`, `FAILED`, `BLOCKED`, `CARRIER_BLOCKED`, `PROTECT_BLOCKED`, `SPAM`, `INVALID`, `INVALID_MESSAGE`, `INVALID_NUMBER`, `UNREACHABLE`, `CARRIER_UNREACHABLE`, `UNROUTABLE`, `OPTED_OUT`, `UNKNOWN` y sus `TEXT_*` |
| OTHER | Todo lo demás, incluido `TTL_EXPIRATION_REVOKE_FAILED` (V) |

Qué pasa con un fallback (V): se espera ver un evento RCS de TTL vencido o fallo, seguido de eventos SMS del mismo `messageId` o de uno nuevo. Confirmar cuál de los dos con una prueba real; el dashboard asume que el SMS entregado se cuenta como `Channel=SMS, Status=DELIVERED`.

### 4.2 Persistencia en `message-events`

Tabla con pk `messageId` y sk `eventTimestamp` (string). Tipos de item:

| Item | `messageId` (pk) | `eventTimestamp` (sk) | Atributos |
| --- | --- | --- | --- |
| Evento de entrega | `messageId` del envío | `EVENT#<eventType>#<messageStatus o ->` | `occurredAt`, `channel`, `status`, `rawEventType`, `rawMessageStatus`, `isFinal`, `context`, `expiresAt` |
| Claim de entrante | `INBOUND#<hmac>` | `CLAIM` | `claimStatus`, `claimedAt`, `expiresAt` (sección 2.1) |
| Claim de métrica resumen | `messageId` del envío | `METRIC#<RcsDelivered, SmsFallback o Failed>` | `claimedAt`, `expiresAt` |

- La clave del evento sale de `messageId + eventType + messageStatus`, como recomienda AWS. No usa el timestamp: si faltara, una re-entrega de SNS generaría otra clave y no se deduplicaría.
- Put condicional (`attribute_not_exists`): una re-entrega no se guarda ni se mide dos veces.
- No se guarda el teléfono de destino. TTL de 14 días en `expiresAt`.

### 4.3 Canal de respuesta y métricas

`CHANNEL_MODE` (config `messaging.channelMode`, env de la Lambda) elige el canal de respuesta del router:

| Valor | Envío | Permiso IAM |
| --- | --- | --- |
| `rcs` (default si está vacío) | `SendRcsMessage` con fallback a SMS por mensaje | Solo `sms-voice:SendRcsMessage` |
| `sms` (plan B del ADR 001) | `SendTextMessage` con el `fallbackText` de `rcs-templates` | Solo `sms-voice:SendTextMessage` |

- La config de CDK y la Lambda usan la misma validación (`parseChannelMode`): no distingue mayúsculas y cualquier otro valor falla (en el synth y en el arranque de la Lambda).
- El router manda `channelMode` en el `Context` de cada envío para que el evento de entrega sepa en qué modo salió.

Métricas EMF (namespace `RsConcierge`):

| Métrica | Dimensiones | Cuándo |
| --- | --- | --- |
| `DeliveryEvent` | `Channel`, `Status` | Cada evento de entrega nuevo |
| `RcsDelivered` | `Service` | RCS entregado o leído (una vez por mensaje) |
| `SmsFallback` | `Service` | SMS entregado de un mensaje enviado en modo `rcs` (una vez por mensaje). El modo sale de `context.channelMode` o, si falta, del `CHANNEL_MODE` del router |
| `Failed` | `Service` | SMS fallido o vencido (una vez por mensaje). Un RCS fallido en modo `rcs` no cuenta: dispara el fallback |
| `PostbackTelemetry` | `Action` | Postback `view_profile` o `add_calendar` (sección 2) |

## 5. Router hacia agente (payload de `InvokeAgentRuntime`)

- `runtimeSessionId` = `sessionId` = `"rs-sess-" + HMAC-SHA256(sal, teléfono)`: 72 caracteres (AgentCore pide 33 o más).
- `runtimeUserId` = `patientRef` (mismo HMAC, 64 hex). La sal vive en Secrets Manager.

```json
{
  "version": "1",
  "sessionId": "rs-sess-<64 hex>",
  "patientRef": "<64 hex>",
  "channel": "RCS",
  "input": { "type": "postback", "postbackData": "a=select_slot&p=prov_miami_01&s=prov_miami_01%232026-10-27T14%3A00%3A00.000Z" },
  "receivedAt": "2026-10-23T14:00:05Z",
  "locale": "en-US"
}
```

`input` es `{ "type": "text", "text": "..." }` o `{ "type": "postback", "postbackData": "...", "text": "..." }`.

## 6. Agente hacia router (respuesta)

```json
{
  "version": "1",
  "sessionId": "rs-sess-<64 hex>",
  "blocks": [
    { "type": "text", "text": "Here are top verified providers near you:", "suggestions": [] },
    { "type": "provider_carousel", "providers": [ { "providerId": "prov_miami_01", "name": "Dr. Ava Synth" } ] }
  ],
  "clinicalHandoff": false
}
```

Bloques posibles y su builder en `lambdas/shared/rcs-templates`:

| `type` | Contenido | Builder |
| --- | --- | --- |
| `text` | `text`, `suggestions?` | `textMessage` |
| `provider_carousel` | `providers[]`, `intro?` | `providerCarousel` |
| `slot_options` | `providerId`, `providerName`, `slots[]` | `slotOptions` |
| `booking_confirmation` | `appointment`, `provider` | `bookingConfirmation` |

## 7. Scheduler hacia reminder-sender

```json
{ "appointmentId": "apt_1a2b3c4d", "kind": "T48" }
```

- Nombre del schedule: `<appointmentId>-t48` / `-t24` (con sufijo `-r<epoch>-<4 hex aleatorios>` al reprogramar: los schedules nuevos se crean antes de borrar los viejos, y el token evita colisiones de nombre), en el grupo `rs-concierge-dev-reminders`, `ActionAfterCompletion: DELETE`.
- El teléfono sale del item `CONTACT#<patientRef>` de `appointments`, que escribe el router; `reminder-sender` lo lee con `DynamoRepo.getContactPhone` (`lambdas/tools/repo.ts`).

## 8. Tools del Gateway

Definidas en `lambdas/tools/schema.ts` (schema inline del Gateway target). El nombre llega en `context.clientContext.custom.bedrockAgentCoreToolName` como `tools___<tool>` y el evento es un mapa plano con las propiedades del `inputSchema` (verificado contra la doc de AgentCore el 2026-10-23; pendiente contrastar con un evento real tras el primer deploy). Todas devuelven `{ ok: true, ... }` o `{ ok: false, error, code }` con `code` en `NOT_FOUND`, `SLOT_TAKEN`, `FORBIDDEN`, `BAD_REQUEST`, `INTERNAL` (error no manejado: el mensaje es genérico, el detalle queda en CloudWatch con el `requestId`). `BAD_REQUEST` cubre también operar sobre un turno ya cancelado y un `slotId` que no pertenece al provider. `book_appointment` es idempotente por paciente y slot: si el slot ya está tomado por un turno activo del mismo `patientRef`, devuelve `ok: true` con ese turno (por ejemplo, el reintento del router después de un timeout) en lugar de `SLOT_TAKEN`.

Códigos del lado del agente (`agent/tool_client.py`, `agent/strands_backend.py`): la Lambda nunca los devuelve, los arma el agente con la misma forma `{ ok: false, error, code }`.

| Código | Cuándo | ¿La llamada llegó a salir? |
| --- | --- | --- |
| `UPSTREAM` | El Gateway falló, no respondió a tiempo o devolvió algo ilegible. Las lecturas se reintentan una vez; las escrituras no, si la llamada ya salió. | Puede que sí: en una escritura el resultado es incierto. |
| `TIMEOUT` | Se agotó el presupuesto del turno y la tool no se llegó a llamar. | No. |

Si el modelo falla después de una escritura con resultado incierto (`UPSTREAM` o `INTERNAL`), el agente no corre el flujo determinista, porque repetiría la reserva, y responde que no pudo confirmar y que el paciente revise en un momento. Los resultados definitivos (`SLOT_TAKEN`, `NOT_FOUND`, `BAD_REQUEST`, `FORBIDDEN`) y `TIMEOUT` garantizan que no se escribió nada y siguen el camino normal. En cancelar y reprogramar, `BAD_REQUEST` se muestra como "ese turno ya no está activo".
