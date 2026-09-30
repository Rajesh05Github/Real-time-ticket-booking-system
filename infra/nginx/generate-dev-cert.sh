#!/bin/sh
# Phase 20: generates a self-signed TLS cert/key for LOCAL DEVELOPMENT
# ONLY, into a shared volume `nginx` mounts read-only. Idempotent -- skips
# generation if a cert already exists, so `docker compose up` doesn't
# mint a new one (and force every browser to re-trust it) on every
# restart.
#
# A self-signed cert is a deliberate LOCAL DEVELOPMENT SIMPLIFICATION: a
# real certificate authority (Let's Encrypt, or AWS ACM) requires a real,
# publicly-resolvable domain name, which `localhost` is not. Phase 21's
# AWS deployment gets a real ACM-issued certificate terminated at an
# Application Load Balancer instead -- Nginx doing TLS termination here
# is a stand-in for that layer, not a preview of exactly how Phase 21
# does it (an ALB, not Nginx, would likely own TLS termination there).
set -eu

CERT_DIR=/certs
CERT_FILE="$CERT_DIR/dev.crt"
KEY_FILE="$CERT_DIR/dev.key"

if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  echo "Dev TLS cert already exists at $CERT_FILE -- skipping generation."
  exit 0
fi

echo "Generating a self-signed dev TLS cert (825-day validity, CN=localhost)..."
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "Done: $CERT_FILE / $KEY_FILE"
