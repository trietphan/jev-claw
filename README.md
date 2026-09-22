# jev-claw

**Typed model routing for [OpenClaw](https://docs.openclaw.ai) agents, powered by [TypeSafe Jev](https://typesafe.ai).**

`jev-claw` adds one tool — `jev_route` — that answers a question every multi-model agent setup runs into:

> *This task just arrived. Which model should actually do it?*

Not with a prompt that asks an LLM to "think about which model is best", and not with a static
`if (task.includes("refactor"))` rule. It classifies the task with a small typed-decision model,
then applies your routing policy as ordinary code.

Version 1.1 also offers **opt-in automatic routing**. A bounded local prefilter skips casual,
writing-only and deterministic turns. For meaningful software-engineering prompts, a typed hook
calls Jev once, adds a host-generated routing decision to that turn, and can enforce the decision
when the agent delegates through `sessions_spawn`.

```jsonc
// jev_route({ task: "same websocket race bug, two debugger rounds found nothing",
//             previous_attempts: 2, test_status: "failing" })
{
  "task_type": "debugging",
  "complexity": "high",
  "risk": "medium",
  "route": "claude-critic",
  "needs_second_opinion": false,
  "second_opinion_route": null,
  "confidence": 0.54,
  "reasons": ["Sol High debugger stuck; escalate to independent Opus analysis"]
}
```

---

## Why this exists

If you run more than one model, you have a routing problem. The usual answers are all bad:

| Approach | Problem |
| --- | --- |
| Always use the best model | Burns money and latency on typos |
| Always use the cheap model | Cheap models quietly wreck auth and migrations |
| Keyword rules | "refactor the login flow" and "refactor this helper" are not the same task |
| Ask an LLM which model to use | Expensive, slow, non-deterministic, and unauditable |

Routing is a **classification** problem, not a generation problem. It needs a fixed set of
answers, a probability for each, and the same answer twice for the same input. That is exactly
what TypeSafe's System One model (Jev) is built for: typed choices, scores and probabilities
rather than free text.

So `jev-claw` splits the job in two:

- **Jev classifies.** What kind of task is this? How complex? How risky? Would a second opinion help?
- **Your code decides.** Classification plus attempt history maps to a route through plain,
  testable JavaScript.

The escalation rules — never start a hard bug at your most expensive model, never let the cheap
tier touch authentication — live in code, where they can be unit tested offline. The model never
gets to skip them.

---

## How it works

```
        task, changed_files, diff_summary,
        previous_attempts, test_status
                    │
                    ▼
        ┌───────────────────────┐
        │   Jev (TypeSafe)      │   typed classification, ~0.3-1s
        │   task_type           │
        │   complexity          │
        │   risk                │
        │   second_opinion      │
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   decide()            │   pure function, no network
        │   policy + escalation │   11 offline unit tests
        └───────────┬───────────┘
                    │
                    ▼
      route + second_opinion_route + reasons
```

`decide()` is exported separately, so you can fork the policy without touching the model call —
and test your fork with no API key.

---

## Install

```bash
openclaw plugins install clawhub:trietphan/jev-claw --accept-capabilities
openclaw gateway restart
```

From a local checkout:

```bash
openclaw plugins install ./jev-claw --force --accept-capabilities
openclaw gateway restart
```

Verify:

```bash
openclaw plugins inspect jev-claw --runtime --json   # status: loaded, toolNames: ["jev_route"]
```

> Plugin tools are exposed to sessions on the OpenClaw runtime. Sessions running a CLI backend
> (`claude-cli`, `codex`) do not receive plugin tools.

### Requirements

- OpenClaw `>= 2026.9.0`, Node 24+
- A TypeSafe API key in `TYPESAFE_API_KEY`, or at `~/.config/typesafe/api_key`

---

## The tool

**Input**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `task` | `string` | yes | Plain-language description of the work |
| `changed_files` | `string[]` | no | Drives the sensitive-path risk floor |
| `diff_summary` | `string` | no | Extra context for classification |
| `previous_attempts` | `integer` | no | How many times this was already attempted; drives escalation |
| `test_status` | `string` | no | Free text, e.g. `"failing"`, `"2 red in ws.test.ts"` |

**Output**

| Field | Type | Values |
| --- | --- | --- |
| `task_type` | `string` | `trivial` · `implementation` · `frontend` · `architecture` · `refactor` · `debugging` · `review` · `security` |
| `complexity` | `string` | `low` · `medium` · `high` |
| `risk` | `string` | `low` · `medium` · `high` · `critical` |
| `route` | `string` | `cheap` · `main` · `architect` · `debugger` · `reviewer` · `claude-builder` · `claude-critic` · `frontier` |
| `needs_second_opinion` | `boolean` | |
| `second_opinion_route` | `string \| null` | Never equal to `route` |
| `confidence` | `number` | Lowest probability across the three classifications |
| `reasons` | `string[]` | Why this route was chosen |

---

## The default policy

The bundled policy assumes an eight-agent setup. Rename the routes in `route.js` to match your own.

| Route | Used for |
| --- | --- |
| `cheap` | Isolated, low-risk, small changes with no architectural impact |
| `main` | Normal implementation — the default, not a fallback |
| `architect` | System design, data-model and service-boundary changes, large refactors |
| `debugger` | First stop for hard bugs |
| `reviewer` | Deep code review |
| `claude-builder` | Substantial frontend work, independent second implementations |
| `claude-critic` | Independent reviewer and challenger |
| `frontier` | Escalation only |

### Rules that are code, not vibes

**Debugging escalates in a fixed order.** A hard bug starts at `debugger`. After two failed
attempts it goes to `claude-critic` for independent analysis. It reaches `frontier` only after
serious attempts *and* a still-failing signal — a passing test suite pulls it back down. You
cannot start at the frontier model by accident, however dramatic the bug report sounds.

**The cheap tier cannot touch dangerous code.** If risk lands at `high` or `critical`, a `cheap`
route is upgraded and a second opinion is attached. Risk is also floored at `high` whenever
`changed_files` matches a sensitive path:

```
auth · permission · rbac · tenant · migration · billing · payment · stripe
secret · credential · token · .env · infra · terraform · deploy
```

That floor is deliberately dumb regex on top of the model. If Jev under-rates a migration,
the path check still catches it. Defence in depth beats trusting one classifier.

**No agent reviews itself.** `second_opinion_route` is never the same as `route`.

**Architecture always gets challenged.** Architecture decisions carry a `claude-critic`
second opinion by default, because they are the expensive ones to get wrong.

---

## Using it from an agent

Add the policy to your `AGENTS.md` so the agent knows to call the tool:

```markdown
## Model Routing Policy
For meaningful software-engineering tasks, classify the task before delegating.
When the `jev_route` tool is available, use it for routing decisions.
Do not delegate merely because another model exists.
```

Then the agent calls `jev_route` before it spawns anything, and delegates to the returned route.
The `reasons` array is worth surfacing in your logs — it makes routing decisions reviewable after
the fact instead of being an opaque vibe.

## Automatic routing (opt in)

Automatic routing is disabled by default because `before_prompt_build` must read the current
prompt and sends qualifying task text to TypeSafe. Enable it explicitly:

```jsonc
{
  "plugins": {
    "entries": {
      "jev-claw": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        },
        "config": {
          "autoRoute": {
            "enabled": true,
            "mode": "guidance",
            "timeoutMs": 2500,
            "cacheTtlMs": 120000,
            "minConfidence": 0.65,
            "fallbackRoute": "main"
          }
        }
      }
    }
  }
}
```

Restart the Gateway after changing plugin configuration.

### Modes

- `guidance` (recommended first): injects the typed decision into host policy context. It never
  blocks a tool call.
- `enforce`: also blocks a `sessions_spawn` call that explicitly chooses a different `agentId`,
  but only when the Jev decision meets `minConfidence`. Missing, timed-out, failed, fallback and
  low-confidence decisions fail open.

The hook never runs for obvious greetings, writing-only requests, simple status/read/run commands,
or prompts without both an engineering action and software context. The prefilter is intentionally
conservative: false negatives cost one manual `jev_route` call; false positives send unrelated
conversation text to an external service.

### Safety and privacy

- Raw prompts are never written to the plugin cache or warning logs; the cache key is a truncated
  SHA-256 digest and expires after `cacheTtlMs`.
- Prompt text is sent only to TypeSafe when the local prefilter matches.
- Injected context contains only the typed decision, never the original prompt or TypeSafe error
  body, and labels itself as host-generated policy context.
- The hook grants no tools, permissions or authority.
- A TypeSafe outage falls back to `fallbackRoute` guidance and never blocks delegation.
- Automatic routing applies only on OpenClaw runtimes that execute typed plugin hooks. The
  standalone `jev_route` tool remains available independently.

Start with `guidance`, inspect routing quality, then opt into `enforce` after your route names match
real OpenClaw agent IDs. In enforce mode, an omitted `sessions_spawn.agentId` is left alone so the
host's normal default-agent policy remains authoritative.

---

## Testing

```bash
npm test        # offline policy + automatic-hook tests, no API key, no network
npm run eval    # 10 real tasks against live Jev, needs TYPESAFE_API_KEY
```

The offline suite covers the escalation ladder, the cheap-tier guard rails and the
self-review rule. Fork the policy, run `npm test`, and you will know immediately if you broke an
escalation rule.

The live eval currently routes **10/10** sample tasks as expected:

| Task | Route |
| --- | --- |
| Fix typo in README | `cheap` |
| Rename a local variable | `cheap` |
| Add CSV export endpoint with pagination | `main` |
| Redesign multi-tenant data model | `architect` + `claude-critic` |
| Build 5-step onboarding wizard UI | `claude-builder` |
| Intermittent websocket race, first attempt | `debugger` |
| Same bug after two debugger rounds | `claude-critic` |
| Same bug after five attempts, still failing | `frontier` |
| Review a JWT validation change | `reviewer` + `claude-critic` |
| Add a column and backfill invoices | `main` + `reviewer` |

Note the last row: a one-column migration is *low complexity* and still gets a reviewer, because
complexity and risk are scored separately. That distinction is most of the value here.

---

## Customising

Everything you are likely to change lives in `route.js`:

- `QUESTIONS` — the classification taxonomy sent to Jev
- `SENSITIVE_PATH` — the regex that floors risk
- `decide()` — the policy mapping, a pure function

`index.js` is only the OpenClaw tool registration and is unlikely to need edits.

---

## Design notes

**Why not let the model pick the route directly?** Because then the escalation rules are a
suggestion. Keeping `route` out of the model's hands means "never start at the frontier model"
is enforced by an `if`, not hoped for in a prompt.

**Why is `confidence` the minimum, not the average?** A routing decision is only as trustworthy as
its weakest classification. Averaging would hide a coin-flip risk score behind a confident task
type. Treat anything under ~0.5 as worth a human glance.

**Why both a model and a regex for risk?** They fail differently. The model understands
"disable the tenant check for debugging"; the regex catches a migration file the model skimmed.
Taking the maximum of the two costs nothing and removes a whole class of quiet failure.

---

## Contributing

Issues and PRs welcome. If you change `decide()`, add a test to `test/decide.test.mjs` — it runs
offline, so there is no excuse not to.

## License

MIT
