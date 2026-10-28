# Runbook: deploy a la cuenta dev

Pasos para desplegar los 4 stacks de la POC en la cuenta dev, cargar el catálogo sintético y verificar que todo quedó andando. Cada paso que toca AWS necesita el OK explícito del responsable del deploy. Este runbook no corre en CI.

**Aprobado por:** ______________ **Fecha:** ______________ **Commit de `main`:** ______________

Completar la línea de arriba en el ticket o en el canal antes de correr el paso 3. Queda como registro de quién aprobó y qué se desplegó.

## Convenciones

- `<perfil-dev>` es el perfil SSO de la cuenta dev. El nombre real no se commitea.
- El perfil va **siempre escrito en el comando**: `--profile <perfil-dev>` en `aws` y `cdk`, y `AWS_PROFILE=<perfil-dev>` como prefijo en `deploy.sh` y `npm run seed`, que no aceptan `--profile`. No usar `export AWS_PROFILE` ni `"$AWS_PROFILE"`: con el perfil escrito, cada comando muestra contra qué cuenta va.
- Región: `us-east-1`.
- Nombres: stacks `RsConcierge-dev-{Data,Agent,Messaging,Observability}` y recursos con prefijo `rs-concierge-dev` (`infra/lib/naming.ts`).

## 1. Requisitos

- Node 20 (`.nvmrc`), `npm ci` hecho, AWS CLI v2 y Python 3 con `pip`. `deploy.sh` empaqueta el agente con `scripts/package-agent.sh`, que baja de PyPI los wheels para Python 3.12 en linux/arm64: no hace falta tener 3.12 instalado.
- Sesión SSO activa:

  ```bash
  aws sso login --profile <perfil-dev>
  aws sts get-caller-identity --profile <perfil-dev>
  ```

- Variables de `env.example` en un `.env` local, que no se commitea. Los valores de RCS salen del registro del RCS agent (`scripts/register-rcs-agent.md`).
  - Comentar la línea `AWS_PROFILE=` del `.env`: el perfil va en cada comando (ver Convenciones).
  - Cargar el resto en la shell:

  ```bash
  set -a; source .env; set +a
  ```

  | Variable | Para qué |
  | --- | --- |
  | `CDK_DEFAULT_ACCOUNT` | Cuenta dev. Sale de `aws sts get-caller-identity --profile <perfil-dev> --query Account --output text` |
  | `CDK_DEFAULT_REGION` | `us-east-1` |
  | `RCS_AGENT_ID`, `SMS_ORIGINATION_IDENTITY`, `PROTECT_CONFIGURATION_ID` | Recursos de End User Messaging (`scripts/register-rcs-agent.md`) |
  | `CHANNEL_MODE` | `rcs` (default) o `sms` |
  | `DEMO_MODE`, `DEMO_REMINDER_MINUTES_48H`, `DEMO_REMINDER_MINUTES_24H` | Recordatorios comprimidos a minutos para la demo |
  | `AGENT_MODEL_ID` | Inference profile de Bedrock |

- VERIFICAR: acceso al modelo de `AGENT_MODEL_ID` habilitado en Bedrock para la cuenta y la región.

  ```bash
  aws bedrock list-inference-profiles --profile <perfil-dev> --region us-east-1 --query "inferenceProfileSummaries[].inferenceProfileId"
  ```

## 2. Bootstrap de CDK (solo si falta)

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit --profile <perfil-dev> --region us-east-1 --query "Stacks[0].StackStatus"
```

Si el comando falla porque el stack no existe:

```bash
npx cdk bootstrap aws://<cuenta-dev>/us-east-1 --profile <perfil-dev>
```

## 3. Deploy, un stack por vez

Orden de `infra/lib/build-stacks.ts`: Data, Agent, Messaging, Observability. Para cada stack:

1. Revisar el diff, sobre todo IAM y recursos que se reemplazan:

   ```bash
   npx cdk diff RsConcierge-dev-Data --profile <perfil-dev>
   ```

2. Desplegar. `deploy.sh` reempaqueta el agente, se niega a correr en CI y sin `CONFIRM=yes`, y pide confirmación si el IAM se amplía (`--require-approval broadening`):

   ```bash
   AWS_PROFILE=<perfil-dev> CONFIRM=yes bash scripts/deploy.sh RsConcierge-dev-Data
   ```

Repetir con `RsConcierge-dev-Agent`, `RsConcierge-dev-Messaging` y `RsConcierge-dev-Observability`. CDK también despliega las dependencias de un stack: hacerlo en orden deja cada diff chico y fácil de revisar.

Chequeo por stack:

```bash
aws cloudformation describe-stacks --stack-name RsConcierge-dev-Data --profile <perfil-dev> --region us-east-1 --query "Stacks[0].[StackStatus,Outputs]"
```

| Stack | Outputs esperados |
| --- | --- |
| Data | `CatalogTableName`, `AppointmentsTableName`, `MessageEventsTableName` |
| Agent | `AgentRuntimeArn`, `MemoryId`, `GatewayUrl` |
| Messaging | `RcsEventsTopicArn`, `RcsTwoWayChannelRoleArn`, `ConfigurationSetName`, `InboundRouterFunctionName`, `ChannelMode`, `InboundRouterDlqUrl` |
| Observability | `DashboardName` |

## 4. Catálogo sintético

1. Dry-run: imprime la cantidad de items y no escribe nada. Anotar la cantidad.

   ```bash
   npm run seed
   ```

2. Carga real. Reintenta los items que DynamoDB no procesa y falla si quedan pendientes.

   ```bash
   AWS_PROFILE=<perfil-dev> AWS_REGION=us-east-1 CONFIRM=yes CATALOG_TABLE=rs-concierge-dev-catalog npm run seed
   ```

Los slots cubren 7 días desde la carga (`syntheticSlots`). Correr el seed de nuevo el día antes de la demo y después de cualquier `cdk destroy`. Volver a correrlo pisa los mismos items: no duplica, pero vuelve a liberar todos los slots, incluidos los reservados.

## 5. Conectar el RCS agent (Leo)

Con los outputs `RcsEventsTopicArn` y `RcsTwoWayChannelRoleArn` del stack Messaging, seguir la sección "two-way" de `scripts/register-rcs-agent.md`. Sin ese paso el router no recibe ni mensajes ni botones.

## 6. Verificación

1. Tablas activas y catálogo completo. El `Count` tiene que coincidir con el dry-run del paso 4:

   ```bash
   aws dynamodb describe-table --table-name rs-concierge-dev-catalog --profile <perfil-dev> --region us-east-1 --query "Table.TableStatus"
   aws dynamodb describe-table --table-name rs-concierge-dev-appointments --profile <perfil-dev> --region us-east-1 --query "Table.TableStatus"
   aws dynamodb describe-table --table-name rs-concierge-dev-message-events --profile <perfil-dev> --region us-east-1 --query "Table.TableStatus"
   aws dynamodb scan --table-name rs-concierge-dev-catalog --select COUNT --profile <perfil-dev> --region us-east-1
   ```

2. Lambda `tools` contra DynamoDB, con el client context que manda el Gateway. Prueba Lambda, DynamoDB e IAM, no el formato real del Gateway (eso lo cubre el smoke):

   ```bash
   aws lambda invoke --function-name rs-concierge-dev-tools \
     --cli-binary-format raw-in-base64-out \
     --client-context "$(printf '{"custom":{"bedrockAgentCoreToolName":"tools___search_providers"}}' | base64 | tr -d '\n')" \
     --payload '{"procedure":"rhinoplasty","city":"Miami"}' \
     --profile <perfil-dev> --region us-east-1 /tmp/rs-search.json && cat /tmp/rs-search.json
   ```

   Tiene que devolver `"ok":true` con providers.

3. Punta a punta: `scripts/smoke-e2e.sh`, siguiendo `docs/smoke-e2e.md` (llegan con #8). Cubre el Gateway por MCP, el entrante por SNS, la respuesta del router, la DLQ y los schedules T48/T24. Primero `DRY_RUN=yes`; el paso b manda un RCS real al número de prueba.

4. En el teléfono (cierra P3): reservar un turno con `DEMO_MODE=true` y ver llegar los recordatorios T48 y T24 por RCS. Para ver la tarjeta por SMS hace falta un segundo número habilitado (L1.10, en espera): el origen SMS actual es un número SIMULATOR que no entrega a celulares reales.

## 7. Rollback

- Código: `git revert` del merge en `main` y volver a desplegar el stack afectado con el paso 3.
- Infra: destruir en orden inverso. Las tablas tienen `RemovalPolicy.DESTROY` y solo guardan datos sintéticos.

  ```bash
  npx cdk destroy RsConcierge-dev-Observability --profile <perfil-dev>
  npx cdk destroy RsConcierge-dev-Messaging --profile <perfil-dev>
  npx cdk destroy RsConcierge-dev-Agent --profile <perfil-dev>
  npx cdk destroy RsConcierge-dev-Data --profile <perfil-dev>
  ```

  Antes de destruir Messaging, desconectar el two-way del RCS agent (Leo): si no, queda apuntando a un topic que ya no existe. Para volver, repetir desde el paso 3.

## Costo

A volumen de demo son centavos por mes: 3 tablas on-demand, Lambdas que pasan la mayor parte del tiempo sin correr, un grupo de Scheduler, una cola SQS y un dashboard. Lo que crece con el uso son las invocaciones a Bedrock, por turno con modelo, los mensajes RCS/SMS y los logs de CloudWatch, que tienen retención en `infra/lib/node-lambda.ts`. Después de la demo conviene destruir los stacks.
