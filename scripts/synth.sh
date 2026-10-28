#!/usr/bin/env bash
# Synth local sin credenciales de AWS: cuenta dummy si no hay CDK_DEFAULT_ACCOUNT.
# No toca AWS. Uso: bash scripts/synth.sh [stack]
set -euo pipefail
cd "$(dirname "$0")/.."

export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-000000000000}"
export CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-us-east-1}"
export CDK_DISABLE_CLI_TELEMETRY=true
export AWS_EC2_METADATA_DISABLED=true

npx cdk synth --quiet "$@"
echo "Synth OK en cdk.out/ (cuenta ${CDK_DEFAULT_ACCOUNT}, region ${CDK_DEFAULT_REGION})"
