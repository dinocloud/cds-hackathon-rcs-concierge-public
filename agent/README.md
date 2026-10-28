# Agente concierge (AgentCore Runtime + Strands)

Owner: Agustín. Recibe el `AgentInvokeRequest` del `inbound-router` y devuelve un `AgentReply` con bloques tipados (`text`, `provider_carousel`, `slot_options`, `booking_confirmation`), según `docs/contrato-eventos.md` (secciones 5 y 6). Todos los datos son sintéticos.

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `app.py` | Entrypoint del Runtime (`BedrockAgentCoreApp`) y CLI local. Valida el request, aplica guardrails y elige backend |
| `prompt.md` | System prompt: persona de concierge cercano y bien informado, flujo del caso 1, reglas duras no clínicas, formato JSON de salida |
| `strands_backend.py` | Strands + Bedrock: tools que inyectan `patientRef`, Memory con redacción, prompt caching |
| `flow.py` | Flujo determinista: backend del modo local y red de seguridad del modo aws |
| `tool_client.py` | Tools locales en memoria o AgentCore Gateway por MCP con SigV4 |
| `gateway_auth.py` | Firma SigV4 (servicio `bedrock-agentcore`) con las credenciales del rol del Runtime |
| `blocks.py` | Resultado de tool a bloque tipado, límites de RCS y validación del contrato de salida |
| `guardrails.py` | Detección de preguntas clínicas y urgencias, guard de salida, detección de idioma |
| `pii.py` | Redacción de email, teléfono, tarjeta, SSN, fecha de nacimiento, nombre y dirección |
| `local_tools.py` | Tools en memoria que imitan `lambdas/tools` con los mismos datos sintéticos |
| `contracts.py` | Espejo en Python de `lambdas/shared/contracts.ts` |

## Modos

| `AGENT_MODE` | Modelo | Tools | Memory | Credenciales AWS |
| --- | --- | --- | --- | --- |
| `local` (default) | No, flujo determinista | En memoria | No | No |
| `bedrock-local` | Bedrock (`MODEL_ID`) | En memoria | No | Sí, acceso al modelo |
| `aws` (lo setea el Runtime) | Bedrock (`MODEL_ID`) | Gateway (MCP, IAM) | Sí (`MEMORY_ID`) | Rol del Runtime |

En modo `aws`, si Bedrock o Memory fallan, el turno se resuelve con el flujo determinista y las mismas tools del Gateway, para que la demo no se quede muda.

## Correr local

```bash
python3 agent/app.py --local "I want rhinoplasty in Miami"
python3 agent/app.py --local "postback:a=select_provider&p=prov_miami_02"
python3 agent/app.py --local "is it normal to have swelling after botox?"   # derivación clínica

# Caso 1 completo en una sesión (texto, elegir provider 1, elegir slot 1), como por SMS
printf 'rhinoplasty in Miami\n1\n1\n' | python3 agent/app.py --local --chat

# En español
printf 'quiero rinoplastia en Miami\n1\n1\n' | python3 agent/app.py --local --chat
```

Con el modelo real y tools locales (no despliega nada, pero llama a Bedrock con tus credenciales):

```bash
pip install -r agent/requirements.txt
AWS_PROFILE=<perfil-dev> MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 AWS_REGION=us-east-1 \
  python3 agent/app.py --local --bedrock "I want rhinoplasty in Miami"
```

## Tests

```bash
python3 -m pytest agent/tests        # flujo local, guardrails, PII, contrato de salida
```

Con `pip install -r agent/requirements.txt` también corren los tests de `test_strands_backend.py`: Strands real con un modelo guionado (sin Bedrock ni AWS), que verifican tools, inyección de `patientRef`, bloques y prompt caching. Sin Strands instalado esos tests se saltean.

## Guardrails

1. **Entrada:** si el texto del paciente es clínico (síntomas, dosis, riesgos, recuperación, candidatura, en inglés o español), responde la derivación con `clinicalHandoff: true` sin llamar al modelo ni a las tools. Si suena urgente, menciona contactar a la clínica o al 911.
2. **Prompt:** reglas duras en `prompt.md` para lo que la regex no ve; el modelo marca `clinicalHandoff`.
3. **Salida:** si el texto del modelo trae dosis o tiempos de recuperación, se reemplaza por la derivación.
4. **Contrato:** si la respuesta no valida contra el contrato, se rehace con el flujo determinista.

## Memory y PII

- Sesión de Memory = `sessionId` del router (HMAC, nunca el teléfono); actor = `patientRef`.
- El texto del paciente se redacta antes de llegar al modelo, y el session manager redacta otra vez cada mensaje antes de escribirlo en Memory.
- Los logs no llevan texto del paciente: solo sesión truncada, camino (`guardrail`, `model`, `model_failed`, `flow`), tipos de bloque y latencia.
- El modelo no ve `patientRef`: lo agregan los wrappers de `book_appointment`, `reschedule_appointment` y `cancel_appointment`.
- El texto del paciente llega al modelo en una sola línea y con los `[...]` neutralizados (salvo los marcadores de redacción); el postback pasa por una lista blanca de claves (`a`, `p`, `s`, `ap`).
- Si el modelo falla o su respuesta no valida después de reservar, reprogramar o cancelar, la respuesta se arma con los resultados de esas tools (`DeterministicFlow.reply_from_records`); el flujo determinista solo se vuelve a correr si no hubo ninguna escritura.
- Gateway: solo las tools de lectura se reintentan. Una escritura se reintenta solo si falló la conexión antes de mandarla; si la llamada salió, se devuelve `UPSTREAM` sin repetirla.
- Tiempos: tools con `read_timeout` de 10 s, Bedrock con connect 3 s, read 15 s y 2 intentos, el modelo se cancela a los 35 s y el turno completo (con el fallback determinista) a los 65 s: el fallback no arranca una tool que no termine antes de ese tope. El router invoca AgentCore con timeout de 75 s (PR #3). Se ajustan con `TOOL_READ_TIMEOUT_S`, `MODEL_READ_TIMEOUT_S`, `MODEL_MAX_ATTEMPTS`, `TURN_BUDGET_S` y `TURN_DEADLINE_S`.
- Los postbacks `select_slot`, `cancel`, `confirm` y `reschedule` con `ap` van directo al flujo determinista, sin modelo. Reprogramar es siempre con el mismo provider: el postback del recordatorio trae `p` (providerId) para que funcione en una sesión nueva.

## Deploy (gateado, solo con OK)

1. `scripts/deploy.sh` corre siempre `scripts/package-agent.sh`, que deja `agent/build/` con dependencias para linux/arm64; el `AgentStack` sube esa carpeta si existe (si no existe, o si quedó desactualizada respecto de `agent/`, el synth avisa con un warning).
2. El deploy lo corre Agustín con `scripts/deploy.sh` (ver README raíz).

## Pendientes

- `VERIFICAR` en el Runtime real: forma exacta del resultado MCP del Gateway (`tool_client.parse_mcp_result` acepta texto JSON, `structuredContent` y `body` anidado) y que `AWS_REGION` llegue al contenedor (se manda también `AGENT_REGION`).
- `VERIFICAR` el mínimo de tokens del prompt caching de Bedrock para el modelo elegido: por debajo del mínimo el cachePoint no tiene efecto.
- Memoria de largo plazo (`summaryMemoryStrategy` ya creada en el stack): hoy el agente no la lee.
- Reprogramar desde un recordatorio en modo local depende del estado en memoria de la sesión; en modo aws lo resuelve el modelo con el historial de Memory.
