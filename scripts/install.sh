#!/usr/bin/env bash
set -euo pipefail

# Builds Claude Plan Renderer and installs it into /Applications,
# replacing any existing copy. No sudo required.

# Resolve this script's directory so it works from any cwd, then cd to repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

APP_NAME="Claude Plan Renderer.app"
BUILT_APP="${REPO_ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}"
DEST_APP="/Applications/${APP_NAME}"

echo "==> Repo root: ${REPO_ROOT}"
echo "==> Building app (npm run tauri build) — this can take several minutes..."
npm run tauri build

echo "==> Locating built bundle..."
if [ ! -d "${BUILT_APP}" ]; then
  echo "ERROR: built app not found at:" >&2
  echo "  ${BUILT_APP}" >&2
  echo "The build may have failed or the output path changed." >&2
  exit 1
fi
echo "    Found: ${BUILT_APP}"

if [ -d "${DEST_APP}" ]; then
  echo "==> Removing existing ${DEST_APP}"
  rm -rf "${DEST_APP}"
fi

echo "==> Installing into /Applications..."
cp -R "${BUILT_APP}" "${DEST_APP}"

echo "==> Done. Installed app at: ${DEST_APP}"
