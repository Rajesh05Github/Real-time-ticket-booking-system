#!/usr/bin/env sh
# Builds all four FLASHSALE images IN AZURE (az acr build -- no local
# Docker needed) and pushes them to the registry with one tag.
#
#   infra/azure/scripts/build-and-push.sh <acr-name> [tag]
#
# Used for the first bootstrap deploy (docs/azure-deployment.md); after
# that, .github/workflows/azure-deploy.yml builds and deploys on every
# push to main. Run from anywhere -- it cds to the repo root.
set -eu

ACR_NAME="${1:?usage: build-and-push.sh <acr-name> [tag]}"
TAG="${2:-$(git rev-parse --short=12 HEAD)}"

cd "$(dirname "$0")/../../.."

build() {
  app="$1"; dockerfile="$2"; context="$3"; shift 3
  echo ">> building flashsale-$app:$TAG"
  az acr build --registry "$ACR_NAME" --image "flashsale-$app:$TAG" --file "$dockerfile" "$@" "$context"
}

build api     infra/docker/api.Dockerfile    .
build worker  infra/docker/worker.Dockerfile .
# Same-origin deployment: an EMPTY public API URL makes the browser use
# relative /api/... URLs through the gateway (apps/web/src/lib/api/config.ts).
build web     infra/docker/web.Dockerfile    . --build-arg NEXT_PUBLIC_API_URL=
build gateway infra/azure/gateway/Dockerfile infra/azure/gateway

echo ">> pushed tag: $TAG"
