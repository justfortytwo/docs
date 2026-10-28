#!/bin/sh
# Start the Ollama server, then ensure the embedding model is present.
# Pulling is idempotent: it is a no-op when the model already exists on the
# persistent volume, so this survives container restarts cheaply.
set -e

MODEL="qwen3-embedding:0.6b"

# Launch the Ollama API server in the background.
/bin/ollama serve &
SERVE_PID=$!

# Wait for the API to accept requests before pulling.
echo "Waiting for Ollama server to come up..."
until ollama list >/dev/null 2>&1; do
  sleep 1
done

echo "Ensuring ${MODEL} is available..."
ollama pull "${MODEL}"

# Hand control back to the long-running server process.
wait "${SERVE_PID}"
