---
description: Check whether opencode and the selfhost gateway are ready, and optionally toggle the stop-time review gate
argument-hint: '[--base-url <url>] [--api-key-env <name>] [--model <alias>=<id>] [--default-model <alias>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/selfhost-companion.mjs" setup --json $ARGUMENTS
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/selfhost-companion.mjs" setup --json $ARGUMENTS
```

If opencode is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If the gateway is unreachable, preserve the guidance about which environment variable needs to be set or which `--base-url` to pass.
- Preserve the "Gateway models" list and any alias warnings verbatim. That list is the only authoritative answer to "which models can I use?" — do not substitute model names from memory.

Model aliases:
- Setup asks the gateway which models it serves (`GET /models`) and reports them. No model names ship with the plugin, so this list is the source of truth.
- The plugin ships a placeholder base URL. Until `--base-url <url>` is set, setup skips discovery and says so; nothing else will work either.
- Register an alias with `--model <alias>=<model-id>`, using an id from the reported list.
- An alias pointing at a model the gateway does not list is reported, never removed automatically — a gateway can drop a model temporarily.
- Discovery runs only here. Rescue and review resolve aliases locally, so a slow or down gateway never adds latency to a job.
