---
description: "[--background|--wait] [--resume|--fresh] [--model <glm|dsv4>] [what sgl should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `sgl:sgl-rescue` subagent via the `Agent` tool (`subagent_type: "sgl:sgl-rescue"`), forwarding the raw user request as the prompt.
`sgl:sgl-rescue` is a subagent, not a skill — do not call `Skill(sgl:sgl-rescue)` (no such skill). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be sgl's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `sgl:sgl-rescue` subagent in the background.
- If the request includes `--wait`, run the `sgl:sgl-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting sgl, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current sgl session or start a new one.
- The two choices must be:
  - `Continue current sgl session`
  - `Start a new sgl session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current sgl session (Recommended)` first.
- Otherwise put `Start a new sgl session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" task ...` and return that command's stdout as-is.
- Return the sgl companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/sgl:status`, fetch `/sgl:result`, call `/sgl:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one. If they ask for `glm` or `dsv4`, pass that through with `--model`.
- Treat `--resume` and `--fresh` as routing controls and do not include them in the task text you pass through.
- `--resume` means add `--resume-last`.
- `--fresh` means do not add `--resume-last`.
- If the user is clearly asking to continue prior sgl work in this repository, such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Otherwise forward the task as a fresh `task` run.
- Preserve the user's task text as-is apart from stripping routing flags.
- Return the stdout of the `sgl-companion` command exactly as-is.
- If the Bash call fails or sgl cannot be invoked, return nothing.

Response style:

- Do not add commentary before or after the forwarded `sgl-companion` output.
