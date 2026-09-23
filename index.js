import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jevRoute } from "./route.js";
import { createAutomaticRouter, normalizeAutoRouteConfig } from "./auto-route.js";

const ROUTES = ["cheap", "main", "architect", "debugger", "reviewer", "claude-builder", "claude-critic", "frontier"];

export default definePluginEntry({
  id: "jev-claw",
  name: "Jev Claw",
  description: "Typed model-routing decisions from TypeSafe Jev",
  register(api) {
    const autoRouteConfig = normalizeAutoRouteConfig(api.pluginConfig);
    const automaticRouter = createAutomaticRouter({ api });

    api.registerTool({
      name: "jev_route",
      description:
        "Classify a software-engineering task (type, complexity, risk) and return the recommended agent route per the Model Routing Policy. Call before delegating meaningful work.",
      parameters: Type.Object({
        task: Type.String(),
        changed_files: Type.Optional(Type.Array(Type.String())),
        diff_summary: Type.Optional(Type.String()),
        previous_attempts: Type.Optional(Type.Integer({ minimum: 0 })),
        test_status: Type.Optional(Type.String()),
      }),
      outputSchema: Type.Object({
        task_type: Type.String(),
        complexity: Type.String(),
        risk: Type.String(),
        route: Type.Union(ROUTES.map((r) => Type.Literal(r))),
        needs_second_opinion: Type.Boolean(),
        second_opinion_route: Type.Union([Type.String(), Type.Null()]),
        confidence: Type.Number(),
        reasons: Type.Array(Type.String()),
      }),
      async execute(_id, params) {
        const details = await jevRoute(params);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    });

    // Register the complete capability surface even when auto-routing is off.
    // The installer discovers accepted hooks with default config; conditionally
    // registering here would make later opt-in config unable to activate them.
    api.on(
      "before_prompt_build",
      (event, ctx) => automaticRouter.beforePromptBuild(event, ctx, autoRouteConfig),
      { timeoutMs: Math.min(15000, autoRouteConfig.timeoutMs + 500) },
    );
    api.on(
      "before_tool_call",
      (event, ctx) => automaticRouter.beforeToolCall(event, ctx, autoRouteConfig),
      { matcher: ["sessions_spawn"], priority: 50 },
    );
  },
});
