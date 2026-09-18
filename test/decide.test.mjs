// Offline tests for the policy mapping. No API key and no network required:
// these cover `decide()`, which turns a Jev classification into a route.
import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../route.js";

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
