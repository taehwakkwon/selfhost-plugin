# sgl plugin — design spec

## Goal

Build a Claude Code plugin, `sgl`, that mirrors the UX of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`, plus a stop-time review gate hook, background job tracking, and resumable threads) but targets a self-hosted OpenAI-compatible inference gateway instead of OpenAI's `codex` CLI.

## Backend

- Gateway: `https://gateway.post-train.win/v1/chat/completions` — vLLM instances behind sgl-router (SGLang Model Gateway). Editable, not hardcoded.
- Auth: `Authorization: Bearer $CLIENT_KEY` (token lives in an env var, name itself configurable).
- Models available behind the gateway:
  - `GLM-5.2-FP8` — default.
  - `deepseek-ai/DeepSeek-V4-Flash` — selectable via `--model dsv4` alias.

## Non-goals

- Do not hand-roll a tool-calling agent loop (file read/write, bash execution, sandboxing, patch application) from scratch. That is high-risk, large-surface work that duplicates existing, already-validated tooling.
- Do not depend on the `codex` CLI/binary or its app-server protocol.

## Execution engine: OpenCode

[OpenCode](https://opencode.ai) (MIT licensed) is the execution engine for all model turns — both file-mutating and read-only:

- `opencode serve` runs a headless HTTP server; `@opencode-ai/sdk` drives it (create/resume sessions, run turns, stream events, abort).
- Registers arbitrary OpenAI-compatible providers (base URL + model list) — used to point OpenCode at the gateway.
- Has a permission system, used to implement two profiles (see below).

**Per-job server, not a shared broker.** Each job (`rescue` or `review`) spawns its own `opencode serve` on an ephemeral port and tears it down when the turn ends or is cancelled. A shared long-lived broker (as codex-plugin-cc's `broker-lifecycle.mjs` implements for the Codex app-server) adds real complexity — port/endpoint discovery, stale-server detection, orphan cleanup, concurrency limits — that isn't justified until per-job spawn proves too slow in practice.

## Architecture: one execution path, not two

An earlier draft of this design split "read-only review → direct one-shot HTTP call" from "file-mutating rescue → OpenCode agent loop," reasoning that review is read-only in codex-plugin-cc and therefore diff-in/text-out. That assumption was checked against the actual `codex.mjs`/`git.mjs` source and found wrong: Codex's review is agentic even though it's sandboxed read-only (it reads surrounding files, callers, history — not just diff hunks), and when a diff exceeds an inline byte/file-count budget, `git.mjs` deliberately omits the diff and instructs the model to inspect it itself via read-only git commands. A one-shot HTTP call cannot do that.

**Decision: unify on OpenCode for everything, including review.** Two permission profiles distinguish the two use cases:

- `rescue` profile: edit + bash auto-allowed within the workspace (no TTY present to answer permission prompts — headless execution requires this to be pre-authorized, not interactive).
- `review` profile: read-only tools only (read file, grep, list) plus safe read-only bash (`git diff`, `git log`, `git show`, etc.); write/edit tools and non-read-only bash denied.

Consequences of unifying:
- Large diffs are handled for free — the model reads what it needs via tool calls instead of everything being force-fit into one prompt.
- One auth path, one model-selection path, one error surface, instead of two.
- `lib/sgl-client.mjs` (a previously-planned one-shot HTTP client) is eliminated entirely.
- Trade-off accepted: small-diff reviews are heavier/slower than a single HTTP round-trip would be. Acceptable because the gateway is self-hosted (no per-token cost pressure), and simplicity is weighted over latency for a first version.
- Reviews now go through the same background-job machinery as rescue (`--wait`/`--background`, status/result/cancel), which also solves timeout/streaming concerns for long-running reviews and the stop-gate hook.

```
Claude Code (/sgl:*)
        │
        ▼
sgl-companion.mjs (job tracking, resume, background exec)
        │
        ▼
lib/opencode.mjs — single execution path for rescue AND review
        │
        ├─ spawns a per-job `opencode serve` on an ephemeral port
        ├─ permission profile: "rescue" (edit+bash auto-allow) or "review" (read-only)
        ├─ registers gateway.post-train.win as a custom OpenAI-compatible provider
        │  (base URL / model list sourced from lib/config.mjs)
        └─ streams progress, runs the turn, tears down the server on completion/cancel
```

## Component breakdown

Forking codex-plugin-cc's `scripts/lib/` as a starting point, verified file-by-file against the actual 1.0.4 source (not assumed):

| File | Disposition | Why |
|---|---|---|
| `args.mjs`, `fs.mjs`, `prompts.mjs`, `workspace.mjs`, `process.mjs` | Fork near-verbatim | Genuinely generic — no Codex-specific logic found. |
| `state.mjs` | Fork, trivial edit | Generic job/config persistence; only the `codex-companion` fallback dir name (state.mjs:10) needs renaming. |
| `git.mjs` | Fork, light edit | Mostly generic (diff collection, target resolution). The "inspect the diff yourself via read-only git commands" guidance text, written for an agentic consumer, is now directly applicable since review is agentic in this design too — needs less rework than originally assumed, not more. |
| `job-control.mjs` | **Redesign** | Imports `getSessionRuntimeStatus` directly from `codex.mjs` (job-control.mjs:3); infers job phase by pattern-matching Codex-specific log lines (`"starting codex"`, `"thread ready"`, `"turn started"`, `"codex error:"`); hardcodes `/codex:status`/`/codex:cancel` in error text. Must be redesigned against `opencode.mjs`'s own log vocabulary and command names. |
| `tracked-jobs.mjs` | **Redesign** | Hardcodes `SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"` and threads a Codex-style `threadId` through job records. Rename to an sgl-specific session env var and use OpenCode's session ID as the resumable-thread equivalent. Also add secret redaction (see Security below). |
| `render.mjs` | **Redesign** | Encodes the Codex thread model directly in output, not just branding — e.g. `formatCodexResumeCommand` emits `codex resume ${threadId}`, status tables have a "Codex Session ID" column, result rendering branches on `storedJob?.result?.codex?.stdout`. Needs an OpenCode-session-shaped equivalent, not a find-and-replace. |
| `codex.mjs`, `app-server.mjs`, `broker-endpoint.mjs`, `broker-lifecycle.mjs` (~1700 lines total) | **Delete, replace** | Entirely Codex app-server (JSON-RPC) specific. Replaced by `lib/opencode.mjs`. |
| `schemas/review-output.schema.json` | Reuse as-is | Model-agnostic JSON schema. |

New files:

- `lib/opencode.mjs` — per-job `opencode serve` lifecycle, session create/resume, turn execution with progress streaming, permission-profile selection, structured-output request + lenient fallback parsing, session abort (for cancel).
- `lib/config.mjs` — single source of truth for gateway base URL, API key env var name, default model alias, and the alias → full-model-id map (`glm` → `GLM-5.2-FP8`, `dsv4` → `deepseek-ai/DeepSeek-V4-Flash`). Read by both `opencode.mjs` (provider registration) and `render.mjs`/status commands — never duplicated. Persisted at a **user-level** path (e.g. `~/.claude/sgl/config.json`), not per-workspace: the gateway is personal infrastructure the user runs regardless of which repo they're in. Written/edited exclusively via `/sgl:setup`.

## Directory layout

```
sgl-plugin/
  .claude-plugin/plugin.json
  commands/{setup,review,adversarial-review,rescue,status,cancel,result}.md
  agents/sgl-rescue.md
  prompts/{adversarial-review,stop-review-gate}.md
  schemas/review-output.schema.json
  hooks/hooks.json
  scripts/
    sgl-companion.mjs
    session-lifecycle-hook.mjs
    stop-review-gate-hook.mjs
    lib/
      args.mjs, fs.mjs, prompts.mjs, workspace.mjs, process.mjs, state.mjs
      git.mjs
      job-control.mjs
      tracked-jobs.mjs
      render.mjs
      opencode.mjs
      config.mjs
```

## Commands

Same subcommand surface as codex-plugin-cc, retargeted:

- `/sgl:setup [--enable-review-gate|--disable-review-gate] [--json]` — see health checks below.
- `/sgl:review [--base <ref>] [--scope <auto|working-tree|branch>]` — runs an OpenCode session in the `review` permission profile against the resolved target.
- `/sgl:adversarial-review [focus text]` — same, requests structured JSON output per `review-output.schema.json`.
- `/sgl:rescue [--background|--wait] [--resume|--fresh] [--model <glm|dsv4>] [prompt]` — runs an OpenCode session in the `rescue` permission profile.
- `/sgl:status [job-id] [--all] [--json] [--wait]`, `/sgl:result [job-id]`, `/sgl:cancel [job-id]` — job control, forked from `job-control.mjs`/`tracked-jobs.mjs`.

`/sgl:cancel` maps to OpenCode SDK's session abort call first; process-tree kill (already generic, reused from `process.mjs`) remains the always-available fallback regardless of whether the SDK abort succeeds.

## `/sgl:setup` health checks

- `opencode` binary/SDK presence and version (pin server + SDK versions together; OpenCode is pre-1.0 and moves fast).
- Gateway reachability: `GET /v1/models` (or equivalent) to confirm both configured model aliases actually resolve on the live gateway.
- Token validity against the configured env var.
- Structured-output capability probe: send one trial `response_format: json_schema` request and record whether the gateway/model honors it; cache the result as a capability flag in config. Never hard-fail on this — see Reliability below.

## Reliability and error handling

- **Structured output is opportunistic, not required.** GLM/DeepSeek models emit thinking tokens; if the serving stack's reasoning parser doesn't exempt the thinking phase from guided decoding, schema-constrained requests can produce empty reasoning or schema violations. Always attempt `response_format: json_schema` for adversarial-review, but always run lenient parse-and-repair on the result, and never let a parse failure hard-fail the stop-review-gate hook — degrade to the raw text render path that `render.mjs` already has for this case (codex-plugin-cc 1.0.4, render.mjs:214–236 shows the precedent).
- **Headless permission prompts must never occur.** Because there is no TTY, any OpenCode permission prompt would hang a background job forever. The `rescue` and `review` profiles must pre-authorize every tool call class each mode is expected to make; if OpenCode requests something outside the pre-authorized set, treat it as a job failure with a clear error rather than a hang.
- **Secrets never reach logs.** `tracked-jobs.mjs` currently writes subprocess stderr verbatim into per-job log files. Add a redaction pass that strips the configured API key value (and any other configured secret) from every line before it's written or displayed.

## Open risks to validate during implementation (not blocking design approval)

- Whether sgl-router forwards `response_format: json_schema` to workers consistently, and whether SGLang/vLLM's supported JSON Schema subsets (recursion, `pattern`, `format`, `additionalProperties`) match what `review-output.schema.json` needs.
- Exact shape of OpenCode's permission-profile config and whether it can express "read-only bash allow-list" precisely enough for the `review` profile, or whether review needs to fall back to "read-only tools only, no bash at all."
- Whether OpenCode exposes a session-level abort cleanly through the SDK, or whether `/sgl:cancel` will rely on process-tree kill as the primary (not just fallback) mechanism in practice.

## Testing / validation plan

- `/sgl:setup` is the first thing to get working end-to-end against the live gateway — it validates connectivity, auth, and the structured-output probe before anything else is built on top.
- Validate the `review` permission profile actually blocks write/edit tools before wiring it into the stop-review-gate hook (a profile that leaks write access defeats the point of a read-only review).
- Exercise `/sgl:rescue --background`, `/sgl:status`, `/sgl:result`, `/sgl:cancel`, and `--resume` against a real (disposable) repo to confirm job lifecycle and OpenCode session resume behave like the codex-plugin-cc equivalents before considering the plugin done.
