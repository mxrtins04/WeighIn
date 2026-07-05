#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="stellar-quickstart"
IMAGE_TAG="latest"
PORT=8000
RPC_URL="http://localhost:${PORT}/rpc"
MAX_RETRIES=60
RETRY_INTERVAL_SECONDS=2

echo "Checking if container '${CONTAINER_NAME}' is already running..."
if [ "$(docker ps -q -f name=^/${CONTAINER_NAME}$)" ]; then
    echo "Container '${CONTAINER_NAME}' is already running. Stopping it..."
    docker stop "${CONTAINER_NAME}"
fi

if [ "$(docker ps -a -q -f name=^/${CONTAINER_NAME}$)" ]; then
    echo "Removing existing container '${CONTAINER_NAME}'..."
    docker rm -f "${CONTAINER_NAME}" || true
fi

echo "Starting stellar/quickstart:${IMAGE_TAG} in local standalone mode..."
docker run --rm -d \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:8000" \
  stellar/quickstart:${IMAGE_TAG} --local

echo "Waiting for Soroban RPC to become healthy at ${RPC_URL}..."
for ((i=1; i<=MAX_RETRIES; i++)); do
    if curl -s -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}' \
        "${RPC_URL}" | grep -q "Standalone Network" &>/dev/null; then
        echo "Stellar Quickstart local network is healthy and ready!"
        exit 0
    fi
    echo "Waiting for RPC (attempt $i/$MAX_RETRIES)..."
    sleep "${RETRY_INTERVAL_SECONDS}"
done

echo "Error: Stellar Quickstart local network failed to start or become healthy within $((MAX_RETRIES * RETRY_INTERVAL_SECONDS)) seconds." >&2
docker logs "${CONTAINER_NAME}" || true
exit 1
