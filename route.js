// Pure routing logic + Jev call. Jev classifies; code maps classification -> route (policy in AGENTS.md).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RISK_ORDER = ["low", "medium", "high", "critical"];
const SENSITIVE_PATH = /(auth|permission|rbac|tenant|migration|billing|payment|stripe|secret|credential|token|\.env|infra|terraform|deploy)/i;

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  return readFileSync(join(homedir(), ".config/typesafe/api_key"), "utf8").trim();
}

const QUESTIONS = {
  task_type: {
    type: "choice",
    instructions:
      "What kind of software-engineering work is `task`? Pick the dominant one. Use `security` when the main concern is authentication, authorization, secrets, tenant isolation or vulnerabilities.",
    criteria: {
      trivial: "A tiny, isolated change: typo, rename, copy/config tweak, one-line fix, formatting.",
      implementation: "Building or changing backend/general feature logic.",
      frontend: "Substantial UI/frontend implementation or styling.",
      architecture: "System design, data-model or service-boundary change, workflow redesign.",
      refactor: "Restructuring existing code without changing behavior, especially large or cross-cutting.",
      debugging: "Diagnosing or fixing a bug, failing test, or unexpected behavior.",
      review: "Reviewing or auditing existing code or a diff/PR.",
      security: "Authentication, authorization, secrets, tenant isolation, vulnerability work.",
    },
  },
  complexity: {
    type: "choice",
    instructions: "How complex is the work in `task`, considering scope, files touched and unknowns?",
    criteria: {
      low: "Small, well-understood, a few lines or one file.",
      medium: "Several files or some design decisions, but familiar ground.",
      high: "Cross-cutting, many unknowns, or large scope.",
    },
  },
  risk: {
    type: "choice",
    instructions:
      "How risky is a mistake in `task`? Consider data loss, security, money, production impact and external side effects.",
    criteria: {
      low: "Easily reversible, no sensitive area.",
      medium: "Moderate blast radius, reversible with effort.",
      high: "Touches auth, permissions, migrations, payments, secrets, tenant isolation or production infra.",
      critical: "Could cause data loss, security breach, financial loss or irreversible external side effects.",
    },
  },
  second_opinion: {
    type: "noul",
    instructions:
      "Would an independent second opinion materially reduce the chance of a costly mistake for `task`? Yes for high-impact design or risky changes; no for routine work.",
  },
};

export async function askJev(state, { fetchImpl = fetch, timeoutMs = 20000, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions: QUESTIONS }),
    signal: requestSignal,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body).answers;
}

const maxRisk = (a, b) => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);
const top = (probs, key) => (probs && typeof probs[key] === "number" ? probs[key] : 1);

// Map typed classification + attempt history to a route. Order encodes the policy's escalation rules.
export function decide({ task_type, complexity, risk, second_opinion, previous_attempts = 0, test_status }) {
  const reasons = [];
  let route = "main";
  let second = null;
  const highRisk = RISK_ORDER.indexOf(risk) >= 2;
  const failing = /fail|red|error/i.test(test_status ?? "");

  if (task_type === "debugging") {
    if (previous_attempts >= 4 && failing) {
      route = "frontier";
      reasons.push("debugging unresolved after serious attempts; Sol High and Opus already tried");
    } else if (previous_attempts >= 2) {
      route = "claude-critic";
      reasons.push("Sol High debugger stuck; escalate to independent Opus analysis");
    } else {
      route = "debugger";
      reasons.push("debugging starts with Sol High debugger; never start with Astra");
    }
  } else if (task_type === "architecture" || (task_type === "refactor" && complexity === "high")) {
    route = "architect";
    reasons.push("architecture / large refactor -> Sol High architect");
    if (highRisk || second_opinion || task_type === "architecture") second = "claude-critic";
  } else if (task_type === "review" || task_type === "security") {
    route = "reviewer";
    reasons.push("deep review -> reviewer");
    if (highRisk || task_type === "security") second = "claude-critic";
  } else if (task_type === "frontend" && complexity !== "low") {
    route = "claude-builder";
    reasons.push("substantial frontend -> claude-builder");
  } else if (
    !highRisk &&
    complexity === "low" &&
    (task_type === "trivial" || task_type === "implementation" || task_type === "frontend")
  ) {
    route = "cheap";
    reasons.push("isolated, low-risk, small change -> cheap");
  } else {
    route = "main";
    reasons.push("normal implementation stays on main (Sol Medium)");
    if (highRisk) second = "reviewer";
  }
  if (highRisk && !second && route !== "cheap") second = "claude-critic";
  if (highRisk && route === "cheap") {
    route = "main";
    reasons.push("cheap disallowed for high-risk work");
  }
  if (second === route) second = null; // an agent cannot be its own second opinion
  if (highRisk) reasons.push(`risk=${risk}: second opinion required`);
  return { route, second_opinion_route: second, needs_second_opinion: second !== null, reasons };
}

export async function jevRoute(
  { task, changed_files = [], diff_summary, previous_attempts = 0, test_status },
  { ask = askJev, timeoutMs, signal } = {},
) {
  const state = { task, changed_files, diff_summary, previous_attempts, test_status };
  const a = await ask(state, { timeoutMs, signal });
  let risk = a.risk.choice;
  const hits = changed_files.filter((f) => SENSITIVE_PATH.test(f));
  const riskFloor = hits.length > 0 && RISK_ORDER.indexOf(risk) < 2;
  if (riskFloor) risk = "high";
  const cls = {
    task_type: a.task_type.choice,
    complexity: a.complexity.choice,
    risk,
    second_opinion: a.second_opinion.noul >= 0.5,
    previous_attempts,
    test_status,
  };
  const d = decide(cls);
  if (riskFloor) d.reasons.push(`risk raised to high: sensitive paths ${hits.slice(0, 3).join(", ")}`);
  const confidence = Math.min(
    top(a.task_type.probabilities, cls.task_type),
    top(a.complexity.probabilities, cls.complexity),
    top(a.risk.probabilities, a.risk.choice),
  );
  return {
    task_type: cls.task_type,
    complexity: cls.complexity,
    risk,
    route: d.route,
    needs_second_opinion: d.needs_second_opinion || cls.second_opinion,
    second_opinion_route:
      d.second_opinion_route ?? (cls.second_opinion && d.route !== "claude-critic" ? "claude-critic" : null),
    confidence: Number(confidence.toFixed(3)),
    reasons: d.reasons,
  };
}
