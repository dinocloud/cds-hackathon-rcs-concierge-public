#!/usr/bin/env bash
# Smoke e2e GATEADO (A5) contra la cuenta dev, solo despues de un deploy aprobado.
# Nunca corre en CI. Sin CONFIRM=yes ni DRY_RUN=yes no hace nada.
#
#   DRY_RUN=yes bash scripts/smoke-e2e.sh                     # imprime los comandos, sin AWS
#   CONFIRM=yes AWS_PROFILE=<perfil> AWS_REGION=us-east-1 \
#     SMOKE_TEST_NUMBER=<+E.164 del equipo> bash scripts/smoke-e2e.sh
#
# Opcionales: SMOKE_STEPS=a,b,c  SMOKE_GATEWAY=no  SMOKE_CLEANUP=no  SMOKE_TIMEOUT_SECONDS=90
#             SMOKE_TEXT  SMOKE_PROCEDURE  SMOKE_CITY  SMOKE_ENV=dev  SMOKE_PREFIX
# Ver docs/smoke-e2e.md.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${CI:-}" ]]; then
  echo "smoke-e2e.sh no corre en CI." >&2
  exit 1
fi

if [[ "${CONFIRM:-}" != "yes" && "${DRY_RUN:-}" != "yes" ]]; then
  echo "No se ejecuto nada. El smoke llama a AWS y manda un RCS real al numero de prueba." >&2
  echo "  Ver comandos: DRY_RUN=yes bash scripts/smoke-e2e.sh" >&2
  echo "  Correr:       CONFIRM=yes AWS_PROFILE=<perfil> AWS_REGION=<region> SMOKE_TEST_NUMBER=<+E.164> bash scripts/smoke-e2e.sh" >&2
  exit 2
fi

if [[ "${DRY_RUN:-}" != "yes" ]]; then
  command -v aws >/dev/null || { echo "Falta el AWS CLI v2." >&2; exit 1; }
fi

export AWS_PAGER=""
exec npx ts-node scripts/smoke/run.ts
