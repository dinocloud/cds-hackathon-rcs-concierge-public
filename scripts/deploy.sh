#!/usr/bin/env bash
# Deploy GATEADO. Nunca corre en CI y nunca sin CONFIRM=yes explicito.
# Requiere el OK de Agustin (TL) antes de cada deploy a la cuenta dev.
# Uso: CONFIRM=yes AWS_PROFILE=<perfil> CDK_DEFAULT_ACCOUNT=<cuenta> bash scripts/deploy.sh [stacks...]
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${CI:-}" ]]; then
  echo "deploy.sh no corre en CI." >&2
  exit 1
fi

STACKS=("$@")
if [[ ${#STACKS[@]} -eq 0 ]]; then
  STACKS=(--all)
fi

: "${CDK_DEFAULT_ACCOUNT:?Definir CDK_DEFAULT_ACCOUNT (cuenta dev de DinoCloud)}"
: "${CDK_DEFAULT_REGION:=us-east-1}"
: "${RCS_AGENT_ID:?Definir RCS_AGENT_ID (ver scripts/register-rcs-agent.md)}"
: "${SMS_ORIGINATION_IDENTITY:?Definir SMS_ORIGINATION_IDENTITY}"
if [[ "${CDK_DEFAULT_ACCOUNT}" == "000000000000" ]]; then
  echo "La cuenta dummy es solo para synth." >&2
  exit 1
fi
export CDK_DEFAULT_REGION CDK_DISABLE_CLI_TELEMETRY=true

CMD=(npx cdk deploy "${STACKS[@]}" --require-approval broadening)
echo "Comando: ${CMD[*]}"
echo "Cuenta: ${CDK_DEFAULT_ACCOUNT}  Region: ${CDK_DEFAULT_REGION}  Perfil: ${AWS_PROFILE:-<default>}"

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "No se ejecuto nada. Para desplegar: CONFIRM=yes bash scripts/deploy.sh ${*:-}" >&2
  exit 2
fi

# Siempre se reempaqueta el agente: si quedara un agent/build viejo, el AgentStack subiria
# codigo desactualizado (infra/lib/agent-stack.ts usa agent/build cuando existe).
echo "Empaquetando el agente (scripts/package-agent.sh)..."
bash scripts/package-agent.sh

"${CMD[@]}"
