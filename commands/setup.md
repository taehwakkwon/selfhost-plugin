---
description: Check whether opencode and the sgl gateway are ready, and optionally toggle the stop-time review gate
argument-hint: '[--base-url <url>] [--api-key-env <name>] [--model <alias>=<id>] [--default-model <alias>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" setup --json $ARGUMENTS
```

If the result says opencode is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install opencode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install opencode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g opencode-ai
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" setup --json $ARGUMENTS
```

If opencode is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If the gateway is unreachable, preserve the guidance about which environment variable needs to be set or which `--base-url` to pass.
