#!/usr/bin/env bash
# Empaqueta el agente con dependencias para AgentCore Runtime (codigo directo,
# Python 3.12, linux/arm64) en agent/build/. No toca AWS (solo baja paquetes de PyPI).
# infra/lib/agent-stack.ts sube agent/build/ si existe; si no, agent/ sin dependencias.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf agent/build && mkdir -p agent/build
python3 -m pip install \
  --target agent/build \
  --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 \
  --only-binary=:all: -r agent/requirements.txt
cp agent/*.py agent/prompt.md agent/requirements.txt agent/build/
echo "Build en agent/build/. El proximo synth/deploy del AgentStack sube esta carpeta."
