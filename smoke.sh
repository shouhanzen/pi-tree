#!/usr/bin/env bash
set -euo pipefail

cd "C:/Users/Hanzen Shou/workspace/subagent-lab"

EXT="C:/Users/Hanzen Shou/workspace/.pi/extensions/subagent/index.ts"
PROMPT="C:/Users/Hanzen Shou/workspace/subagent-lab/prompts/smoke-test.md"

pi -e "$EXT" -p "@${PROMPT}"
