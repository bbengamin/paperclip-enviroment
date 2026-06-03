#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-${1:-bbengamin/paperclip-enviroment}}"
TAG="${TAG:-${2:-latest}}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
CACHE_DIR="${CACHE_DIR:-.buildx-cache}"
CACHE_DIR_NEW="${CACHE_DIR}.new"

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required" >&2
  exit 1
fi

BUILDER_NAME="${BUILDER_NAME:-paperclip-enviroment-builder}"

if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --use
else
  docker buildx use "$BUILDER_NAME"
fi

docker buildx inspect --bootstrap >/dev/null

mkdir -p "$CACHE_DIR"

BUILD_TAG_ARGS=(--tag "$IMAGE_NAME:$TAG")

if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin
fi

if git rev-parse --short HEAD >/dev/null 2>&1; then
  GIT_SHA_TAG="sha-$(git rev-parse --short HEAD)"
  if [ "$GIT_SHA_TAG" != "$TAG" ]; then
    BUILD_TAG_ARGS+=(--tag "$IMAGE_NAME:$GIT_SHA_TAG")
  fi
fi

rm -rf "$CACHE_DIR_NEW"

docker buildx build \
  --platform "$PLATFORMS" \
  --cache-from "type=local,src=$CACHE_DIR" \
  --cache-to "type=local,dest=$CACHE_DIR_NEW,mode=max" \
  "${BUILD_TAG_ARGS[@]}" \
  --push \
  .

rm -rf "$CACHE_DIR"
mv "$CACHE_DIR_NEW" "$CACHE_DIR"
