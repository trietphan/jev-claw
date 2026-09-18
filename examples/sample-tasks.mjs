// Live evaluation against the real Jev model. Requires TYPESAFE_API_KEY.
// Usage: node examples/sample-tasks.mjs
import { jevRoute } from "../route.js";

const cases = [
  ["fix typo in README install section", {}, "cheap"],
  ["rename variable `cnt` to `count` in utils/format.ts", { changed_files: ["utils/format.ts"] }, "cheap"],
  ["add CSV export endpoint to the reports service with pagination and tests", { changed_files: ["api/reports.ts"] }, "main"],
  ["redesign the multi-tenant data model and split billing into its own service", {}, "architect"],
  ["build the full onboarding wizard UI with 5 steps, animations and responsive layout", {}, "claude-builder"],
  ["intermittent race condition: websocket reconnect drops messages", { previous_attempts: 0, test_status: "failing" }, "debugger"],
  ["same websocket race bug, two debugger rounds found nothing", { previous_attempts: 2, test_status: "failing" }, "claude-critic"],
  ["same bug, five serious attempts, Sol and Opus disagree, still failing", { previous_attempts: 5, test_status: "failing" }, "frontier"],
  ["review this PR that changes JWT validation and role checks", { changed_files: ["src/auth/jwt.ts"] }, "reviewer"],
  ["add a column to the invoices table and backfill existing rows", { changed_files: ["db/migrations/0042_invoices.sql"] }, "main"],
];

let ok = 0;
for (const [task, extra, want] of cases) {
  const r = await jevRoute({ task, ...extra });
  const pass = r.route === want;
  if (pass) ok++;
  const second = r.second_opinion_route ? ` +${r.second_opinion_route}` : "";
  console.log(
    `${pass ? "PASS" : "FAIL"}  want=${want.padEnd(14)} got=${(r.route + second).padEnd(28)}` +
      `${r.task_type}/${r.complexity}/${r.risk} conf=${r.confidence}  ${task.slice(0, 50)}`,
  );
}
console.log(`\n${ok}/${cases.length} routed as expected`);
process.exit(ok === cases.length ? 0 : 1);
