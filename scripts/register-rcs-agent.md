# Alta manual del RCS agent y del numero de fallback (owner: Leo)

El RCS agent y los numeros no los crea CDK: se registran a mano una vez y se referencian por ID en la config (`RCS_AGENT_ID`, `SMS_ORIGINATION_IDENTITY`). Motivo: el alta pasa por aprobaciones de Google y del carrier, y no queremos que un `cdk destroy` lo borre.

Reglas:

- Solo en la cuenta dev de DinoCloud, con el perfil propio (`AWS_PROFILE`). Sin claves en archivos.
- Ningun comando de este archivo se corre sin avisar en el canal del equipo: todos mutan AWS.
- Telefonos de prueba: solo los del equipo, registrados como destinos de prueba. Nunca numeros de pacientes reales.

Referencias:

- Testing agent y testers: https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-testing.html
- Pools y fallback a SMS: https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-sms-fallback.html
- RCS agent en pools: https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-pool-rcs-agents.html
- Rich messaging: https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-rich-messaging.html
- Fallback por mensaje: https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-fallback-per-message.html
- Sample oficial: https://github.com/aws-samples/sample-rcs-agent-setup-and-send-messages

## 0. Requisitos

- AWS CLI v2 con los comandos de RCS: alcanza con que `aws pinpoint-sms-voice-v2 create-rcs-agent help` responda (la 2.33.2 no los trae). Para actualizar: en Linux o CloudShell, instalador oficial (`awscli-exe-linux-x86_64.zip` + `sudo ./aws/install --update`); en macOS, `AWSCLIV2.pkg` o `brew upgrade awscli`.
- `jq` 1.6 o superior (el paso 2 usa `IN`).
- Acceso SSO a la cuenta dev: `aws pinpoint-sms-voice-v2 describe-rcs-agents` tiene que responder (aunque sea vacio).
- La cuenta dev esta en `ACCOUNT_TIER=SANDBOX` (`describe-account-attributes`): solo se envia a destinos verificados.

```bash
export AWS_PROFILE=<perfil-dev>
export AWS_REGION=us-east-1
# Mismas tags que infra/config/dev.ts (las claves distinguen mayusculas)
TAGS=(Key=project,Value=rs-concierge-rcs Key=owner,Value=dinocloud-appdev Key=purpose,Value=aws-cds-hackathon-2026 Key=data,Value=synthetic-only)
```

## 1. Crear el RCS agent y la testing registration

`create-rcs-agent` no lleva datos de marca: la marca va como campos de una registracion `TEST_RCS_LAUNCH_REGISTRATION`, que crea el testing agent (sin aprobacion de operadores, solo entrega a testers registrados).

```bash
# El agente queda en Status=CREATED hasta que se aprueba la registracion
export RCS_AGENT_ID=$(aws pinpoint-sms-voice-v2 create-rcs-agent --deletion-protection-enabled --tags "${TAGS[@]}" \
  --query RcsAgentId --output text)

REGISTRATION_ID=$(aws pinpoint-sms-voice-v2 create-registration --registration-type TEST_RCS_LAUNCH_REGISTRATION \
  --tags "${TAGS[@]}" --query RegistrationId --output text)
aws pinpoint-sms-voice-v2 create-registration-association --registration-id "$REGISTRATION_ID" --resource-id "$RCS_AGENT_ID"

# Imagenes: primero el adjunto, despues el campo apunta a su id
LOGO_ID=$(aws pinpoint-sms-voice-v2 create-registration-attachment --attachment-body fileb://logo.png \
  --query RegistrationAttachmentId --output text)
aws pinpoint-sms-voice-v2 put-registration-field-value --registration-id "$REGISTRATION_ID" \
  --field-path agentDetails.logoImage --registration-attachment-id "$LOGO_ID"
# Idem con agentDetails.bannerImage

# Campos de texto (--text-value) y SELECT (--select-choices), ver tabla abajo
aws pinpoint-sms-voice-v2 put-registration-field-value --registration-id "$REGISTRATION_ID" \
  --field-path agentDetails.brandName --text-value "Aurora Aesthetics Demo"
aws pinpoint-sms-voice-v2 put-registration-field-value --registration-id "$REGISTRATION_ID" \
  --field-path agentDetails.useCase --select-choices TRANSACTIONAL

# Revisar antes de enviar: despues del submit parte de la marca no se puede cambiar
aws pinpoint-sms-voice-v2 describe-registration-field-values --registration-id "$REGISTRATION_ID" --output table
aws pinpoint-sms-voice-v2 submit-registration-version --registration-id "$REGISTRATION_ID"

# Esperar: registracion COMPLETE y TestingAgent.Status=ACTIVE (tardo menos de 5 minutos)
aws pinpoint-sms-voice-v2 describe-registrations --registration-ids "$REGISTRATION_ID" \
  --query 'Registrations[].{Status:RegistrationStatus,Approved:ApprovedVersionNumber}'
aws pinpoint-sms-voice-v2 describe-rcs-agents --rcs-agent-ids "$RCS_AGENT_ID" \
  --query 'RcsAgents[].{Status:Status,Testing:TestingAgent.Status}'
```

Campos de la registracion (todos bajo `agentDetails.`; la lista vigente sale de `describe-registration-field-definitions --registration-type TEST_RCS_LAUNCH_REGISTRATION`):

| Campo | Tipo | Valor usado en la POC |
| --- | --- | --- |
| `brandName` | TEXT | Aurora Aesthetics Demo |
| `serviceName` | TEXT | Aurora Appointment Concierge |
| `senderDisplayName` | TEXT | Aurora Concierge (Demo) |
| `agentDescription` | TEXT | Demo concierge for booking and appointment reminders. Synthetic data only, not a real clinic. |
| `useCase` | SELECT: OTP, TRANSACTIONAL, PROMOTIONAL, MULTI_USE | TRANSACTIONAL |
| `averageMonthlyRcsFrequency` | SELECT: 10, 100, 1000+ | 10 |
| `monthlyRcsVolume` | TEXT, `^[1-9][0-9]{0,5}$` | 1000 |
| `billingCategory` | SELECT: CONVERSATIONAL, NON_CONVERSATIONAL | CONVERSATIONAL |
| `accentColor` | TEXT, `^#[0-9A-Fa-f]{6}$`, contraste 4.5:1 contra blanco | #7A3E9D |
| `logoImage` | ATTACHMENT, PNG 224x224 con transparencia, menos de 50 KB | logo sintetico |
| `bannerImage` | ATTACHMENT, PNG/JPEG 1440x448, menos de 200 KB | banner sintetico (texto en la mitad de arriba: el logo tapa abajo al centro) |
| `privacyPolicyUrl` | TEXT | https://dinocloud.com/privacy-policy/ |
| `termsAndConditionsUrl` | TEXT | https://dinocloud.com/privacy-policy/ (se acepto repetida en el testing agent; una `RCS_LAUNCH_REGISTRATION` de produccion necesita una pagina de terminos propia) |
| `contactWebsite` + `contactWebsiteLabel` | TEXT, CONDITIONAL (alcanza con un par web, email o telefono) | https://dinocloud.com + Website |

- Si la registracion se rechaza, `create-registration-version` arranca vacia: hay que cargar todos los campos otra vez.
- Para listar asociaciones de una registracion se usa `list-registration-associations` (no existe `describe-registration-associations`).

## 2. Numero de fallback y protect configuration

El envio directo al RCS agent no tiene fallback automatico a SMS. El codigo (`lambdas/shared/rcs-client.ts`) usa el fallback por mensaje: `FallbackConfiguration` con un numero SMS como origen.

Limitacion del numero de la POC: un numero real de EE. UU. (toll-free o 10DLC) necesita registracion de dias o semanas, asi que se usa un `SIMULATOR` (1 USD/mes segun https://aws.amazon.com/end-user-messaging/pricing/, solo `TRANSACTIONAL`). Un simulador solo envia a los numeros de destino del simulador del mismo pais (https://docs.aws.amazon.com/sms-voice/latest/userguide/test-phone-numbers.html): **el fallback SMS no llega a los telefonos del equipo**. Con este origen el fallback se valida por eventos (paso 5). Si la demo necesita ver el SMS en un telefono, hace falta un toll-free o 10DLC aprobado.

```bash
export SMS_ORIGINATION_IDENTITY=$(aws pinpoint-sms-voice-v2 request-phone-number --iso-country-code US \
  --message-type TRANSACTIONAL --number-capabilities SMS --number-type SIMULATOR \
  --tags "${TAGS[@]}" --query PhoneNumberId --output text)

# Protect configuration: SMS solo a US y AR (se pasa por mensaje, no como default de la cuenta)
PC_ID=$(aws pinpoint-sms-voice-v2 create-protect-configuration --deletion-protection-enabled \
  --tags "${TAGS[@]}" --query ProtectConfigurationId --output text)
aws pinpoint-sms-voice-v2 get-protect-configuration-country-rule-set --protect-configuration-id "$PC_ID" \
  --number-capability SMS --output json \
  | jq '.CountryRuleSet | with_entries(.value = {ProtectStatus: (if (.key | IN("US","AR")) then "ALLOW" else "BLOCK" end)})' \
  > protect-country-rules.json
aws pinpoint-sms-voice-v2 update-protect-configuration-country-rule-set --protect-configuration-id "$PC_ID" \
  --number-capability SMS --country-rule-set-updates file://protect-country-rules.json
```

- `SMS_ORIGINATION_IDENTITY` = `PhoneNumberId` del simulador. Siempre un numero: el fallback por mensaje no acepta pool ni agente (https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-fallback-per-message.html). Si algun dia enviamos al pool, el `PoolId` reemplaza a `RCS_AGENT_ID` como origen de `SendRcsMessage` (y hay que ajustar el IAM), no a esta variable.
- `PROTECT_CONFIGURATION_ID` = `PC_ID`.

### 2b. Pool (opcional, no lo usa el codigo actual)

Preparacion para enviar al pool en lugar de al agente: AWS hace el fallback automatico (RCS primero; si en 25 s no confirma, SMS desde un numero del pool). Con deletion protection, el pool complica la limpieza: crearlo solo si se va a usar.

```bash
RCS_AGENT_ARN=$(aws pinpoint-sms-voice-v2 describe-rcs-agents --rcs-agent-ids "$RCS_AGENT_ID" \
  --query 'RcsAgents[0].RcsAgentArn' --output text)

# ISO ZZ para el agente. Todas las identidades del pool tienen que coincidir en
# message type, deletion protection y opt-out list, si no: ConflictException.
POOL_ID=$(aws pinpoint-sms-voice-v2 create-pool --origination-identity "$RCS_AGENT_ARN" --iso-country-code ZZ \
  --message-type TRANSACTIONAL --deletion-protection-enabled --tags "${TAGS[@]}" --query PoolId --output text)

# El numero tiene que tener la misma deletion protection que el pool
aws pinpoint-sms-voice-v2 update-phone-number --phone-number-id "$SMS_ORIGINATION_IDENTITY" --deletion-protection-enabled
aws pinpoint-sms-voice-v2 associate-origination-identity --pool-id "$POOL_ID" \
  --origination-identity "$SMS_ORIGINATION_IDENTITY" --iso-country-code US

aws pinpoint-sms-voice-v2 list-pool-origination-identities --pool-id "$POOL_ID"
```

## 3. Testers (dispositivos de prueba)

```bash
aws pinpoint-sms-voice-v2 create-verified-destination-number \
  --destination-phone-number +<telefono-del-equipo> \
  --rcs-agent-id "$RCS_AGENT_ID" \
  --query '{Id:VerifiedDestinationNumberId,Status:Status}'

aws pinpoint-sms-voice-v2 describe-verified-destination-numbers \
  --filters Name=rcs-agent-id,Values="$RCS_AGENT_ID" \
  --query 'VerifiedDestinationNumbers[].{Id:VerifiedDestinationNumberId,Status:Status}'
```

- Con `--rcs-agent-id` registra un tester de RCS. Sin ese parametro (con `--origination-identity`) es el flujo de verificacion SMS por OTP: son excluyentes.
- Esperar al menos 120 s despues de que el testing agent quede ACTIVE.
- La invitacion llega de "RBM Tester Management" (hasta 20 minutos; en iPhone cae en Remitentes desconocidos): tocar "Make me a tester".
- El numero va en E.164, solo `+` y digitos. Correr este comando en la terminal propia: el telefono no va al repo, a docs ni a chats.
- Numeros de Argentina: fallan con `COUNTRY_NOT_ENABLED` (CLI y consola), aunque la doc dice que el testing agent acepta testers de cualquier pais. Con un numero de EE. UU. funciona. Hay un caso abierto en AWS Support.
- Antes de un envio real, validar el mensaje con `--dry-run` en `send-rcs-message`: devuelve `MessageId` pero no entrega.

## 4. Conectar el inbound (two-way) al topic de la POC

Despues del primer deploy del `MessagingStack` (con OK del TL), tomar los outputs `RcsEventsTopicArn` y `RcsTwoWayChannelRoleArn`:

```bash
aws pinpoint-sms-voice-v2 update-rcs-agent \
  --rcs-agent-id "$RCS_AGENT_ID" \
  --two-way-enabled \
  --two-way-channel-arn <RcsEventsTopicArn> \
  --two-way-channel-role <RcsTwoWayChannelRoleArn>
```

- VERIFICAR si hace falta habilitar eventos de RCS especificos (`TwoWayRcsEventsEnabled`) para recibir los postbacks de las respuestas sugeridas.

### Conectar el topic SNS (nota A4, 21/10/2026)

- Segun la doc (https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-events.html), los postbacks (`SUGGESTION`) y los typing llegan solo al two-way topic del RCS agent, no al configuration set. Sin este paso el router no ve los botones.
- Los outputs salen de `aws cloudformation describe-stacks --stack-name RsConcierge-dev-Messaging --query "Stacks[0].Outputs"`.
- Plan B (`CHANNEL_MODE=sms`): conectar tambien el numero de fallback, asi las respuestas por SMS llegan al router:

```bash
aws pinpoint-sms-voice-v2 update-phone-number \
  --phone-number-id "$SMS_ORIGINATION_IDENTITY" \
  --two-way-enabled \
  --two-way-channel-arn <RcsEventsTopicArn> \
  --two-way-channel-role <RcsTwoWayChannelRoleArn>
```

- Chequeo: `aws pinpoint-sms-voice-v2 describe-rcs-agents --rcs-agent-ids "$RCS_AGENT_ID"` tiene que mostrar two-way habilitado con el ARN del topic. Despues, mandar un texto desde un telefono del equipo y mirar `aws logs tail /aws/lambda/rs-concierge-dev-inbound-router --follow`.

## 5. Prueba de humo

```bash
aws pinpoint-sms-voice-v2 send-rcs-message \
  --destination-phone-number +<telefono-del-equipo> \
  --origination-identity "$RCS_AGENT_ID" \
  --configuration-set-name rs-concierge-dev-rcs \
  --rcs-message-content '{"Content":{"TextMessage":{"Body":"Hi from Aurora Concierge."}}}' \
  --time-to-live 120 \
  --fallback-configuration "Channel=SMS,MessageBody=Hi from Aurora Concierge (SMS).,OriginationIdentity=$SMS_ORIGINATION_IDENTITY"
```

- El texto de los mensajes no menciona "demo" ni "datos sinteticos": eso ya lo dice el nombre del remitente, "Aurora Concierge (Demo)". Ademas, el testing agent antepone un "System Notice" de Google que avisa que el mensaje es de prueba.

- Validar el envio con `--dry-run` antes del envio real.
- Fallback con el numero `SIMULATOR`: **no llega SMS al telefono** (ver paso 2). Se valida por eventos, segun "Testing without an approved SMS number" (https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-sms-fallback.html#rcs-sms-fallback-testing): con el telefono en modo avion, el evento muestra que el RCS no se pudo entregar y que se intento el fallback a SMS.
- VERIFICAR: enviar al numero de destino de exito del simulador de EE. UU. (publicado en https://docs.aws.amazon.com/sms-voice/latest/userguide/test-phone-numbers.html). No es tester, asi que el RCS deberia fallar y el fallback dar un evento de exito.
- Ver el SMS de fallback en un telefono real requiere un toll-free o 10DLC aprobado: riesgo del plan B.
- Los eventos aparecen en el topic y en la tabla `rs-concierge-dev-message-events`. Copiar un ejemplo real de cada tipo a `docs/contrato-eventos.md` (sin el telefono).
