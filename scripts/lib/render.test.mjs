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
  assert.match(output, /# selfhost Adversarial Review/);
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
  assert.match(output, /# selfhost Review/);
  assert.match(output, /Looks safe to ship\./);
});

test("renderStoredJobResult points the resume hint at /selfhost:rescue --resume", () => {
  const output = renderStoredJobResult(
    { id: "task-1", status: "completed", threadId: "session-abc" },
    { threadId: "session-abc", rendered: "All done." }
  );
  assert.match(output, /selfhost session ID: session-abc/);
  assert.match(output, /Resume: \/selfhost:rescue --resume/);
});

test("renderCancelReport points at /selfhost:status", () => {
  const output = renderCancelReport({ id: "task-2", title: "Test job" });
  assert.match(output, /# selfhost Cancel/);
  assert.match(output, /\/selfhost:status/);
});
