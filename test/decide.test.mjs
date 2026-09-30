// Offline tests for the policy mapping. No API key and no network required:
// these cover `decide()`, which turns a Jev classification into a route.
import test from "node:test";
import assert from "node:assert/strict";
import { decide, jevRoute } from "../route.js";

const base = { task_type: "implementation", complexity: "low", risk: "low", second_opinion: false };
const at = (over) => decide({ ...base, ...over });

test("small isolated work goes to cheap", () => {
  assert.equal(at({ task_type: "trivial" }).route, "cheap");
  assert.equal(at({}).route, "cheap");
});

test("cheap is never used for high-risk work", () => {
  const r = at({ task_type: "trivial", risk: "high" });
  assert.notEqual(r.route, "cheap");
  assert.equal(r.needs_second_opinion, true);
});

test("noncanonical and unknown Jev risk labels never downgrade to cheap", async () => {
  for (const label of ["High", " Critical ", "high-risk", null]) {
    const answer = {
      task_type: { choice: "implementation", probabilities: { implementation: 0.9 } },
      complexity: { choice: "low", probabilities: { low: 0.9 } },
      risk: { choice: label, probabilities: { [label]: 0.9 } },
      second_opinion: { noul: 0 },
    };
    const result = await jevRoute({ task: "Rotate tenant auth secrets" }, { ask: async () => answer });
    assert.notEqual(result.route, "cheap", label);
    assert.equal(result.needs_second_opinion, true, label);
    assert.ok(["high", "critical"].includes(result.risk), label);
    if (label === "high-risk" || label === null) assert.equal(result.confidence, 0, label);
  }
  assert.notEqual(at({ risk: "Critical" }).route, "cheap");
});

test("missing or invalid Jev probabilities cannot enable confident enforcement", async () => {
  for (const probabilities of [undefined, { implementation: 1.5 }, { implementation: NaN }]) {
    const result = await jevRoute({ task: "Update checkout API" }, { ask: async () => ({
      task_type: { choice: "implementation", probabilities },
      complexity: { choice: "low", probabilities: { low: 0.9 } },
      risk: { choice: "low", probabilities: { low: 0.9 } },
      second_opinion: { noul: 0 },
    }) });
    assert.equal(result.confidence, 0);
  }
});

test("unknown task and complexity choices also fail confidence open", async () => {
  for (const field of ["task_type", "complexity"]) {
    const answers = {
      task_type: { choice: "implementation", probabilities: { implementation: 0.9 } },
      complexity: { choice: "low", probabilities: { low: 0.9 } },
      risk: { choice: "low", probabilities: { low: 0.9 } },
      second_opinion: { noul: 0 },
    };
    answers[field] = { choice: "unknown", probabilities: { unknown: 0.9 } };
    const result = await jevRoute({ task: "Update checkout API" }, { ask: async () => answers });
    assert.equal(result.confidence, 0, field);
  }
});

test("normal implementation stays on main", () => {
  assert.equal(at({ complexity: "medium" }).route, "main");
});

test("architecture goes to architect with an independent critic", () => {
  const r = at({ task_type: "architecture", complexity: "high" });
  assert.equal(r.route, "architect");
  assert.equal(r.second_opinion_route, "claude-critic");
});

test("only large refactors escalate to architect", () => {
  assert.equal(at({ task_type: "refactor", complexity: "high" }).route, "architect");
  assert.equal(at({ task_type: "refactor", complexity: "medium" }).route, "main");
});

test("substantial frontend goes to claude-builder", () => {
  assert.equal(at({ task_type: "frontend", complexity: "medium" }).route, "claude-builder");
  assert.equal(at({ task_type: "frontend", complexity: "low" }).route, "cheap");
});

test("debugging escalates in order and never starts at frontier", () => {
  const first = at({ task_type: "debugging", previous_attempts: 0 });
  assert.equal(first.route, "debugger");
  assert.equal(at({ task_type: "debugging", previous_attempts: 2 }).route, "claude-critic");
  const last = at({ task_type: "debugging", previous_attempts: 5, test_status: "failing" });
  assert.equal(last.route, "frontier");
});

test("frontier needs both exhausted attempts and a failing signal", () => {
  assert.equal(at({ task_type: "debugging", previous_attempts: 5, test_status: "passing" }).route, "claude-critic");
});

test("security and high-risk review pull in a second reviewer", () => {
  const r = at({ task_type: "security", risk: "high" });
  assert.equal(r.route, "reviewer");
  assert.equal(r.second_opinion_route, "claude-critic");
});

test("every decision explains itself", () => {
  for (const t of ["trivial", "implementation", "frontend", "architecture", "refactor", "debugging", "review", "security"]) {
    const r = at({ task_type: t });
    assert.ok(r.reasons.length > 0, `${t} produced no reasons`);
  }
});

test("an agent is never its own second opinion", () => {
  const r = at({ task_type: "debugging", previous_attempts: 2, risk: "high" });
  assert.equal(r.route, "claude-critic");
  assert.notEqual(r.second_opinion_route, "claude-critic");
});
