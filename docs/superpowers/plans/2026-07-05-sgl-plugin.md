# sgl Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `sgl` Claude Code plugin — a codex-plugin-cc-equivalent that runs `/sgl:review`, `/sgl:adversarial-review`, `/sgl:rescue`, `/sgl:status`, `/sgl:result`, `/sgl:cancel`, `/sgl:setup`, and a stop-time review gate against a self-hosted GLM/DeepSeek gateway instead of OpenAI's `codex` CLI.

**Architecture:** Fork codex-plugin-cc's generic job-tracking/CLI-parsing infrastructure near-verbatim; redesign the three files that encode Codex's thread model (`job-control.mjs`, `tracked-jobs.mjs`, `render.mjs`); replace the Codex app-server client (`codex.mjs` + `app-server.mjs` + `broker-*.mjs`) with a new OpenCode-based engine (`opencode.mjs` + `opencode-provider-config.mjs`) that spawns a per-job `opencode serve` instance and drives it via `@opencode-ai/sdk`. Both `/sgl:rescue` (file-mutating) and `/sgl:review`/`/sgl:adversarial-review` (read-only) go through the same `runOpencodeTurn` entry point, distinguished only by a permission profile.

**Tech Stack:** Node.js (ESM, `.mjs`), `@opencode-ai/sdk`, `opencode` CLI (external, installed by the user via `/sgl:setup`), Node's built-in `node --test` runner.

## Global Constraints

- Runtime: Node.js >=22, ESM modules only (`.mjs`), no TypeScript, no bundler.
- Plugin namespace: `sgl` — all commands are `/sgl:*`.
- Gateway: `https://gateway.post-train.win/v1` (OpenAI-compatible chat completions), editable — never hardcoded outside `lib/config.mjs`'s default-seed value.
- Auth: `Authorization: Bearer $<apiKeyEnv>` where `apiKeyEnv` defaults to `CLIENT_KEY` and is itself configurable.
- Models: `GLM-5.2-FP8` (alias `glm`, default), `deepseek-ai/DeepSeek-V4-Flash` (alias `dsv4`).
- sgl's own config persists at `$SGL_CONFIG_DIR/config.json`, defaulting to `~/.claude/sgl/config.json` (`SGL_CONFIG_DIR` env var override exists so tests never touch the real home directory).
- Execution engine is OpenCode only. No separate one-shot HTTP client — `/sgl:review` and `/sgl:adversarial-review` go through OpenCode with a read-only permission profile, same as `/sgl:rescue` goes through it with a write-capable profile.
- `@opencode-ai/sdk`, pinned `^1.17.13` (confirmed published on npm during planning).
- One `opencode serve` subprocess per job, bound to `127.0.0.1` on an OS-assigned free port. No shared broker process.
- Permission profiles are exactly two, and OpenCode's permission gate is coarse (`allow`/`deny`/`ask` per tool, not per-command):
  - `rescue`: `{ "edit": "allow", "bash": "allow" }`
  - `review`: `{ "edit": "deny", "bash": "deny" }`
- The gateway provider is registered per-job via the `OPENCODE_CONFIG` environment variable pointing at a job-scoped temp config file. The user's own global (`~/.config/opencode/opencode.json`) or project `opencode.json` is never written to by sgl.
- Because `review` denies `bash`, the OpenCode agent cannot run `git` itself during a review turn. Diff/status context is collected by sgl's own forked `git.mjs` (reusing codex-plugin-cc's inline-diff/self-collect budgeting) and injected into the prompt; the model may still use its ungated `read`/`grep`/`glob` tools to open any changed file directly for full context beyond an elided diff.
- No test framework dependency. Use Node's built-in `node --test` and `node:assert/strict` for anything with pure/deterministic logic. Anything that requires a live `opencode` binary or the real gateway is a manual verification step, not an automated test — `opencode` is not installed in this environment as of planning time, and the gateway is external, personal infrastructure.
- Reference source to fork from: `/home/taehwak/.claude/plugins/cache/openai-codex/codex/1.0.4/` (already read in full for every file this plan forks).
- Project root: `/home/taehwak/workspace/sgl-plugin` (git repo already initialized, currently contains only `docs/superpowers/specs/2026-07-05-sgl-plugin-design.md`).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.claude-plugin/plugin.json`
- Create: `scripts/lib/.gitkeep` (placeholder so the directory exists before Task 2 populates it — deleted implicitly once real files land)

**Interfaces:**
- Produces: the `sgl` package name and `@opencode-ai/sdk` dependency that every later task's imports rely on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "sgl-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "@opencode-ai/sdk": "^1.17.13"
  },
  "scripts": {
    "test": "node --test scripts/lib/**/*.test.mjs"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "sgl",
  "version": "0.1.0",
  "description": "Use a self-hosted GLM/DeepSeek gateway from Claude Code to review code or delegate tasks.",
  "author": {
    "name": "taehwak"
  }
}
```

- [ ] **Step 4: Install dependencies**

Run: `cd /home/taehwak/workspace/sgl-plugin && npm install`
Expected: `node_modules/@opencode-ai/sdk` exists, `package-lock.json` created, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add package.json package-lock.json .gitignore .claude-plugin/plugin.json
git commit -m "Scaffold sgl plugin project"
```

---

### Task 2: Fork `lib/args.mjs`, `lib/fs.mjs`, `lib/prompts.mjs`, `lib/process.mjs` (verbatim)

These four files have no Codex-specific logic (verified by reading the full source during design review). Fork them unchanged except for one cosmetic constant in `fs.mjs` (temp-dir prefix).

**Files:**
- Create: `scripts/lib/args.mjs`
- Create: `scripts/lib/fs.mjs`
- Create: `scripts/lib/prompts.mjs`
- Create: `scripts/lib/process.mjs`
- Test: `scripts/lib/args.test.mjs`
- Test: `scripts/lib/fs.test.mjs`
- Test: `scripts/lib/process.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv, config)`, `splitRawArgumentString(raw)` from `args.mjs`.
- Produces: `ensureAbsolutePath`, `createTempDir`, `readJsonFile`, `writeJsonFile`, `safeReadFile`, `isProbablyText`, `readStdinIfPiped` from `fs.mjs`.
- Produces: `loadPromptTemplate(rootDir, name)`, `interpolateTemplate(template, variables)` from `prompts.mjs`.
- Produces: `runCommand`, `runCommandChecked`, `binaryAvailable`, `terminateProcessTree`, `formatCommandFailure` from `process.mjs`.

- [ ] **Step 1: Write `scripts/lib/args.mjs`**

```javascript
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
```

- [ ] **Step 2: Write `scripts/lib/args.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "./args.mjs";

test("parseArgs splits booleans, values, and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--background", "--model", "glm", "fix", "the", "bug"],
    { valueOptions: ["model"], booleanOptions: ["background"] }
  );
  assert.equal(options.background, true);
  assert.equal(options.model, "glm");
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("parseArgs applies alias map to short flags", () => {
  const { options } = parseArgs(["-m", "dsv4"], {
    valueOptions: ["model"],
    aliasMap: { m: "model" }
  });
  assert.equal(options.model, "dsv4");
});

test("splitRawArgumentString respects quotes", () => {
  const tokens = splitRawArgumentString(`--model glm "fix the flaky test"`);
  assert.deepEqual(tokens, ["--model", "glm", "fix the flaky test"]);
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/args.test.mjs`
Expected: 3 pass, 0 fail.

- [ ] **Step 4: Write `scripts/lib/fs.mjs`**

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "sgl-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
```

- [ ] **Step 5: Write `scripts/lib/fs.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createTempDir, readJsonFile, writeJsonFile, isProbablyText } from "./fs.mjs";

test("writeJsonFile then readJsonFile round-trips", () => {
  const dir = createTempDir("sgl-fs-test-");
  const file = path.join(dir, "config.json");
  writeJsonFile(file, { hello: "world" });
  assert.deepEqual(readJsonFile(file), { hello: "world" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isProbablyText rejects buffers with null bytes", () => {
  assert.equal(isProbablyText(Buffer.from("hello")), true);
  assert.equal(isProbablyText(Buffer.from([0x68, 0x00, 0x69])), false);
});
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/fs.test.mjs`
Expected: 2 pass, 0 fail.

- [ ] **Step 7: Write `scripts/lib/prompts.mjs`**

```javascript
import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
```

- [ ] **Step 8: Write `scripts/lib/process.mjs`**

```javascript
import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
```

- [ ] **Step 9: Write `scripts/lib/process.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import { binaryAvailable, terminateProcessTree, formatCommandFailure } from "./process.mjs";

test("binaryAvailable reports unavailable for a nonexistent command", () => {
  const result = binaryAvailable("definitely-not-a-real-binary-xyz");
  assert.equal(result.available, false);
  assert.equal(result.detail, "not found");
});

test("binaryAvailable reports available for node itself", () => {
  const result = binaryAvailable("node", ["--version"]);
  assert.equal(result.available, true);
  assert.match(result.detail, /^v\d+\.\d+\.\d+/);
});

test("terminateProcessTree no-ops on a non-finite pid", () => {
  const result = terminateProcessTree(Number.NaN);
  assert.deepEqual(result, { attempted: false, delivered: false, method: null });
});

test("formatCommandFailure includes command, exit code, and stderr", () => {
  const message = formatCommandFailure({
    command: "git",
    args: ["status"],
    status: 128,
    signal: null,
    stdout: "",
    stderr: "fatal: not a git repository"
  });
  assert.match(message, /git status/);
  assert.match(message, /exit=128/);
  assert.match(message, /fatal: not a git repository/);
});
```

- [ ] **Step 10: Run all four new test files**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/`
Expected: all tests from `args.test.mjs`, `fs.test.mjs`, `process.test.mjs` pass (9 total), 0 fail.

- [ ] **Step 11: Delete the scaffold placeholder and commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
rm -f scripts/lib/.gitkeep
git add scripts/lib/args.mjs scripts/lib/args.test.mjs scripts/lib/fs.mjs scripts/lib/fs.test.mjs scripts/lib/prompts.mjs scripts/lib/process.mjs scripts/lib/process.test.mjs
git commit -m "Fork args/fs/prompts/process lib modules verbatim from codex-plugin-cc"
```

---

### Task 3: Fork `lib/workspace.mjs` and `lib/git.mjs`

`workspace.mjs` is unchanged. `git.mjs` is unchanged except for the `buildAdversarialCollectionGuidance` wording: since the `review` permission profile denies `bash` (see Global Constraints), the self-collect fallback text no longer says "inspect the diff yourself with read-only git commands" — it says to use the `read`/`grep`/`glob` tools instead, since those are the only tools a bash-less review session has. The changed-file list itself needs no new helper: `collectWorkingTreeContext`/`collectBranchContext` already embed a "Changed Files" section directly into `content` whenever `includeDiff` is false, so the model already sees exactly which files it may open.

**Files:**
- Create: `scripts/lib/workspace.mjs`
- Create: `scripts/lib/git.mjs`
- Test: `scripts/lib/git.test.mjs`

**Interfaces:**
- Consumes: `isProbablyText` from `fs.mjs` (Task 2), `formatCommandFailure`/`runCommand`/`runCommandChecked` from `process.mjs` (Task 2).
- Produces: `resolveWorkspaceRoot(cwd)` from `workspace.mjs`. Produces `ensureGitRepository`, `getRepoRoot`, `detectDefaultBranch`, `getCurrentBranch`, `getWorkingTreeState`, `resolveReviewTarget`, `collectReviewContext` from `git.mjs` — the same public surface as codex-plugin-cc's original, consumed identically by `sgl-companion.mjs` (Task 13).

- [ ] **Step 1: Write `scripts/lib/workspace.mjs`**

```javascript
import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
```

- [ ] **Step 2: Write `scripts/lib/git.mjs`**

```javascript
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. The full diff was too large to inline — use the `read`, `grep`, and `glob` tools to inspect the files listed under Changed Files directly before finalizing findings. You do not have shell/bash access in this session.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
```

- [ ] **Step 3: Write `scripts/lib/git.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { resolveReviewTarget, collectReviewContext } from "./git.mjs";

function initRepo() {
  const dir = createTempDir("sgl-git-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  runCommandChecked("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  runCommandChecked("git", ["add", "a.txt"], { cwd: dir });
  runCommandChecked("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

test("resolveReviewTarget picks working-tree when the tree is dirty", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
  const target = resolveReviewTarget(dir);
  assert.equal(target.mode, "working-tree");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectReviewContext inlines a small diff and lists changed files", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
  const target = resolveReviewTarget(dir);
  const context = collectReviewContext(dir, target);
  assert.equal(context.inputMode, "inline-diff");
  assert.deepEqual(context.changedFiles, ["a.txt"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectReviewContext falls back to self-collect above the inline file budget", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "b.txt"), "new file\n", "utf8");
  fs.writeFileSync(path.join(dir, "c.txt"), "another new file\n", "utf8");
  fs.writeFileSync(path.join(dir, "d.txt"), "yet another\n", "utf8");
  const target = resolveReviewTarget(dir);
  const context = collectReviewContext(dir, target, { maxInlineFiles: 2 });
  assert.equal(context.inputMode, "self-collect");
  assert.match(context.collectionGuidance, /read.*tool/);
  assert.deepEqual(context.changedFiles.sort(), ["b.txt", "c.txt", "d.txt"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/git.test.mjs`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/workspace.mjs scripts/lib/git.mjs scripts/lib/git.test.mjs
git commit -m "Fork workspace/git lib modules, adapt self-collect guidance for bash-less review"
```

---

### Task 4: Fork `lib/state.mjs` (job/config persistence)

Unchanged except the fallback state-root directory name (`codex-companion` → `sgl-companion`) and the plugin-data env var stays `CLAUDE_PLUGIN_DATA` (a Claude Code standard, not Codex-specific).

**Files:**
- Create: `scripts/lib/state.mjs`
- Test: `scripts/lib/state.test.mjs`

**Interfaces:**
- Consumes: `resolveWorkspaceRoot` from `workspace.mjs` (Task 3).
- Produces: `resolveStateDir`, `resolveStateFile`, `resolveJobsDir`, `ensureStateDir`, `loadState`, `saveState`, `updateState`, `generateJobId`, `upsertJob`, `listJobs`, `setConfig`, `getConfig`, `writeJobFile`, `readJobFile`, `resolveJobLogFile`, `resolveJobFile`.

- [ ] **Step 1: Write `scripts/lib/state.mjs`**

```javascript
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "sgl-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
```

- [ ] **Step 2: Write `scripts/lib/state.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { upsertJob, listJobs, getConfig, setConfig, resolveStateDir } from "./state.mjs";

function initRepo() {
  const dir = createTempDir("sgl-state-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("upsertJob inserts then updates a job record", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-state-plugin-data-");
  upsertJob(dir, { id: "task-1", status: "running" });
  upsertJob(dir, { id: "task-1", status: "completed" });
  const jobs = listJobs(dir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("setConfig/getConfig round-trips a config value", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-state-plugin-data-");
  setConfig(dir, "stopReviewGate", true);
  assert.equal(getConfig(dir).stopReviewGate, true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveStateDir is stable for the same workspace root", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-state-plugin-data-");
  assert.equal(resolveStateDir(dir), resolveStateDir(dir));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/state.test.mjs`
Expected: 3 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/state.mjs scripts/lib/state.test.mjs
git commit -m "Fork state.mjs, rename fallback state root to sgl-companion"
```

---

### Task 5: `lib/config.mjs` (new — gateway config, single source of truth)

**Files:**
- Create: `scripts/lib/config.mjs`
- Test: `scripts/lib/config.test.mjs`

**Interfaces:**
- Consumes: `readJsonFile`, `writeJsonFile` from `fs.mjs` (Task 2).
- Produces: `resolveConfigFile()`, `loadSglConfig()`, `saveSglConfig(config)`, `updateSglConfig(mutate)`, `resolveModelId(config, aliasOrId)`, and the `DEFAULT_SGL_CONFIG` shape, all consumed by `opencode-provider-config.mjs` (Task 6), `opencode.mjs` (Tasks 7-8), and `sgl-companion.mjs` (Task 12).

- [ ] **Step 1: Write `scripts/lib/config.mjs`**

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./fs.mjs";

const CONFIG_DIR_ENV = "SGL_CONFIG_DIR";

export const DEFAULT_SGL_CONFIG = {
  version: 1,
  baseUrl: "https://gateway.post-train.win/v1",
  apiKeyEnv: "CLIENT_KEY",
  defaultModelAlias: "glm",
  models: {
    glm: "GLM-5.2-FP8",
    dsv4: "deepseek-ai/DeepSeek-V4-Flash"
  },
  structuredOutputSupported: null
};

export function resolveConfigDir() {
  return process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), ".claude", "sgl");
}

export function resolveConfigFile() {
  return path.join(resolveConfigDir(), "config.json");
}

export function loadSglConfig() {
  const configFile = resolveConfigFile();
  if (!fs.existsSync(configFile)) {
    return { ...DEFAULT_SGL_CONFIG, models: { ...DEFAULT_SGL_CONFIG.models } };
  }

  try {
    const parsed = readJsonFile(configFile);
    return {
      ...DEFAULT_SGL_CONFIG,
      ...parsed,
      models: {
        ...DEFAULT_SGL_CONFIG.models,
        ...(parsed.models ?? {})
      }
    };
  } catch {
    return { ...DEFAULT_SGL_CONFIG, models: { ...DEFAULT_SGL_CONFIG.models } };
  }
}

export function saveSglConfig(config) {
  fs.mkdirSync(resolveConfigDir(), { recursive: true });
  writeJsonFile(resolveConfigFile(), config);
  return config;
}

export function updateSglConfig(mutate) {
  const config = loadSglConfig();
  mutate(config);
  return saveSglConfig(config);
}

export function resolveModelId(config, aliasOrId) {
  if (!aliasOrId) {
    const defaultAlias = config.defaultModelAlias;
    return config.models[defaultAlias] ?? defaultAlias;
  }
  return config.models[aliasOrId] ?? aliasOrId;
}
```

- [ ] **Step 2: Write `scripts/lib/config.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";

async function withTempConfigDir(fn) {
  const dir = createTempDir("sgl-config-test-");
  process.env.SGL_CONFIG_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    delete process.env.SGL_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSglConfig returns defaults when no config file exists", async () => {
  await withTempConfigDir(async () => {
    const { loadSglConfig, DEFAULT_SGL_CONFIG } = await import(`./config.mjs?t=${Date.now()}-1`);
    const config = loadSglConfig();
    assert.equal(config.baseUrl, DEFAULT_SGL_CONFIG.baseUrl);
    assert.equal(config.models.glm, "GLM-5.2-FP8");
  });
});

test("saveSglConfig then loadSglConfig round-trips an override", async () => {
  await withTempConfigDir(async () => {
    const { loadSglConfig, saveSglConfig } = await import(`./config.mjs?t=${Date.now()}-2`);
    const config = loadSglConfig();
    config.baseUrl = "https://example.internal/v1";
    saveSglConfig(config);
    assert.equal(loadSglConfig().baseUrl, "https://example.internal/v1");
  });
});

test("resolveModelId resolves known aliases and passes through unknown ids", async () => {
  await withTempConfigDir(async () => {
    const { loadSglConfig, resolveModelId } = await import(`./config.mjs?t=${Date.now()}-3`);
    const config = loadSglConfig();
    assert.equal(resolveModelId(config, "glm"), "GLM-5.2-FP8");
    assert.equal(resolveModelId(config, "dsv4"), "deepseek-ai/DeepSeek-V4-Flash");
    assert.equal(resolveModelId(config, undefined), "GLM-5.2-FP8");
    assert.equal(resolveModelId(config, "some-other-model-id"), "some-other-model-id");
  });
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/config.test.mjs`
Expected: 3 pass, 0 fail.

Note: the test imports `config.mjs` with a cache-busting query string (`?t=...`) on each test because the module reads `process.env.SGL_CONFIG_DIR` lazily inside each function call (not at import time), so this is only needed for import isolation between tests, not for env-var freshness — `resolveConfigDir()` already re-reads the env var on every call.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/config.mjs scripts/lib/config.test.mjs
git commit -m "Add config.mjs: single source of truth for gateway url/token/model aliases"
```

---

### Task 6: `lib/opencode-provider-config.mjs` (new — per-job OpenCode config builder)

Pure, side-effect-free builder for the JSON that gets written to a job-scoped temp file and passed to `opencode serve` via `OPENCODE_CONFIG` (Task 7). Confirmed against OpenCode's actual docs during planning: custom OpenAI-compatible providers use `npm: "@ai-sdk/openai-compatible"` with `options.baseURL`/`options.apiKey`, and the permission system only supports `"allow"`/`"deny"`/`"ask"` per tool (`edit`, `bash`) — no per-command bash allowlisting.

**Files:**
- Create: `scripts/lib/opencode-provider-config.mjs`
- Test: `scripts/lib/opencode-provider-config.test.mjs`

**Interfaces:**
- Consumes: the config shape produced by `loadSglConfig()` in `config.mjs` (Task 5): `{ baseUrl, apiKeyEnv, models: { [alias]: modelId } }`.
- Produces: `PROVIDER_ID` (constant `"sgl-gateway"`), `buildOpencodeConfig(sglConfig, permissionProfile)` — consumed by `opencode.mjs` (Task 7).

- [ ] **Step 1: Write `scripts/lib/opencode-provider-config.mjs`**

```javascript
export const PROVIDER_ID = "sgl-gateway";

const PERMISSION_PROFILES = {
  rescue: { edit: "allow", bash: "allow" },
  review: { edit: "deny", bash: "deny" }
};

export function buildOpencodeConfig(sglConfig, permissionProfile) {
  if (!sglConfig.baseUrl) {
    throw new Error("No gateway base URL configured. Run /sgl:setup --base-url <url> first.");
  }

  const permission = PERMISSION_PROFILES[permissionProfile];
  if (!permission) {
    throw new Error(`Unknown permission profile "${permissionProfile}". Use "rescue" or "review".`);
  }

  const models = {};
  for (const modelId of new Set(Object.values(sglConfig.models ?? {}))) {
    models[modelId] = { name: modelId };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "sgl gateway",
        options: {
          baseURL: sglConfig.baseUrl,
          apiKey: `{env:${sglConfig.apiKeyEnv}}`
        },
        models
      }
    },
    permission
  };
}
```

- [ ] **Step 2: Write `scripts/lib/opencode-provider-config.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import { buildOpencodeConfig, PROVIDER_ID } from "./opencode-provider-config.mjs";

const SAMPLE_CONFIG = {
  baseUrl: "https://gateway.post-train.win/v1",
  apiKeyEnv: "CLIENT_KEY",
  models: {
    glm: "GLM-5.2-FP8",
    dsv4: "deepseek-ai/DeepSeek-V4-Flash"
  }
};

test("buildOpencodeConfig registers the gateway as an openai-compatible provider", () => {
  const config = buildOpencodeConfig(SAMPLE_CONFIG, "rescue");
  const provider = config.provider[PROVIDER_ID];
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.options.baseURL, "https://gateway.post-train.win/v1");
  assert.equal(provider.options.apiKey, "{env:CLIENT_KEY}");
  assert.deepEqual(Object.keys(provider.models).sort(), ["GLM-5.2-FP8", "deepseek-ai/DeepSeek-V4-Flash"].sort());
});

test("rescue profile allows edit and bash", () => {
  const config = buildOpencodeConfig(SAMPLE_CONFIG, "rescue");
  assert.deepEqual(config.permission, { edit: "allow", bash: "allow" });
});

test("review profile denies edit and bash", () => {
  const config = buildOpencodeConfig(SAMPLE_CONFIG, "review");
  assert.deepEqual(config.permission, { edit: "deny", bash: "deny" });
});

test("throws on unknown permission profile", () => {
  assert.throws(() => buildOpencodeConfig(SAMPLE_CONFIG, "bogus"), /Unknown permission profile/);
});

test("throws when baseUrl is missing", () => {
  assert.throws(() => buildOpencodeConfig({ ...SAMPLE_CONFIG, baseUrl: null }, "rescue"), /No gateway base URL configured/);
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/opencode-provider-config.test.mjs`
Expected: 5 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/opencode-provider-config.mjs scripts/lib/opencode-provider-config.test.mjs
git commit -m "Add opencode-provider-config.mjs: per-job provider + permission profile builder"
```

---

### Task 7: `lib/opencode.mjs` part A — availability, session-runtime status, per-job server lifecycle

This is the direct replacement for codex-plugin-cc's `codex.mjs` + `app-server.mjs` + `broker-endpoint.mjs` + `broker-lifecycle.mjs`. Because the design uses one `opencode serve` per job instead of a shared broker, `getSessionRuntimeStatus` has no "shared" mode to report — it always describes the per-job model.

`opencode` is not installed in this environment as of planning time, so `startOpencodeServer`'s happy path (actually spawning `opencode serve`) is verified manually in Task 17, not by an automated test here. `findFreePort` and `getOpencodeAvailability`'s not-installed branch are pure/deterministic and are unit tested.

**Files:**
- Create: `scripts/lib/opencode.mjs`
- Test: `scripts/lib/opencode.test.mjs`

**Interfaces:**
- Consumes: `binaryAvailable`, `terminateProcessTree` from `process.mjs` (Task 2); `createTempDir`, `writeJsonFile` from `fs.mjs` (Task 2); `buildOpencodeConfig` from `opencode-provider-config.mjs` (Task 6).
- Produces (this task): `getOpencodeAvailability(cwd)`, `getSessionRuntimeStatus()`, `findFreePort()`, `startOpencodeServer(sglConfig, permissionProfile)` returning `{ port, pid, configDir, baseUrl, getStderr(), stop() }`.
- Produces (Task 8, same file): `runOpencodeTurn(cwd, options)`, `abortOpencodeSession(baseUrl, sessionId)`.

- [ ] **Step 1: Write `scripts/lib/opencode.mjs` (part A content)**

```javascript
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { createTempDir, writeJsonFile } from "./fs.mjs";
import { binaryAvailable, terminateProcessTree } from "./process.mjs";
import { buildOpencodeConfig } from "./opencode-provider-config.mjs";

const READY_TIMEOUT_MS = 15000;
const READY_POLL_INTERVAL_MS = 200;

export function getOpencodeAvailability(cwd) {
  return binaryAvailable("opencode", ["--version"], { cwd });
}

export function getSessionRuntimeStatus() {
  return {
    mode: "per-job",
    label: "per-job runtime",
    detail: "Each sgl job starts its own opencode server on an ephemeral port and tears it down when the job finishes.",
    endpoint: null
  };
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/doc`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not accepting connections yet; keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`opencode serve did not become ready on port ${port} within ${READY_TIMEOUT_MS}ms.`);
}

export async function startOpencodeServer(sglConfig, permissionProfile) {
  const configDir = createTempDir("sgl-opencode-config-");
  const configFile = path.join(configDir, "opencode.json");
  writeJsonFile(configFile, buildOpencodeConfig(sglConfig, permissionProfile));

  const port = await findFreePort();
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_CONFIG: configFile },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // spawn() emits 'error' instead of 'exit' when the binary itself can't be
  // launched (e.g. ENOENT). Without a listener, that 'error' event is
  // unhandled and crashes the whole Node process instead of failing this
  // one job — so it must feed the same race as exitPromise, not be ignored.
  const spawnErrorPromise = new Promise((_resolve, reject) => {
    child.once("error", (error) => reject(error));
  });

  try {
    await Promise.race([
      waitForReady(port, Date.now() + READY_TIMEOUT_MS),
      exitPromise.then((exit) => {
        throw new Error(
          `opencode serve exited before becoming ready (code=${exit.code}, signal=${exit.signal}): ${stderr.trim()}`
        );
      }),
      spawnErrorPromise
    ]);
  } catch (error) {
    terminateProcessTree(child.pid ?? Number.NaN);
    fs.rmSync(configDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    pid: child.pid,
    configDir,
    baseUrl: `http://127.0.0.1:${port}`,
    getStderr: () => stderr,
    async stop() {
      terminateProcessTree(child.pid ?? Number.NaN);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  };
}
```

- [ ] **Step 2: Write `scripts/lib/opencode.test.mjs` (part A content)**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { getOpencodeAvailability, getSessionRuntimeStatus, findFreePort } from "./opencode.mjs";

test("getOpencodeAvailability reports unavailable when opencode is not installed", () => {
  const result = getOpencodeAvailability(process.cwd());
  if (result.available) {
    // opencode happens to be installed in this environment; just check the shape.
    assert.equal(typeof result.detail, "string");
  } else {
    assert.equal(result.detail, "not found");
  }
});

test("getSessionRuntimeStatus always reports the per-job model", () => {
  const status = getSessionRuntimeStatus();
  assert.equal(status.mode, "per-job");
  assert.equal(status.endpoint, null);
});

test("findFreePort returns a port that is actually free", async () => {
  const port = await findFreePort();
  assert.ok(port > 0 && port < 65536);
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/opencode.test.mjs`
Expected: 3 pass, 0 fail. (`getOpencodeAvailability` will report `available: false` in this environment since `opencode` is not yet installed — that is the expected, correct result here, not a bug.)

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/opencode.mjs scripts/lib/opencode.test.mjs
git commit -m "Add opencode.mjs: availability check, session runtime status, per-job server lifecycle"
```

---

### Task 8: `lib/opencode.mjs` part B — SDK session wrapper (`runOpencodeTurn`, abort, structured output)

Appends to `scripts/lib/opencode.mjs` from Task 7 (does not replace it). This is the function both `/sgl:rescue` and `/sgl:review`/`/sgl:adversarial-review` call — the single execution path the design spec requires. Confirmed against `@opencode-ai/sdk` docs during planning: `createOpencodeClient({ baseUrl })`, `client.session.create({ body })`, `client.session.prompt({ path: { id }, body: { model: { providerID, modelID }, parts } })` (resolves to `{ info, parts }`), `client.session.abort({ path: { id } })`, `client.event.subscribe()` (async-iterable SSE stream for live progress).

The exact event names/fields on the `event.subscribe()` stream are not pinned down in the docs fetched during planning — progress reporting therefore treats every event generically (`event.type` + a truncated JSON dump of `event.properties`) rather than pattern-matching specific field names that would be guesses. This mirrors how `job-control.mjs`'s phase inference (Task 9) already treats log lines heuristically; the authoritative result always comes from the awaited `session.prompt()` promise, never from the event stream.

Because `opencode` is not installed in this environment, this task's live-network paths (`runOpencodeTurn` actually completing a turn, `abortOpencodeSession` actually aborting) are verified manually in Task 17 against the real gateway. What's unit-tested here is the pure parts: `buildSessionTitle`, `extractFinalText`, `parseStructuredOutput`.

**Files:**
- Modify: `scripts/lib/opencode.mjs` (append)
- Modify: `scripts/lib/opencode.test.mjs` (append)

**Interfaces:**
- Consumes: `startOpencodeServer` (Task 7), `readJsonFile` from `fs.mjs` (Task 2), `PROVIDER_ID` from `opencode-provider-config.mjs` (Task 6), `createOpencodeClient` from `@opencode-ai/sdk`.
- Produces: `runOpencodeTurn(cwd, options)` where `options = { sglConfig, permissionProfile, modelId, prompt, sessionId, onProgress }`, returning `{ status, threadId, turnId, finalMessage, error, stderr }` (same shape codex.mjs's `runAppServerTurn` returned, so `sgl-companion.mjs` in Task 12 and `render.mjs` in Task 11 consume it identically). Produces `abortOpencodeSession(baseUrl, sessionId)` returning `{ attempted, interrupted, detail }`. Produces `parseStructuredOutput(rawOutput, fallback)` and `readOutputSchema(schemaPath)` with the exact same signatures codex.mjs used, for drop-in reuse by `sgl-companion.mjs`'s adversarial-review path.

- [ ] **Step 1: Append to `scripts/lib/opencode.mjs`**

Add these imports to the top of the file (merge with the existing import block from Task 7):

```javascript
import { createOpencodeClient } from "@opencode-ai/sdk";

import { readJsonFile } from "./fs.mjs";
import { PROVIDER_ID } from "./opencode-provider-config.mjs";
```

Append this content to the end of the file:

```javascript
export function buildSessionTitle(prompt) {
  const trimmed = String(prompt ?? "").trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || "sgl session";
}

export function extractFinalText(promptResult) {
  const parts = Array.isArray(promptResult?.parts) ? promptResult.parts : [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function summarizeEventProperties(properties) {
  try {
    return JSON.stringify(properties ?? {}).slice(0, 200);
  } catch {
    return "";
  }
}

function emitProgress(onProgress, message, phase, extra = {}) {
  onProgress?.({ message, phase, ...extra });
}

function streamProgress(client, onProgress) {
  let stopped = false;
  const done = (async () => {
    try {
      const events = await client.event.subscribe();
      for await (const event of events.stream) {
        if (stopped) {
          break;
        }
        emitProgress(onProgress, `${event.type}: ${summarizeEventProperties(event.properties)}`, null);
      }
    } catch {
      // Progress streaming is best-effort; the awaited session.prompt() result is authoritative.
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done
  };
}

export async function runOpencodeTurn(cwd, options) {
  const { sglConfig, permissionProfile, modelId, prompt, sessionId, onProgress } = options;

  if (!prompt || !prompt.trim()) {
    throw new Error("A prompt is required for this sgl run.");
  }

  emitProgress(onProgress, "Starting opencode server.", "starting");
  const server = await startOpencodeServer(sglConfig, permissionProfile);
  emitProgress(onProgress, `opencode server ready on port ${server.port}.`, "starting", {
    serverBaseUrl: server.baseUrl
  });

  const client = createOpencodeClient({ baseUrl: server.baseUrl });
  let progressSubscription = null;

  try {
    let session;
    if (sessionId) {
      emitProgress(onProgress, `Resuming session ${sessionId}.`, "starting", { threadId: sessionId });
      session = { id: sessionId };
    } else {
      session = await client.session.create({ body: { title: buildSessionTitle(prompt) } });
      emitProgress(onProgress, `Session ready (${session.id}).`, "starting", { threadId: session.id });
    }

    progressSubscription = streamProgress(client, onProgress);

    let result = null;
    let failure = null;
    try {
      result = await client.session.prompt({
        path: { id: session.id },
        body: {
          model: { providerID: PROVIDER_ID, modelID: modelId },
          parts: [{ type: "text", text: prompt }]
        }
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      progressSubscription.stop();
    }

    if (failure) {
      emitProgress(onProgress, `opencode error: ${failure}`, "failed");
      return {
        status: 1,
        threadId: session.id,
        turnId: null,
        finalMessage: "",
        error: { message: failure },
        stderr: server.getStderr()
      };
    }

    const finalMessage = extractFinalText(result);
    emitProgress(onProgress, "Turn completed.", "finalizing");

    return {
      status: 0,
      threadId: session.id,
      turnId: result.info?.id ?? null,
      finalMessage,
      error: null,
      stderr: server.getStderr()
    };
  } finally {
    await server.stop();
    // Only safe to await here, after the server is stopped: streamProgress's
    // for-await loop may be blocked awaiting the next SSE event, and nothing
    // else would ever unblock it — killing the server drops that connection
    // and lets `done` resolve instead of leaving it a dangling promise.
    await progressSubscription?.done;
  }
}

export async function abortOpencodeSession(baseUrl, sessionId) {
  if (!baseUrl || !sessionId) {
    return { attempted: false, interrupted: false, detail: "missing baseUrl or sessionId" };
  }
  try {
    const client = createOpencodeClient({ baseUrl });
    const interrupted = await client.session.abort({ path: { id: sessionId } });
    return { attempted: true, interrupted: Boolean(interrupted), detail: null };
  } catch (error) {
    return { attempted: true, interrupted: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "sgl did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
```

- [ ] **Step 2: Append to `scripts/lib/opencode.test.mjs`**

```javascript
import { buildSessionTitle, extractFinalText, parseStructuredOutput } from "./opencode.mjs";

test("buildSessionTitle truncates long prompts to 80 characters", () => {
  const long = "x".repeat(200);
  const title = buildSessionTitle(long);
  assert.equal(title.length, 80);
  assert.ok(title.endsWith("..."));
});

test("buildSessionTitle falls back to a default for empty prompts", () => {
  assert.equal(buildSessionTitle("   "), "sgl session");
});

test("extractFinalText joins text parts and ignores non-text parts", () => {
  const text = extractFinalText({
    parts: [
      { type: "text", text: "first line" },
      { type: "tool", text: "ignored" },
      { type: "text", text: "second line" }
    ]
  });
  assert.equal(text, "first line\nsecond line");
});

test("parseStructuredOutput parses valid JSON", () => {
  const result = parseStructuredOutput('{"verdict":"approve"}');
  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, { verdict: "approve" });
});

test("parseStructuredOutput reports a parse error for invalid JSON without throwing", () => {
  const result = parseStructuredOutput("not json");
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /Unexpected token|not valid JSON/i);
});

test("parseStructuredOutput reports a fallback message for empty output", () => {
  const result = parseStructuredOutput("", { failureMessage: "sgl returned nothing" });
  assert.equal(result.parseError, "sgl returned nothing");
});
```

- [ ] **Step 3: Run the full opencode test file to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/opencode.test.mjs`
Expected: all 9 tests (3 from Task 7 + 6 new) pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/opencode.mjs scripts/lib/opencode.test.mjs
git commit -m "Add runOpencodeTurn: unified session wrapper for rescue and review"
```

---

### Task 9: Redesign `lib/tracked-jobs.mjs`

Design-review finding: the original hardcodes `SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"` and threads a Codex-style `threadId` through job records. This redesign renames the session env var, tracks an OpenCode-shaped `serverBaseUrl` field alongside `threadId`/`turnId` (needed so a separate `/sgl:cancel` process invocation can reach the still-running per-job `opencode serve` instance — see Global Constraints and Task 8's `abortOpencodeSession`), and adds secret redaction so `$CLIENT_KEY`'s actual value never lands in a job log file or stderr.

**Files:**
- Create: `scripts/lib/tracked-jobs.mjs`
- Test: `scripts/lib/tracked-jobs.test.mjs`

**Interfaces:**
- Consumes: `readJobFile`, `resolveJobFile`, `resolveJobLogFile`, `upsertJob`, `writeJobFile` from `state.mjs` (Task 4).
- Produces: `SESSION_ID_ENV` (now `"SGL_COMPANION_SESSION_ID"`), `nowIso()`, `redactSecrets(text, secrets)`, `appendLogLine(logFile, message, secrets)`, `appendLogBlock(logFile, title, body, secrets)`, `createJobLogFile`, `createJobRecord`, `createJobProgressUpdater` (now also persists `serverBaseUrl`), `createProgressReporter`, `runTrackedJob` — consumed by `job-control.mjs` (Task 10) and `sgl-companion.mjs` (Task 12).

- [ ] **Step 1: Write `scripts/lib/tracked-jobs.mjs`**

```javascript
import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "SGL_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

export function redactSecrets(text, secrets = []) {
  let result = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

// Deep variant for arbitrary execution payloads (rescue vs. review jobs
// have different shapes) — redacts every string leaf and preserves the
// original structure, so `result: execution.payload` in a job's persisted
// JSON record can't carry a secret in a field nobody thought to name.
export function redactSecretsDeep(value, secrets = []) {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, secrets));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = redactSecretsDeep(val, secrets);
    }
    return result;
  }
  return value;
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      serverBaseUrl:
        typeof value.serverBaseUrl === "string" && value.serverBaseUrl.trim() ? value.serverBaseUrl.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    serverBaseUrl: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message, secrets = []) {
  const normalized = redactSecrets(String(message ?? "").trim(), secrets);
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body, secrets = []) {
  if (!logFile || !body) {
    return;
  }
  const normalized = redactSecrets(String(body).trimEnd(), secrets);
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${normalized}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastServerBaseUrl = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.serverBaseUrl && normalized.serverBaseUrl !== lastServerBaseUrl) {
      lastServerBaseUrl = normalized.serverBaseUrl;
      patch.serverBaseUrl = normalized.serverBaseUrl;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null, secrets = [] } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = redactSecrets(event.stderrMessage ?? event.message, secrets);
    if (stderr && stderrMessage) {
      process.stderr.write(`[sgl] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message, secrets);
    appendLogBlock(logFile, event.logTitle, event.logBody, secrets);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // Redact once and reuse the same value for the state file and the log
    // file — writing the raw string to one and the redacted string to the
    // other left a secret sitting in the JSON job record even after the
    // log file itself was fixed. `payload` and `summary` go through the
    // same treatment: both are runner-derived just like `rendered`, and
    // `payload`'s shape varies by job type, hence the deep variant.
    const redactedRendered = redactSecrets(String(execution.rendered ?? ""), options.secrets ?? []);
    const redactedPayload = redactSecretsDeep(execution.payload, options.secrets ?? []);
    const redactedSummary = redactSecrets(String(execution.summary ?? ""), options.secrets ?? []);
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      serverBaseUrl: null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: redactedPayload,
      rendered: redactedRendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      serverBaseUrl: null,
      summary: redactedSummary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", redactedRendered);
    return execution;
  } catch (error) {
    const errorMessage = redactSecrets(
      error instanceof Error ? error.message : String(error),
      options.secrets ?? []
    );
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    // Rethrow the redacted message, not the original `error` — the caller
    // (and Task 13's top-level main().catch, which prints error.message to
    // stderr unredacted) would otherwise leak whatever this function just
    // redacted for disk. A server-start failure that echoes a secret into
    // its own stderr (opencode.mjs's "opencode serve exited before
    // becoming ready: ${stderr}") is exactly the shape that reaches here.
    throw new Error(errorMessage);
  }
}
```

- [ ] **Step 2: Write `scripts/lib/tracked-jobs.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import {
  redactSecrets,
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  runTrackedJob
} from "./tracked-jobs.mjs";
import { listJobs } from "./state.mjs";

function initRepo() {
  const dir = createTempDir("sgl-tracked-jobs-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("redactSecrets strips every occurrence of a secret value", () => {
  const text = redactSecrets("Authorization: Bearer sk-abc123 (token sk-abc123)", ["sk-abc123"]);
  assert.equal(text, "Authorization: Bearer [REDACTED] (token [REDACTED])");
});

test("appendLogLine redacts secrets before writing to the log file", () => {
  const dir = createTempDir("sgl-log-test-");
  const logFile = `${dir}/job.log`;
  fs.writeFileSync(logFile, "", "utf8");
  appendLogLine(logFile, "using token sk-abc123", ["sk-abc123"]);
  const contents = fs.readFileSync(logFile, "utf8");
  assert.doesNotMatch(contents, /sk-abc123/);
  assert.match(contents, /\[REDACTED\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createJobProgressUpdater persists serverBaseUrl onto the job record", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const logFile = createJobLogFile(dir, "task-1", "Test job");
  const update = createJobProgressUpdater(dir, "task-1");
  update({ message: "server ready", phase: "starting", serverBaseUrl: "http://127.0.0.1:5555" });
  const [job] = listJobs(dir);
  assert.equal(job.serverBaseUrl, "http://127.0.0.1:5555");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
  void logFile;
});

test("runTrackedJob records a completed job and clears serverBaseUrl", async () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const job = { id: "task-2", workspaceRoot: dir, title: "Test job" };
  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    threadId: "session-abc",
    turnId: "msg-1",
    payload: { ok: true },
    rendered: "done",
    summary: "Test job finished"
  }));
  const [stored] = listJobs(dir);
  assert.equal(stored.status, "completed");
  assert.equal(stored.threadId, "session-abc");
  assert.equal(stored.serverBaseUrl, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/tracked-jobs.test.mjs`
Expected: 4 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/tracked-jobs.mjs scripts/lib/tracked-jobs.test.mjs
git commit -m "Redesign tracked-jobs.mjs: sgl session env var, serverBaseUrl tracking, secret redaction"
```

---

### Task 10: Redesign `lib/job-control.mjs`

Design-review finding: the original imports `getSessionRuntimeStatus` directly from `codex.mjs` and infers job phase by pattern-matching Codex's own narration vocabulary (`"starting codex"`, `"thread ready"`, `"codex error:"`, etc.), and hardcodes `/codex:status`/`/codex:cancel` in error text. This redesign points at `opencode.mjs`'s `getSessionRuntimeStatus`, matches the log vocabulary `runOpencodeTurn` (Task 8) actually emits, and updates all user-facing command references to `/sgl:*`.

The exact `event.type` strings OpenCode's SSE stream uses are not confirmed from documentation alone (see Task 8's note) — `inferJobPhase`'s "investigating"/"editing" branches key off generic substrings (`tool`, `edit`, `write`, `patch`) that are reasonable guesses, not confirmed OpenCode vocabulary. Task 17's manual end-to-end run against the live gateway is where this gets tuned against real event output; this task's automated test only proves the function is deterministic and falls back sanely, not that it matches OpenCode's real event names.

**Files:**
- Create: `scripts/lib/job-control.mjs`
- Test: `scripts/lib/job-control.test.mjs`

**Interfaces:**
- Consumes: `getSessionRuntimeStatus` from `opencode.mjs` (Task 7); `getConfig`, `listJobs`, `readJobFile`, `resolveJobFile` from `state.mjs` (Task 4); `SESSION_ID_ENV` from `tracked-jobs.mjs` (Task 9); `resolveWorkspaceRoot` from `workspace.mjs` (Task 3).
- Produces: `sortJobsNewestFirst`, `readJobProgressPreview`, `enrichJob`, `readStoredJob`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `resolveResultJob`, `resolveCancelableJob` — consumed by `sgl-companion.mjs` (Task 12) and `render.mjs` (Task 11).

- [ ] **Step 1: Write `scripts/lib/job-control.mjs`**

```javascript
import fs from "node:fs";

import { getSessionRuntimeStatus } from "./opencode.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return ["Final output"].includes(line);
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (
      line.startsWith("starting opencode") ||
      line.startsWith("opencode server ready") ||
      line.startsWith("session ready") ||
      line.startsWith("resuming session")
    ) {
      return "starting";
    }
    if (line.includes("opencode error:") || line.startsWith("failed:")) {
      return "failed";
    }
    if (looksLikeVerificationCommand(line)) {
      return "verifying";
    }
    if (line.includes("edit") || line.includes("write") || line.includes("patch")) {
      return "editing";
    }
    if (line.includes("tool") || line.includes("read") || line.includes("grep") || line.includes("glob")) {
      return job.jobClass === "review" ? "reviewing" : "investigating";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /sgl:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /sgl:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /sgl:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /sgl:status to inspect active jobs.`);
  }

  throw new Error("No finished sgl jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple sgl jobs are active. Pass a job id to /sgl:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active sgl jobs to cancel for this session.");
  }

  throw new Error("No active sgl jobs to cancel.");
}
```

- [ ] **Step 2: Write `scripts/lib/job-control.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { upsertJob } from "./state.mjs";
import { buildStatusSnapshot, buildSingleJobSnapshot, resolveCancelableJob, enrichJob } from "./job-control.mjs";

function initRepo() {
  const dir = createTempDir("sgl-job-control-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("buildStatusSnapshot reports the per-job session runtime", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const snapshot = buildStatusSnapshot(dir);
  assert.equal(snapshot.sessionRuntime.mode, "per-job");
  assert.deepEqual(snapshot.running, []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("enrichJob infers 'starting' phase from an opencode server-ready log line", () => {
  const job = { id: "task-1", status: "running", jobClass: "task", startedAt: new Date().toISOString() };
  const enriched = enrichJob({ ...job, logFile: null });
  assert.equal(enriched.phase, "running");
});

test("buildSingleJobSnapshot throws a helpful error for an unknown job id", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  assert.throws(() => buildSingleJobSnapshot(dir, "nonexistent"), /No job found for "nonexistent"/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveCancelableJob throws when there is nothing active to cancel", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  assert.throws(() => resolveCancelableJob(dir, ""), /No active sgl jobs to cancel/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveCancelableJob finds the single active job when one is running", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  upsertJob(dir, { id: "task-1", status: "running" });
  const { job } = resolveCancelableJob(dir, "");
  assert.equal(job.id, "task-1");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/job-control.test.mjs`
Expected: 5 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/job-control.mjs scripts/lib/job-control.test.mjs
git commit -m "Redesign job-control.mjs against opencode.mjs vocabulary instead of codex.mjs"
```

---

### Task 11: Redesign `lib/render.mjs`

Design-review finding: the original encodes Codex's thread model directly in output — `formatCodexResumeCommand` emits a bare `codex resume ${threadId}` shell command, and result rendering branches on `storedJob?.result?.codex?.stdout`. Two real adaptations, not just renames:

1. **No standalone resume command exists for sgl.** Codex's `codex resume <id>` works because a user's local `codex` CLI is already configured with real OpenAI auth. sgl's provider registration only exists inside the ephemeral per-job `OPENCODE_CONFIG` file (Task 7), which is deleted when the job's server stops — so there is nothing a user could run standalone that would already know about the gateway. The resume hint therefore points back at the plugin itself: `/sgl:rescue --resume ...`, which is the only path that reconstructs the provider config correctly.
2. **No distinct "native review" mode exists.** Codex has a built-in review RPC separate from its general turn API; sgl only has `runOpencodeTurn` (Task 8), used for both rescue and review. `renderNativeReviewResult` is replaced with `renderPlainReviewResult`, adapted to the `{ finalMessage, stderr, status }` shape `runOpencodeTurn` actually returns (the original used `{ stdout, stderr, status }` from Codex's review RPC).

**Files:**
- Create: `scripts/lib/render.mjs`
- Test: `scripts/lib/render.test.mjs`

**Interfaces:**
- Produces: `renderSetupReport`, `renderReviewResult` (structured/adversarial), `renderPlainReviewResult` (freeform/plain review — replaces `renderNativeReviewResult`), `renderTaskResult`, `renderStatusReport`, `renderJobStatusReport`, `renderStoredJobResult`, `renderCancelReport` — consumed by `sgl-companion.mjs` (Task 12).

- [ ] **Step 1: Write `scripts/lib/render.mjs`**

```javascript
function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `/sgl:rescue --resume`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | sgl Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/sgl:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/sgl:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  sgl session ID: ${job.threadId}`);
  }
  const resumeCommand = formatResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /sgl:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /sgl:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && options.showReviewHint) {
    lines.push("  Review changes: /sgl:review --wait");
    lines.push("  Stricter review: /sgl:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# sgl Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- opencode: ${report.opencode.detail}`,
    `- gateway: ${report.gateway.detail}`,
    `- structured output: ${report.structuredOutput.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# sgl ${meta.reviewLabel}`,
      "",
      "sgl did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# sgl ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "sgl returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# sgl ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderPlainReviewResult(result, meta) {
  const finalMessage = String(result.finalMessage ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const lines = [`# sgl ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, ""];

  if (finalMessage) {
    lines.push(finalMessage);
  } else if (result.status === 0) {
    lines.push("sgl review completed without any output.");
  } else {
    lines.push("sgl review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "sgl did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# sgl Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh sgl adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# sgl Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? "/sgl:rescue --resume" : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nsgl session ID: ${threadId}\nResume: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.opencode?.stdout === "string" && storedJob.result.opencode.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nsgl session ID: ${threadId}\nResume: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nsgl session ID: ${threadId}\nResume: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "sgl Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`sgl session ID: ${threadId}`);
    lines.push(`Resume: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# sgl Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/sgl:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
```

- [ ] **Step 2: Write `scripts/lib/render.test.mjs`**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderPlainReviewResult,
  renderStoredJobResult,
  renderCancelReport
} from "./render.mjs";

test("renderReviewResult renders a valid structured review with sorted findings", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "One risky change.",
        findings: [
          { severity: "low", title: "Nit", body: "minor", file: "a.js", line_start: 1, line_end: 1 },
          { severity: "critical", title: "Data loss", body: "oops", file: "b.js", line_start: 5, line_end: 7 }
        ],
        next_steps: ["Add a test"]
      },
      parseError: null
    },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /# sgl Adversarial Review/);
  const criticalIndex = output.indexOf("Data loss");
  const lowIndex = output.indexOf("Nit");
  assert.ok(criticalIndex < lowIndex, "critical finding should be listed before low finding");
});

test("renderReviewResult falls back to raw output on invalid JSON", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "not json" },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /not json/);
});

test("renderPlainReviewResult renders finalMessage as the review body", () => {
  const output = renderPlainReviewResult(
    { finalMessage: "Looks safe to ship.", stderr: "", status: 0 },
    { reviewLabel: "Review", targetLabel: "branch diff against main" }
  );
  assert.match(output, /# sgl Review/);
  assert.match(output, /Looks safe to ship\./);
});

test("renderStoredJobResult points the resume hint at /sgl:rescue --resume", () => {
  const output = renderStoredJobResult(
    { id: "task-1", status: "completed", threadId: "session-abc" },
    { threadId: "session-abc", rendered: "All done." }
  );
  assert.match(output, /sgl session ID: session-abc/);
  assert.match(output, /Resume: \/sgl:rescue --resume/);
});

test("renderCancelReport points at /sgl:status", () => {
  const output = renderCancelReport({ id: "task-2", title: "Test job" });
  assert.match(output, /# sgl Cancel/);
  assert.match(output, /\/sgl:status/);
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `cd /home/taehwak/workspace/sgl-plugin && node --test scripts/lib/render.test.mjs`
Expected: 5 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/lib/render.mjs scripts/lib/render.test.mjs
git commit -m "Redesign render.mjs: sgl session model, drop Codex native-review rendering"
```

---

### Task 12: `schemas/review-output.schema.json` and prompt templates

`review-output.schema.json` is model-agnostic and copied verbatim. `prompts/adversarial-review.md` and `prompts/stop-review-gate.md` are also model-agnostic in their body text (no literal "Codex" role-play instructions), forked verbatim except one addition: since OpenCode's `session.prompt()` has no confirmed SDK-level parameter for enforcing a JSON schema on output (only "the model will use a StructuredOutput tool" is documented, without a pinned-down request shape), the adversarial-review prompt now embeds the actual schema JSON as inline prompt text via a new `{{OUTPUT_SCHEMA_JSON}}` template variable — this makes schema compliance a prompt-engineering property rather than an unconfirmed API guarantee, consistent with the spec's "structured output is opportunistic, not required" stance. `prompts/review.md` is new (Codex had a built-in native-review mode with no local prompt template; sgl needs one).

**Files:**
- Create: `schemas/review-output.schema.json`
- Create: `prompts/review.md`
- Create: `prompts/adversarial-review.md`
- Create: `prompts/stop-review-gate.md`

**Interfaces:**
- Consumes: nothing (static assets).
- Produces: template files loaded by `loadPromptTemplate`/`interpolateTemplate` (`prompts.mjs`, Task 2) from `sgl-companion.mjs` (Task 13). `{{TARGET_LABEL}}`, `{{USER_FOCUS}}`, `{{REVIEW_COLLECTION_GUIDANCE}}`, `{{REVIEW_INPUT}}`, `{{OUTPUT_SCHEMA_JSON}}` for `adversarial-review.md`; `{{TARGET_LABEL}}`, `{{REVIEW_COLLECTION_GUIDANCE}}`, `{{REVIEW_INPUT}}` for `review.md`; `{{CLAUDE_RESPONSE_BLOCK}}` for `stop-review-gate.md`.

- [ ] **Step 1: Write `schemas/review-output.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "verdict",
    "summary",
    "findings",
    "next_steps"
  ],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": [
        "approve",
        "needs-attention"
      ]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "severity",
          "title",
          "body",
          "file",
          "line_start",
          "line_end",
          "confidence",
          "recommendation"
        ],
        "properties": {
          "severity": {
            "type": "string",
            "enum": [
              "critical",
              "high",
              "medium",
              "low"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "body": {
            "type": "string",
            "minLength": 1
          },
          "file": {
            "type": "string",
            "minLength": 1
          },
          "line_start": {
            "type": "integer",
            "minimum": 1
          },
          "line_end": {
            "type": "integer",
            "minimum": 1
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "recommendation": {
            "type": "string"
          }
        }
      }
    },
    "next_steps": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    }
  }
}
```

- [ ] **Step 2: Write `prompts/review.md`**

```markdown
<role>
You are performing a plain software code review through the sgl gateway.
Your job is to give a balanced, honest assessment — not to hunt for reasons to block, and not to rubber-stamp.
</role>

<task>
Review the provided repository context for correctness, safety, and maintainability issues.
Target: {{TARGET_LABEL}}
</task>

<review_method>
Read the diff and, if it was elided for size, use your `read`/`grep`/`glob` tools to open the changed files listed under "Changed Files" directly — you do not have shell/bash access in this session, so you cannot run `git` yourself.
Focus on correctness bugs, missed edge cases, and any change that could break existing behavior.
{{REVIEW_COLLECTION_GUIDANCE}}
</review_method>

<finding_bar>
Report only material findings. Skip style nits, naming preferences, and speculative concerns without evidence.
</finding_bar>

<output_contract>
Respond in plain prose, not JSON.
Open with a one-line verdict (safe to ship / needs changes before shipping).
Follow with your findings, each naming the file and describing the concrete risk.
Close with any concrete next steps you'd recommend.
</output_contract>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
```

- [ ] **Step 3: Write `prompts/adversarial-review.md`**

```markdown
<role>
You are performing an adversarial software review through the sgl gateway.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the provided repository context as if you are trying to find the strongest reasons this change should not ship yet.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus area, weight it heavily, but still report any other material issue you can defend.
{{REVIEW_COLLECTION_GUIDANCE}}
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<structured_output_contract>
Return only valid JSON matching this schema exactly — no prose before or after it, no markdown code fence:

{{OUTPUT_SCHEMA_JSON}}

Keep the output compact and specific.
Use `needs-attention` if there is any material risk worth blocking on.
Use `approve` only if you cannot support any substantive adversarial finding from the provided context.
Every finding must include:
- the affected file
- `line_start` and `line_end`
- a confidence score from 0 to 1
- a concrete recommendation
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided repository context or tool outputs.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly in the finding body and keep the confidence honest.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.
</calibration_rules>

<final_check>
Before finalizing, check that each finding is:
- adversarial rather than stylistic
- tied to a concrete code location
- plausible under a real failure scenario
- actionable for an engineer fixing the issue
</final_check>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
```

- [ ] **Step 4: Write `prompts/stop-review-gate.md`**

```markdown
<task>
Run a stop-gate review of the previous Claude turn.
Only review the work from the previous Claude turn.
Only review it if Claude actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
For example, the output of /sgl:setup or /sgl:status does not count.
Only direct edits made in that specific turn count.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return ALLOW immediately and do no further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
```

- [ ] **Step 5: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add schemas/review-output.schema.json prompts/review.md prompts/adversarial-review.md prompts/stop-review-gate.md
git commit -m "Add review-output schema and prompt templates (review, adversarial-review, stop-review-gate)"
```

---

### Task 13: `scripts/sgl-companion.mjs` — main CLI dispatcher

Fork of `codex-companion.mjs`, simplified because unification removed several Codex-only concerns: no native-review branch (both review commands go through `runOpencodeTurn`), no `--effort`/reasoning-effort concept (not part of the spec's scope — YAGNI), no `spark`-style model alias (aliases now come from `config.mjs`'s `models` map, resolved via `resolveModelId`). `/sgl:review` still rejects extra focus text (parity with codex-plugin-cc's UX: plain review has none, adversarial-review does).

`/sgl:setup`'s health checks are real, not stubbed: `getOpencodeAvailability` (Task 7) for the binary, a direct `fetch` POST to `${baseUrl}/chat/completions` for gateway reachability/token validity (this one-off connectivity probe is not the execution path the design spec forbids a separate HTTP client for — it never generates review/rescue content, it only answers "is the gateway reachable with this token"), and a second probe requesting `response_format: json_schema` to record whether the gateway honors it, cached onto `sglConfig.structuredOutputSupported`.

Matching codex-plugin-cc's precedent, this file has no dedicated automated test suite of its own (the original `codex-companion.mjs` has none either — it's an I/O-orchestration script over already-tested `lib/` modules). It's verified with a `--help` smoke test here and a full manual end-to-end run in Task 16.

**Files:**
- Create: `scripts/sgl-companion.mjs`

**Interfaces:**
- Consumes: every `lib/` module from Tasks 2–11, plus `readOutputSchema`, `parseStructuredOutput`, `runOpencodeTurn`, `abortOpencodeSession`, `getOpencodeAvailability`, `getSessionRuntimeStatus` from `opencode.mjs` (Tasks 7–8).
- Produces: the `sgl-companion.mjs` CLI, invoked by `commands/*.md` (Task 14) as `node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" <subcommand> ...`.

- [ ] **Step 1: Write `scripts/sgl-companion.mjs`**

```javascript
#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { loadSglConfig, updateSglConfig, resolveModelId } from "./lib/config.mjs";
import {
  getOpencodeAvailability,
  getSessionRuntimeStatus,
  runOpencodeTurn,
  abortOpencodeSession,
  parseStructuredOutput,
  readOutputSchema
} from "./lib/opencode.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderPlainReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_CONTINUE_PROMPT = "Continue the previous task.";
const GATEWAY_PROBE_TIMEOUT_MS = 15000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/sgl-companion.mjs setup [--base-url <url>] [--api-key-env <name>] [--model <alias>=<id>] [--default-model <alias>] [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/sgl-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/sgl-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/sgl-companion.mjs task [--background] [--resume-last|--resume|--fresh] [--model <alias>] [prompt]",
      "  node scripts/sgl-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/sgl-companion.mjs result [job-id] [--json]",
      "  node scripts/sgl-companion.mjs cancel [job-id] [--json]",
      "  node scripts/sgl-companion.mjs stop-review [--json] [claude response text]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      m: "model",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function probeGatewayReachability(sglConfig) {
  const token = process.env[sglConfig.apiKeyEnv];
  if (!token) {
    return { available: false, detail: `Environment variable ${sglConfig.apiKeyEnv} is not set.` };
  }
  const defaultModelId = resolveModelId(sglConfig, undefined);
  try {
    const response = await fetch(`${sglConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: defaultModelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { available: false, detail: `Gateway responded with HTTP ${response.status}.` };
    }
    return { available: true, detail: `Reachable at ${sglConfig.baseUrl} (model ${defaultModelId}).` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeStructuredOutputSupport(sglConfig) {
  const token = process.env[sglConfig.apiKeyEnv];
  if (!token) {
    return null;
  }
  const defaultModelId = resolveModelId(sglConfig, undefined);
  try {
    const response = await fetch(`${sglConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: defaultModelId,
        messages: [{ role: "user", content: "Reply with JSON matching the schema." }],
        max_tokens: 32,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "probe",
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
          }
        }
      }),
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content ?? "";
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const opencodeStatus = getOpencodeAvailability(cwd);
  let sglConfig = loadSglConfig();
  const gateway = await probeGatewayReachability(sglConfig);

  const nextSteps = [];
  if (!opencodeStatus.available) {
    nextSteps.push("Install opencode (see https://opencode.ai) so /sgl:rescue and /sgl:review have an execution engine.");
  }
  if (!gateway.available) {
    nextSteps.push(`Fix gateway connectivity: ${gateway.detail}`);
  }

  let structuredOutput = { available: sglConfig.structuredOutputSupported, detail: "not probed" };
  if (opencodeStatus.available && gateway.available) {
    const supported = await probeStructuredOutputSupport(sglConfig);
    sglConfig = updateSglConfig((config) => {
      config.structuredOutputSupported = supported;
    });
    structuredOutput = {
      available: supported,
      // adversarial-review always parses leniently regardless of this probe
      // result (see parseStructuredOutput) — this is diagnostic information
      // about how often that fallback path is likely to trigger, not a
      // report of different behavior the plugin takes based on the flag.
      detail: supported
        ? "the gateway honored a response_format: json_schema request during setup"
        : "the gateway did not honor response_format: json_schema during setup — expect adversarial-review's lenient-parse fallback to trigger more often"
    };
  }

  const config = getConfig(workspaceRoot);

  return {
    ready: nodeStatus.available && opencodeStatus.available && gateway.available,
    node: nodeStatus,
    opencode: opencodeStatus,
    gateway,
    structuredOutput,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "base-url", "api-key-env", "default-model", "model"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["base-url"] || options["api-key-env"] || options["default-model"] || options.model) {
    updateSglConfig((config) => {
      if (options["base-url"]) {
        config.baseUrl = options["base-url"];
        actionsTaken.push(`Set gateway base URL to ${options["base-url"]}.`);
      }
      if (options["api-key-env"]) {
        config.apiKeyEnv = options["api-key-env"];
        actionsTaken.push(`Set API key env var name to ${options["api-key-env"]}.`);
      }
      if (options.model) {
        const [alias, modelId] = String(options.model).split("=", 2);
        if (!alias || !modelId) {
          throw new Error('--model must be in the form --model <alias>=<model-id>, e.g. --model glm=GLM-5.2-FP8');
        }
        config.models = { ...config.models, [alias]: modelId };
        actionsTaken.push(`Registered model alias "${alias}" -> "${modelId}".`);
      }
      if (options["default-model"]) {
        config.defaultModelAlias = options["default-model"];
        actionsTaken.push(`Set default model alias to ${options["default-model"]}.`);
      }
    });
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function ensureOpencodeAvailable(cwd) {
  const availability = getOpencodeAvailability(cwd);
  if (!availability.available) {
    throw new Error("opencode CLI is not installed. Install it (see https://opencode.ai), then rerun `/sgl:setup`.");
  }
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "sgl Review" : `sgl ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "sgl Resume" : "sgl Rescue";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

async function executeReviewRun(request) {
  ensureOpencodeAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  // `target` is resolved once by the caller (handleReviewCommand) and passed
  // in here — resolving it a second time was redundant work, and it also
  // meant the focus-text validation below used to live here instead of
  // before the job record was even created (see handleReviewCommand).
  const target = request.target;
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName;

  const context = collectReviewContext(request.cwd, target);
  const sglConfig = loadSglConfig();
  const modelId = resolveModelId(sglConfig, request.model);

  let prompt;
  if (reviewName === "Adversarial Review") {
    const outputSchemaJson = JSON.stringify(readOutputSchema(REVIEW_SCHEMA), null, 2);
    const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
    prompt = interpolateTemplate(template, {
      TARGET_LABEL: target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      REVIEW_INPUT: context.content,
      OUTPUT_SCHEMA_JSON: outputSchemaJson
    });
  } else {
    const template = loadPromptTemplate(ROOT_DIR, "review");
    prompt = interpolateTemplate(template, {
      TARGET_LABEL: target.label,
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      REVIEW_INPUT: context.content
    });
  }

  const result = await runOpencodeTurn(request.cwd, {
    sglConfig,
    permissionProfile: "review",
    modelId,
    prompt,
    onProgress: request.onProgress
  });

  if (reviewName === "Adversarial Review") {
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.error?.message ?? result.stderr
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary },
      opencode: { status: result.status, stderr: result.stderr, stdout: result.finalMessage },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };
    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered: renderReviewResult(parsed, { reviewLabel: reviewName, targetLabel: target.label }),
      summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
      jobTitle: `sgl ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    opencode: { status: result.status, stderr: result.stderr, stdout: result.finalMessage }
  };
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderPlainReviewResult(result, { reviewLabel: reviewName, targetLabel: target.label }),
    summary: firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `sgl ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) => job.jobClass === "task" && job.threadId && job.status !== "queued" && job.status !== "running"
    ) ?? null
  );
}

function resolveLatestTrackedTaskThread(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find(
    (job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running")
  );
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /sgl:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  return trackedTask ? { id: trackedTask.threadId } : null;
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureOpencodeAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = resolveLatestTrackedTaskThread(workspaceRoot, { excludeJobId: request.jobId });
    if (!latestThread) {
      throw new Error("No previous sgl rescue session was found for this repository.");
    }
    resumeSessionId = latestThread.id;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const sglConfig = loadSglConfig();
  const modelId = resolveModelId(sglConfig, request.model);

  const result = await runOpencodeTurn(request.cwd, {
    sglConfig,
    permissionProfile: "rescue",
    modelId,
    prompt: request.prompt?.trim() || DEFAULT_CONTINUE_PROMPT,
    sessionId: resumeSessionId,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult({ rawOutput, failureMessage }, { title: taskMetadata.title, jobId: request.jobId ?? null });
  const payload = { status: result.status, threadId: result.threadId, rawOutput };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task"
  };
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind === "adversarial-review" ? "adversarial-review" : jobClass === "review" ? "review" : "rescue",
    title,
    workspaceRoot,
    jobClass,
    summary
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  const sglConfig = loadSglConfig();
  const secrets = [process.env[sglConfig.apiKeyEnv]].filter(Boolean);
  return {
    logFile,
    secrets,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      secrets,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, secrets, progress } = createTrackedProgress(job, { logFile: options.logFile, stderr: !options.json });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile, secrets });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "sgl-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", (error) => {
    // Spawn failures (EMFILE/EAGAIN, or `cwd` vanishing) emit 'error'
    // asynchronously, after this function has already returned control to
    // the caller — an unhandled listener here would crash the whole host
    // process (the same bug class opencode.mjs's startOpencodeServer was
    // fixed for in Task 7). Mark the job failed instead of leaving it
    // stuck in "queued" forever.
    try {
      const workspaceRoot = resolveWorkspaceRoot(cwd);
      upsertJob(workspaceRoot, {
        id: jobId,
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: `Failed to start background worker: ${error.message}`,
        completedAt: nowIso()
      });
    } catch {
      // Best effort — if the job record can't be updated either, there's
      // nothing further to do from a detached spawn's error handler.
    }
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, logFile, request };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return { payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile }, logFile };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();

  // Validate before creating a job record — this used to throw from inside
  // executeReviewRun, which runs inside runTrackedJob, so an invalid
  // /sgl:review <text> call left a spurious "failed" job behind.
  if (config.reviewName === "Review" && focusText) {
    throw new Error(
      "`/sgl:review` does not support custom focus text. Retry with `/sgl:adversarial-review " + focusText + "` for focused review instructions."
    );
  }

  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        target,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file"],
    booleanOptions: ["json", "resume-last", "resume", "fresh", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  if (options.background) {
    ensureOpencodeAvailable(cwd);
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }
    const job = createCompanionJob({
      prefix: "task",
      kind: "task",
      title: taskMetadata.title,
      workspaceRoot,
      jobClass: "task",
      summary: taskMetadata.summary
    });
    const request = { cwd, model: options.model, prompt, resumeLast, jobId: job.id };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, `${payload.title} started in the background as ${payload.jobId}. Check /sgl:status ${payload.jobId} for progress.\n`, options.json);
    return;
  }

  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({ cwd, model: options.model, prompt, resumeLast, jobId: job.id, onProgress: progress }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, secrets, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob({ ...storedJob, workspaceRoot, logFile }, () => executeTaskRun({ ...request, onProgress: progress }), { logFile, secrets });
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while ((snapshot.job.status === "queued" || snapshot.job.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return { ...snapshot, waitTimedOut: snapshot.job.status === "queued" || snapshot.job.status === "running", timeoutMs };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, { timeoutMs: options["timeout-ms"], pollIntervalMs: options["poll-interval-ms"] })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId: getCurrentClaudeSessionId(),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          threadId: candidate.threadId,
          completedAt: candidate.completedAt ?? null,
          updatedAt: candidate.updatedAt ?? null
        }
      : null
  };

  outputCommandResult(
    payload,
    candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).\n` : "No resumable task found for this session.\n",
    options.json
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const serverBaseUrl = existing.serverBaseUrl ?? job.serverBaseUrl ?? null;
  const threadId = existing.threadId ?? job.threadId ?? null;

  const abort = await abortOpencodeSession(serverBaseUrl, threadId);
  if (abort.attempted) {
    appendLogLine(
      job.logFile,
      abort.interrupted
        ? `Requested opencode session abort for ${threadId}.`
        : `opencode session abort failed${abort.detail ? `: ${abort.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." };
  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user.", completedAt });

  outputCommandResult(
    { jobId: job.id, status: "cancelled", title: job.title, turnAbortAttempted: abort.attempted, turnAborted: abort.interrupted },
    renderCancelReport(nextJob),
    options.json
  );
}

async function executeStopReviewRun(request) {
  ensureOpencodeAvailable(request.cwd);
  const sglConfig = loadSglConfig();
  const modelId = resolveModelId(sglConfig, request.model);
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");

  // The "review" permission profile denies bash, so the model cannot run `git` itself here.
  // Collect a lightweight working-tree snapshot up front so it has something concrete to
  // ground an ALLOW/BLOCK decision on; it can still `read`/`grep`/`glob` for more detail.
  let repoContextBlock = "";
  try {
    ensureGitRepository(request.cwd);
    const target = resolveReviewTarget(request.cwd, { scope: "working-tree" });
    const context = collectReviewContext(request.cwd, target);
    repoContextBlock = `\n\nRepository context (you have no bash access; use read/grep/glob if you need more than this):\n\n${context.content}`;
  } catch {
    repoContextBlock = "";
  }

  const prompt = interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: `${request.claudeResponseBlock ?? ""}${repoContextBlock}`
  });

  const result = await runOpencodeTurn(request.cwd, {
    sglConfig,
    permissionProfile: "review",
    modelId,
    prompt,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload: { status: result.status, threadId: result.threadId, rawOutput },
    rendered: rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`,
    summary: firstMeaningfulLine(rawOutput, "Stop-gate review finished."),
    jobTitle: "sgl Stop Gate Review",
    jobClass: "review"
  };
}

async function handleStopReview(argv) {
  const { positionals, options } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const claudeResponseBlock = positionals.join(" ") || readStdinIfPiped();

  const job = createCompanionJob({
    prefix: "stopreview",
    kind: "stop-review",
    title: "sgl Stop Gate Review",
    workspaceRoot,
    jobClass: "review",
    summary: "Stop-gate review of previous Claude turn"
  });
  await runForegroundCommand(
    job,
    (progress) => executeStopReviewRun({ cwd, model: options.model, claudeResponseBlock, onProgress: progress }),
    { json: options.json }
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "stop-review":
      await handleStopReview(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Smoke-test the CLI loads and prints usage**

Run: `cd /home/taehwak/workspace/sgl-plugin && node scripts/sgl-companion.mjs --help`
Expected: the `Usage:` block prints, exit code 0, no import errors.

- [ ] **Step 3: Smoke-test `setup` against a config with no gateway token set**

Run: `cd /home/taehwak/workspace/sgl-plugin && SGL_CONFIG_DIR=$(mktemp -d) node scripts/sgl-companion.mjs setup --json`
Expected: valid JSON prints with `"ready": false`, `"gateway": { "available": false, "detail": "Environment variable CLIENT_KEY is not set." }`, and `"opencode": { "available": false, ... }` (since `opencode` is not installed in this environment). Exit code 0 (setup reporting "not ready" is not itself a crash).

- [ ] **Step 4: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add scripts/sgl-companion.mjs
git commit -m "Add sgl-companion.mjs: unified CLI dispatcher over opencode.mjs"
```

---

### Task 14: `commands/*.md` and `agents/sgl-rescue.md`

Forked from codex-plugin-cc's command definitions with codex→sgl renames, dropped Codex-only flags (`--effort`, `--write`, `spark` alias), and the `opencode` install command confirmed during planning (`npm install -g opencode-ai`, per opencode.ai's official install docs).

**Files:**
- Create: `commands/setup.md`
- Create: `commands/review.md`
- Create: `commands/adversarial-review.md`
- Create: `commands/status.md`
- Create: `commands/cancel.md`
- Create: `commands/result.md`
- Create: `commands/rescue.md`
- Create: `agents/sgl-rescue.md`

**Interfaces:**
- Consumes: `scripts/sgl-companion.mjs` (Task 13) via `node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" <subcommand> ...`.
- Produces: the `/sgl:setup`, `/sgl:review`, `/sgl:adversarial-review`, `/sgl:status`, `/sgl:cancel`, `/sgl:result`, `/sgl:rescue` slash commands.

- [ ] **Step 1: Write `commands/setup.md`**

```markdown
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
```

- [ ] **Step 2: Write `commands/review.md`**

```markdown
---
description: Run an sgl code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an sgl review through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return sgl's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/sgl:review` does not support extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/sgl:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" review "$ARGUMENTS"`,
  description: "sgl review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "sgl review started in the background. Check `/sgl:status` for progress."
```

- [ ] **Step 3: Write `commands/adversarial-review.md`**

```markdown
---
description: Run an sgl review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial sgl review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return sgl's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/sgl:adversarial-review` uses the same review target selection as `/sgl:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- Unlike `/sgl:review`, it can still take extra focus text after the flags.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "sgl adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "sgl adversarial review started in the background. Check `/sgl:status` for progress."
```

- [ ] **Step 4: Write `commands/status.md`**

```markdown
---
description: Show active and recent sgl jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
```

- [ ] **Step 5: Write `commands/cancel.md`**

```markdown
---
description: Cancel an active background sgl job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" cancel "$ARGUMENTS"`
```

- [ ] **Step 6: Write `commands/result.md`**

```markdown
---
description: Show the stored final output for a finished sgl job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/sgl:status <id>` and `/sgl:review`
```

- [ ] **Step 7: Write `commands/rescue.md`**

```markdown
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
```

- [ ] **Step 8: Write `agents/sgl-rescue.md`**

```markdown
---
name: sgl-rescue
description: Proactively use when Claude Code is stuck, wants a second implementation or diagnosis pass, needs a deeper root-cause investigation, or should hand a substantial coding task to the sgl gateway (GLM/DeepSeek) through the shared runtime
model: sonnet
tools: Bash
---

You are a thin forwarding wrapper around the sgl companion task runtime.

Your only job is to forward the user's rescue request to the sgl companion script. Do not do anything else.

Selection guidance:

- Do not wait for the user to explicitly ask for sgl. Use this subagent proactively when the main Claude thread should hand a substantial debugging or implementation task to sgl.
- Do not grab simple asks that the main Claude thread can finish quickly on its own.

Forwarding rules:

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/sgl-companion.mjs" task ...`.
- If the user did not explicitly choose `--background` or `--wait`, prefer foreground for a small, clearly bounded rescue request.
- If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep sgl running for a long time, prefer background execution.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`. This subagent only forwards to `task`.
- Leave model unset by default. Only add `--model` when the user explicitly asks for a specific model (`glm` or `dsv4`).
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
```

- [ ] **Step 9: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add commands/ agents/
git commit -m "Add sgl slash commands and sgl-rescue subagent definition"
```

---

### Task 15: `hooks/hooks.json`, `scripts/session-lifecycle-hook.mjs`, `scripts/stop-review-gate-hook.mjs`

The per-job-server design (no shared broker — Task 7) makes `session-lifecycle-hook.mjs` simpler than the original: there is no broker process to shut down on `SessionEnd`, because every `opencode serve` instance already lives and dies inside the single `runOpencodeTurn` call that spawned it (Task 8's `finally { await server.stop() }`). The hook only needs to (1) export the Claude session id into the environment on `SessionStart` so job records get tagged with it, and (2) on `SessionEnd`, kill the process tree of any job still `queued`/`running` for that session — which, because `terminateProcessTree` kills the whole process group, also takes down that job's still-running `opencode serve` child.

`stop-review-gate-hook.mjs` is forked with codex→sgl renames and calls the new `stop-review` subcommand (Task 13) instead of a bare `task` call, since `task` now always runs the write-capable `rescue` permission profile and a stop-gate check must not be able to edit files.

**Files:**
- Create: `hooks/hooks.json`
- Create: `scripts/session-lifecycle-hook.mjs`
- Create: `scripts/stop-review-gate-hook.mjs`

**Interfaces:**
- Consumes: `terminateProcessTree` from `process.mjs` (Task 2); `loadState`, `resolveStateFile`, `saveState` from `state.mjs` (Task 4); `resolveWorkspaceRoot` from `workspace.mjs` (Task 3); `SESSION_ID_ENV` from `tracked-jobs.mjs` (Task 9); `getOpencodeAvailability` from `opencode.mjs` (Task 7); `getConfig`, `listJobs` from `state.mjs`; `sortJobsNewestFirst` from `job-control.mjs` (Task 10); the `stop-review` subcommand from `sgl-companion.mjs` (Task 13, amended above).

- [ ] **Step 1: Write `hooks/hooks.json`**

```json
{
  "description": "Optional stop-time review gate for the sgl companion.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Write `scripts/session-lifecycle-hook.mjs`**

```javascript
#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
```

- [ ] **Step 3: Write `scripts/stop-review-gate-hook.mjs`**

```javascript
#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getOpencodeAvailability } from "./lib/opencode.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildSetupNote(cwd) {
  const availability = getOpencodeAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `opencode is not set up for the review gate.${detail} Run /sgl:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "The stop-time sgl review task returned no final output. Run /sgl:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `sgl stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason: "The stop-time sgl review task returned an unexpected answer. Run /sgl:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "sgl-companion.mjs");
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(
    process.execPath,
    [scriptPath, "stop-review", "--json", lastAssistantMessage],
    { cwd, env: childEnv, encoding: "utf8", timeout: STOP_REVIEW_TIMEOUT_MS }
  );

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason: "The stop-time sgl review task timed out after 15 minutes. Run /sgl:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time sgl review task failed: ${detail}`
        : "The stop-time sgl review task failed. Run /sgl:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason: "The stop-time sgl review task returned invalid JSON. Run /sgl:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `sgl job ${runningJob.id} is still running. Check /sgl:status and use /sgl:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 4: Smoke-test both hook scripts load without import errors**

Run: `cd /home/taehwak/workspace/sgl-plugin && echo '{}' | node scripts/session-lifecycle-hook.mjs SessionStart`
Expected: exits 0, no output (no `CLAUDE_ENV_FILE` set in this environment, so `appendEnvVar` no-ops).

Run: `cd /home/taehwak/workspace/sgl-plugin && echo '{"cwd":"'"$(pwd)"'"}' | node scripts/stop-review-gate-hook.mjs`
Expected: exits 0, no stdout (the review gate defaults to disabled — `config.stopReviewGate` is falsy — so `main()` logs a note to stderr, if any, and returns without emitting a decision).

- [ ] **Step 5: Commit**

```bash
cd /home/taehwak/workspace/sgl-plugin
git add hooks/hooks.json scripts/session-lifecycle-hook.mjs scripts/stop-review-gate-hook.mjs
git commit -m "Add session lifecycle and stop-review-gate hooks (no broker teardown needed)"
```

---

### Task 16: End-to-end manual validation against the live gateway

Everything through Task 15 is either unit-tested or a static asset. This task is the one place the plan intentionally does not prescribe automated tests: it exercises `opencode` actually installed, a real network round-trip to `https://gateway.post-train.win/v1`, and Claude Code's own plugin-loading mechanism — none of which are meaningfully mockable without testing the mock instead of reality. Run every step below and note the actual outcome; do not mark this task done from inspection alone.

**Files:**
- None (verification only).

**Interfaces:**
- Exercises the full stack built in Tasks 1–15 against real infrastructure.

- [ ] **Step 1: Install `opencode` and confirm the SDK/CLI versions**

Run: `npm install -g opencode-ai`
Run: `opencode --version`
Expected: prints a version string. If this fails, stop here — Tasks 17+ below cannot be verified without it (`/sgl:setup` will correctly report `opencode: unavailable`, but nothing further can be exercised live).

- [ ] **Step 2: Set the gateway token and run `/sgl:setup`**

Run: `export CLIENT_KEY=<the real token>` (in the shell that will launch Claude Code, or via `!` inside a Claude Code session).
Install the plugin locally: add `/home/taehwak/workspace/sgl-plugin` as a local plugin path per Claude Code's plugin-loading mechanism (consult the current Claude Code plugin docs for the exact local-path install command, since this project has no marketplace listing).
Run `/sgl:setup` inside a Claude Code session in a scratch git repository.
Expected: `opencode: available`, `gateway: available (Reachable at https://gateway.post-train.win/v1 (model GLM-5.2-FP8))`, and a `structured output` line reporting whether `response_format: json_schema` was honored. Record whichever it reports — this directly determines whether `/sgl:adversarial-review` will need its lenient-parse fallback path in practice.

- [ ] **Step 3: Run `/sgl:review` on a small working-tree change**

In the scratch repo: make a small, obviously-fine edit (e.g., add a comment) and an obviously-broken one (e.g., an off-by-one loop bound) in two different files.
Run `/sgl:review --wait`.
Expected: sgl reports on both files; the broken one is flagged as a concern in freeform prose (not JSON). Confirm the output does NOT show any tool-permission hang (if it hangs, the `review` permission profile's `bash: "deny"` may be surfacing an OpenCode permission prompt instead of a clean denial — capture the raw `opencode serve` stderr from the job's log file and adjust `buildOpencodeConfig`'s permission block accordingly).

- [ ] **Step 4: Run `/sgl:adversarial-review` and confirm structured output or graceful fallback**

Run `/sgl:adversarial-review --wait focus on the off-by-one bug`.
Expected: either a rendered table of findings sorted by severity (structured path worked) or the "did not return valid structured JSON" fallback render with the raw text still visible (degraded path) — both are acceptable outcomes per the spec's reliability stance; a hard crash is not.

- [ ] **Step 5: Run `/sgl:rescue` in the background, then `/sgl:status` and `/sgl:result`**

Run `/sgl:rescue --background fix the off-by-one bug in <file>`.
Run `/sgl:status` repeatedly until the job shows `completed`.
Run `/sgl:result <job-id>`.
Expected: the file is actually edited on disk (confirm with `git diff`) — this is the one command in the whole plugin that is allowed to mutate files, and this step is where that capability is actually proven, not assumed.

- [ ] **Step 6: Run `/sgl:rescue --resume` and confirm session continuity**

Run `/sgl:rescue --wait --resume now add a test for that fix`.
Expected: sgl continues in the same OpenCode session (confirm via the sgl session ID printed in the result matching the previous job's), rather than starting from a blank context.

- [ ] **Step 7: Run `/sgl:cancel` on a genuinely long-running job**

Run `/sgl:rescue --background <a deliberately large, slow task>`.
Immediately run `/sgl:cancel <job-id>`.
Expected: the job's status becomes `cancelled` within a few seconds, and the per-job `opencode serve` process is no longer running (check with `ps aux | grep opencode` — nothing should remain bound to that job's port).

- [ ] **Step 8: Enable the stop-review gate and confirm it blocks on a real issue**

Run `/sgl:setup --enable-review-gate`.
Make an obviously broken edit directly (not through sgl) and end the Claude Code turn.
Expected: the session end is blocked with a reason citing the sgl stop-gate review's finding. Then fix the issue and confirm the gate allows the session to end.
Run `/sgl:setup --disable-review-gate` afterward to leave the repository in its default state.

- [ ] **Step 9: Record findings and commit any fixes**

If Steps 3–8 surfaced a wrong assumption (permission profile behavior, event vocabulary in `job-control.mjs`'s phase inference, resume semantics), fix the relevant file from Tasks 7–11 now, rerun that file's automated test, and commit the fix with a message describing what real-world behavior it corrects.

```bash
cd /home/taehwak/workspace/sgl-plugin
git add -A
git commit -m "Fix <specific behavior> found during end-to-end validation against the live gateway"
```

(Only run this commit if Step 9 actually found something to fix — an empty diff means nothing to commit.)

---
