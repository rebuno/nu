import { existsSync, readFileSync } from "node:fs";

import { Type } from "@earendil-works/pi-ai";

import { POLICY_PATH } from "../../config.js";
import { gateway } from "./gateway.js";
import { anyTool, text } from "./tool.js";

export const policyRead = anyTool({
  name: "policy_read",
  label: "Read policy",
  description:
    "Read the user's policy rules, in order, as YAML. Read them before changing policy with policy_update.",
  parameters: Type.Object({}),
  execute: async () =>
    text(
      existsSync(POLICY_PATH) ? readFileSync(POLICY_PATH, "utf8") : "rules: []",
    ),
});

export const policyUpdate = anyTool({
  name: "policy_update",
  label: "Update policy",
  description:
    "Change the user's policy rules, for a change the user asked for. Read the current rules with policy_read first. Each change adds a rule, replaces the rule with an id, or removes it. Rules are evaluated top to bottom and the first match decides; a model-call rule is always first and a rule requiring approval for every tool call is always last. An allow rule names exact targets. The user approves the change after a readback. A rule is YAML with id, when, and then. when holds target (a tool name) or targets (a list), and arguments: a map of argument name to constraints (equals, contains, one_of, or regex), all of which must pass; values compare as strings. then holds decision (allow, deny, or require_approval) and optionally reason. Example: {id: work-notes, when: {target: notes__read, arguments: {folder: {equals: work}}}, then: {decision: allow}}. The policy skill covers history conditions, rate limits, and approval options.",
  parameters: Type.Object({
    changes: Type.Array(
      Type.Object({
        op: Type.Union([
          Type.Literal("add"),
          Type.Literal("replace"),
          Type.Literal("remove"),
        ]),
        id: Type.Optional(
          Type.String({ description: "The rule to replace or remove" }),
        ),
        rule: Type.Optional(
          Type.String({
            description: "The new rule as YAML, for add and replace",
          }),
        ),
        before: Type.Optional(
          Type.String({
            description:
              "For add: the rule to insert it before. Without it, the rule goes last.",
          }),
        ),
      }),
    ),
    reason: Type.String(),
  }),
  execute: async () => {
    await gateway("/internal/policy_update");
    return text("Policy updated.");
  },
});
