#!/usr/bin/env bash
set -euo pipefail

cd "C:/Users/Hanzen Shou/workspace/subagent-lab"

EXT="C:/Users/Hanzen Shou/workspace/.pi/extensions/subagent/index.ts"

exec pi -e "$EXT" "$@"
