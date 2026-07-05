---
description: Cancel an active background sgl job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" cancel "$ARGUMENTS"`
