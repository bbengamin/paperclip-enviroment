#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-${1:-bbengamin/paperclip-enviroment}}"
TAG="${TAG:-${2:-latest}}"

if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin
fi

docker build -t "$IMAGE_NAME:$TAG" .
docker push "$IMAGE_NAME:$TAG"

if git rev-parse --short HEAD >/dev/null 2>&1; then
  GIT_SHA_TAG="sha-$(git rev-parse --short HEAD)"
  if [ "$GIT_SHA_TAG" != "$TAG" ]; then
    docker tag "$IMAGE_NAME:$TAG" "$IMAGE_NAME:$GIT_SHA_TAG"
    docker push "$IMAGE_NAME:$GIT_SHA_TAG"
  fi
fi
