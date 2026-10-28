# Smoke e2e contra la cuenta dev

`scripts/smoke-e2e.sh` prueba el sistema desplegado de punta a punta con datos sintéticos: tools, Gateway, entrante por SNS, respuesta del router, `DEMO_MODE` y schedules de recordatorios. Termina con una tabla PASS/FAIL.

**Solo después de un deploy aprobado por Agustín.** El paso b le manda un RCS real al número de prueba.

## Requisitos

- Los 4 stacks desplegados (`RsConcierge-dev-Data`, `-Agent`, `-Messaging`, `-Observability`).
- Catálogo sintético cargado (`npm run seed` con `CONFIRM=yes`, también con OK).
- RCS agent registrado y apuntado al topic (`scripts/register-rcs-agent.md`), con el número de prueba dado de alta como tester.
- AWS CLI v2 con un perfil SSO de la cuenta dev y `npm ci` hecho.

## Cómo correrlo

| Modo | Comando | Qué hace |
| --- | --- | --- |
| Sin gate | `bash scripts/smoke-e2e.sh` | No hace nada, explica cómo correrlo y sale con código 2 |
| Dry-run | `DRY_RUN=yes AWS_PROFILE=<perfil> AWS_REGION=us-east-1 bash scripts/smoke-e2e.sh` | Imprime cada comando `aws` con placeholders; no llama a AWS |
| Real | `CONFIRM=yes AWS_PROFILE=<perfil> AWS_REGION=us-east-1 SMOKE_TEST_NUMBER=<+E.164 del equipo> bash scripts/smoke-e2e.sh` | Corre los pasos e imprime la tabla |

El número de prueba se pasa solo por variable de entorno, nunca en el repo. En pantalla sale enmascarado (últimos 4 dígitos). El script no corre en CI.

Variables opcionales:

| Variable | Default | Uso |
| --- | --- | --- |
| `SMOKE_STEPS` | `a,b,c` | Pasos a correr. Sin `b` no hace falta `SMOKE_TEST_NUMBER` y no se manda nada al teléfono |
| `SMOKE_GATEWAY` | `yes` | `no` saltea el chequeo MCP firmado contra el Gateway |
| `SMOKE_CLEANUP` | `yes` | `no` deja el turno sintético reservado; sus recordatorios van a disparar |
| `SMOKE_TIMEOUT_SECONDS` | `90` | Espera máxima de la respuesta del router (cold start de AgentCore incluido) |
| `SMOKE_TEXT` | `I want rhinoplasty in Miami` | Texto del entrante sintético |
| `SMOKE_PROCEDURE`, `SMOKE_CITY` | `rhinoplasty`, `Miami` | Búsqueda del paso a |
| `SMOKE_ENV`, `SMOKE_PREFIX` | `dev`, `rs-concierge-dev` | Nombres de stacks y recursos (`infra/lib/naming.ts`) |

## Qué prueba

| Paso | Chequeo | Cómo | PASS si |
| --- | --- | --- | --- |
| 0 | Salidas de los 4 stacks | `cloudformation describe-stacks` | Están todas las salidas que usa el smoke |
| a1 a a3 | `search_providers`, `get_availability`, `book_appointment` | `lambda invoke` a `rs-concierge-dev-tools` con el client context del Gateway (`tools___<tool>`) | `ok: true`, hay providers y slots, el turno trae sus recordatorios |
| a4 | Gateway MCP | `initialize`, `notifications/initialized`, `tools/list` y `tools/call` firmados con SigV4 (servicio `bedrock-agentcore`) contra `GatewayUrl`; si `initialize` devuelve `Mcp-Session-Id`, se reenvía en los requests siguientes junto con `MCP-Protocol-Version` | Están las 5 tools y la búsqueda responde sin error |
| b1 | Entrante sintético | `sns publish` al topic `RcsEventsTopicArn` con la forma de la sección 2 de `docs/contrato-eventos.md` | SNS acepta el mensaje |
| b2 | Router | `logs filter-log-events` del log group del inbound-router desde la publicación | Aparece `respuesta enviada`; FAIL ante `fallo al invocar al agente`, `fallo al enviar la respuesta`, timeout o error de runtime |
| b3 | Eventos de entrega | `dynamodb query` a `message-events` por el `messageId` del primer envío | Hay eventos (WARN si todavía no llegaron) |
| b4 | DLQ del router | `sqs get-queue-attributes` de `InboundRouterDlqUrl` | 0 mensajes (WARN si hay; puede ser de una corrida anterior) |
| c1 | `DEMO_MODE` | `lambda get-function-configuration` de tools | `DEMO_MODE=true` |
| c2, c3 | Schedules T48 y T24 | `scheduler get-schedule` en `rs-concierge-dev-reminders` | `at()` en UTC a pocos minutos de la reserva, target `reminder-sender` y el `appointmentId` en el Input |
| z1, z2 | Limpieza | `cancel_appointment` y `get-schedule` otra vez | El turno se cancela y los schedules ya no existen |

Notas:

- El `patientRef` del paso a es un hash sintético por corrida, no sale de ningún teléfono.
- Las salidas `InboundRouterFunctionName` e `InboundRouterDlqUrl` llegan con el PR del router (A4). Sin ellas se usa el nombre determinístico de la función y b4 queda en SKIP.
- El texto por default es una búsqueda: el agente no reserva nada a nombre del número de prueba.
- VERIFICAR: la versión de protocolo MCP que acepta el Gateway y la forma exacta de los eventos de entrega, con la primera corrida real.

## Salida esperada

Una corrida sana termina así (los valores son ilustrativos):

```text
| Paso | Chequeo                        | Estado | Detalle                                    |
| ---- | ------------------------------ | ------ | ------------------------------------------ |
| 0    | salidas de los 4 stacks        | PASS   | 14 salidas                                 |
| a1   | search_providers               | PASS   | 3 providers                                |
| a2   | get_availability               | PASS   | 2 slots libres                             |
| a3   | book_appointment               | PASS   | apt_<id> con 2 recordatorios               |
| a4   | Gateway MCP (SigV4)            | PASS   | 5 tools, tools/call OK                     |
| b1   | sns publish entrante           | PASS   | de ********XXXX, id smoke-<runId>          |
| b2   | router: agente y respuesta     | PASS   | bloques text,provider_carousel, 2 enviados |
| b3   | message-events del envio       | PASS   | RCS/DELIVERED                              |
| b4   | DLQ del router                 | PASS   | 0 mensajes                                 |
| c1   | tools DEMO_MODE                | PASS   | DEMO_MODE=true T48=2m T24=4m               |
| c2   | schedule T48                   | PASS   | at() en minutos, target reminder-sender    |
| c3   | schedule T24                   | PASS   | at() en minutos, target reminder-sender    |
| z1   | cancel_appointment (limpieza)  | PASS   | slot liberado y schedules borrados         |
| z2   | schedule apt_<id>-t48 borrado  | PASS   | ResourceNotFound                           |
| z2   | schedule apt_<id>-t24 borrado  | PASS   | ResourceNotFound                           |

SMOKE PASS
```

Código de salida: 0 si no hay ningún FAIL (WARN y SKIP no fallan), 1 si hay alguno, 2 si falta el gate o una variable. La tabla se puede pegar tal cual en la tarea de ClickUp como evidencia.

## Fallas típicas

| Síntoma | Causa probable |
| --- | --- |
| a1 sin providers | Falta cargar el catálogo sintético |
| a4 `initialize HTTP 403` | El perfil no tiene permiso para invocar el Gateway (VERIFICAR el nombre de la acción IAM) o la región no es la del Gateway |
| b2 timeout sin líneas | El topic no tiene la suscripción del router o el router no está desplegado |
| b2 `fallo al invocar al agente` | Runtime caído o sin permisos; ver el log del Runtime en CloudWatch |
| b2 `fallo al enviar la respuesta` | RCS agent sin registrar, número no dado de alta como tester o IAM de `SendRcsMessage` |
| c1 `DEMO_MODE=false` | Deploy sin `DEMO_MODE=true` (ver `env.example`) |

## Código

- `scripts/smoke-e2e.sh`: gate (`CONFIRM` o `DRY_RUN`, nunca en CI).
- `scripts/smoke/run.ts`: los pasos, con el AWS CLI inyectable.
- `scripts/smoke/lib.ts`: helpers puros (salidas, payloads, clasificación de logs, schedules, SigV4, tabla), con tests en `scripts/smoke/*.test.ts`.

## Glosario

| Término | Significado |
| --- | --- |
| Smoke e2e | Prueba corta de punta a punta sobre el sistema desplegado, para saber si lo básico anda |
| Dry-run | Modo que muestra lo que se haría sin ejecutarlo |
| Gate | Condición explícita (acá `CONFIRM=yes`) sin la cual el script no hace nada |
| Salidas de CloudFormation | Valores que publica cada stack (ARN del topic, URL del Gateway, nombres de tablas) |
| Client context | Datos extra de una invocación de Lambda; el Gateway manda ahí el nombre de la tool |
| Gateway MCP | AgentCore Gateway: expone las tools al agente por el protocolo MCP con autenticación IAM |
| SigV4 | Firma de AWS para autenticar pedidos HTTP con credenciales IAM |
| SNS | Servicio de mensajería pub/sub; el topic recibe entrantes y eventos de entrega |
| DLQ | Cola de mensajes que no se pudieron procesar |
| `DEMO_MODE` | Comprime los recordatorios T-48h y T-24h a minutos para la demo |
| EventBridge Scheduler | Servicio que dispara cada recordatorio en una fecha y hora (`at()`) |
| E.164 | Formato internacional de teléfono: `+`, código de país y número |
