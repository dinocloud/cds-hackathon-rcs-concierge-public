# RS Concierge RCS

POC para el hackathon AWS CDS Agentic AI: un concierge de turnos por RCS para un marketplace de tratamientos estéticos. El paciente pregunta por un procedimiento, recibe un carrusel de especialistas verificados, elige un horario con un toque y recibe recordatorios a 48 h y 24 h con confirmar, reprogramar o cancelar. Si el teléfono no soporta RCS, el mismo recordatorio llega por SMS.

Todos los datos son sintéticos.

```bash
git clone <REPO_URL>
```

## For judges: how to try it

This project has no web front end: patients talk to it over RCS (with SMS fallback).

- **Watch it:** demo video https://youtu.be/mZCtn2_C_3Y (full flow on a real phone).
- **Run it locally, no AWS account needed:**
  ```bash
  npm install
  printf 'rhinoplasty in Miami\n1\n1\n' | python3 agent/app.py --local --chat
  ```
- **Live RCS on your phone:** the RCS agent is in AWS testing mode and only delivers to registered testers. Send us a US mobile number through the Devpost project page (https://devpost.com/software/aurora-concierge-agentic-rcs-booking-with-sms-fallback) and we will register it during the judging window. Then text `Hi` to "Aurora Concierge (Demo)" in Google Messages.
- **Deploy your own copy:** `npm install && npm run synth`, then follow "Deploy (gateado)" below and `scripts/register-rcs-agent.md`.

## Arquitectura

```
Paciente <-> End User Messaging (RCS + fallback SMS) -> SNS -> Lambda inbound-router -> AgentCore Runtime (Strands)
                                ^                                                          |  Memory
                                |                                                          v
                                |                                              AgentCore Gateway (MCP, IAM)
                                |                                                          |
                                |                                                    Lambda tools -> DynamoDB (catalog, appointments)
                                |                                                          |
                                +---- Lambda reminder-sender <- EventBridge Scheduler <----+ (T-48h, T-24h)

Eventos de entrega -> SNS -> inbound-router -> DynamoDB message-events + métricas EMF -> Dashboard CloudWatch (RCS vs SMS)
```

| Stack | Contenido |
| --- | --- |
| `Data` | Tablas `catalog`, `appointments`, `message-events`; Lambdas `tools` y `reminder-sender`; schedule group y rol de Scheduler |
| `Agent` | AgentCore Memory, Gateway con target Lambda (5 tools) y Runtime con el agente de `agent/` |
| `Messaging` | Topic SNS, configuration set con event destination, rol de two-way para el RCS agent, Lambda `inbound-router`, sal en Secrets Manager |
| `Observability` | Dashboard de entregas RCS contra SMS, errores y latencia |

Decisiones y alternativas en `docs/adr/001-arquitectura.md`. Contratos en `docs/contrato-eventos.md`. Casos y guion de demo en `docs/casos.md`.

## Requisitos

- Node.js 20 o superior y npm.
- Python 3.12 o superior (para el agente; el smoke test corre sin dependencias externas salvo pytest).
- Para desplegar (solo con OK): AWS CLI v2 con un perfil SSO de la cuenta dev, y un RCS agent y número SMS dados de alta a mano (`scripts/register-rcs-agent.md`).

## Instalación

```bash
npm install
python3 -m venv agent/.venv && source agent/.venv/bin/activate
pip install -r agent/requirements-dev.txt      # pytest
pip install -r agent/requirements.txt          # solo si vas a correr el modo aws
cp env.example .env                             # completar; .env no se commitea
```

## Synth (sin credenciales)

```bash
npm run synth
```

Usa una cuenta dummy (`000000000000`) y `us-east-1` si no hay `CDK_DEFAULT_ACCOUNT`. Las plantillas quedan en `cdk.out/`.

## Tests

```bash
npm test                          # jest: 4 suites de Lambdas y plantillas + assertions de CDK
python3 -m pytest agent/tests     # agente: flujo local, guardrails, PII (y Strands si esta instalado)
```

## Correr el agente local

```bash
python3 agent/app.py --local "I want rhinoplasty in Miami"
python3 agent/app.py --local "postback:a=select_provider&p=prov_miami_01"
printf 'rhinoplasty in Miami\n1\n1\n' | python3 agent/app.py --local --chat   # caso 1 completo
```

El modo local usa tools en memoria con datos sintéticos (`agent/local_tools.py`); no llama a AWS ni a ningún modelo. Modos, guardrails, Memory y Gateway: ver [agent/README.md](agent/README.md).

## Deploy (gateado)

**No se despliega sin OK explícito del TL.** El script imprime el comando y no hace nada sin `CONFIRM=yes`; nunca corre en CI.

```bash
export AWS_PROFILE=<perfil-dev> CDK_DEFAULT_ACCOUNT=<cuenta-dev> CDK_DEFAULT_REGION=us-east-1
export RCS_AGENT_ID=<id> SMS_ORIGINATION_IDENTITY=<id>
bash scripts/deploy.sh                 # muestra el comando
CONFIRM=yes bash scripts/deploy.sh     # despliega, solo con OK
```

Después del primer deploy: conectar el two-way del RCS agent al topic (paso 4 de `scripts/register-rcs-agent.md`) y cargar el catálogo sintético (`CONFIRM=yes CATALOG_TABLE=... npm run seed`).

## Modo demo

`DEMO_MODE=true` comprime los recordatorios: T-48h a 2 minutos y T-24h a 4 minutos desde la reserva (`DEMO_REMINDER_MINUTES_48H`, `DEMO_REMINDER_MINUTES_24H`).

## Estado

Boilerplate inicial: contratos, plantillas RCS, handlers con dependencias inyectables, IaC sintetizable y tests en verde. Pendientes marcados con `TODO(<owner>)` y supuestos con `VERIFICAR`.
