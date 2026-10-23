import { matchesGlob } from "node:path";

import { parse } from "yaml";

import { assemble } from "./bundle.js";

export type Rule = {
  id: string;
  when?: {
    target?: string;
    targets?: string[];
    step_kind?: string;
    arguments?: Record<string, Record<string, unknown>>;
  };
  then?: { decision?: string };
};

export type RuleEdit = {
  op: "add" | "replace" | "remove";
  id?: string;
  rule?: string;
  before?: string;
};

export function applyEdits(current: Rule[], edits: RuleEdit[]) {
  const rules = [...current];
  const at = (id: string | undefined) => {
    const index = rules.findIndex((rule) => rule.id === id);
    if (index < 0) throw new Error(`no rule ${id}`);
    return index;
  };
  const ruleOf = (edit: RuleEdit) => {
    if (!edit.rule) throw new Error(`${edit.op} needs a rule`);
    return parse(edit.rule) as Rule;
  };
  for (const edit of edits)
    switch (edit.op) {
      case "add":
        rules.splice(
          edit.before ? at(edit.before) : rules.length,
          0,
          ruleOf(edit),
        );
        break;
      case "replace":
        rules.splice(at(edit.id), 1, ruleOf(edit));
        break;
      case "remove":
        rules.splice(at(edit.id), 1);
        break;
      default:
        throw new Error(`unknown change ${edit.op}`);
    }
  return rules;
}

type TestResult = {
  name?: string;
  step_id?: string;
  target: string;
  args?: unknown;
  decision: string;
  rule_id: string;
  pass: boolean;
};

type Post = (
  path: string,
  body: unknown,
) => Promise<{ results?: TestResult[] }>;

export const RESERVED = new Set(["allow-llm", "handoff", "ask"]);
const DECISIONS: Record<string, string> = {
  allow: "run without asking",
  require_approval: "ask first",
  deny: "never run",
};

const targetsOf = (rule: Rule) =>
  rule.when?.target ? [rule.when.target] : (rule.when?.targets ?? []);

export function describe(rule: Rule) {
  const where = Object.entries(rule.when?.arguments ?? {})
    .flatMap(([arg, predicate]) =>
      Object.entries(predicate).map(
        ([op, value]) =>
          `${arg} ${op.replace("_", " ")} ${JSON.stringify(value)}`,
      ),
    )
    .join(" and ");
  const subject =
    targetsOf(rule)
      .map((target) => `\`${target}\``)
      .join(", ") ||
    rule.when?.step_kind ||
    "any step";
  const decision = DECISIONS[rule.then?.decision ?? ""] ?? rule.then?.decision;
  return `${subject}${where ? ` where ${where}` : ""}: ${decision}`;
}

const readback = (rule: Rule) => `${describe(rule)} (${rule.id})`;

export const POLICY_DEFAULTS =
  "Model calls run without asking; any other tool call asks for approval.";

export const policyView = (rules: Rule[]) =>
  [...rules.map((rule) => `• ${readback(rule)}`), POLICY_DEFAULTS].join("\n");

export function invariants(rules: Rule[]) {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (typeof rule?.id !== "string" || !rule.id)
      throw new Error("every rule needs an id");
    if (RESERVED.has(rule.id) || ids.has(rule.id))
      throw new Error(`rule id ${rule.id} is reserved or repeated`);
    ids.add(rule.id);
    if (rule.then?.decision !== "allow") continue;
    const targets = targetsOf(rule);
    if (!targets.length)
      throw new Error(`${rule.id}: an allow rule must name its targets`);
    const extensions = rule.when?.arguments?.extensions?.equals;
    if (
      targets.some((target) => matchesGlob("package_write", target)) &&
      extensions !== false &&
      extensions !== "false"
    )
      throw new Error(
        `${rule.id}: an allow rule on package_write needs extensions: {equals: false}`,
      );
  }
}

// A case built from a rule's own conditions, when they determine one.
function probe(rule: Rule) {
  const [target] = targetsOf(rule);
  if (!target || (rule.when?.step_kind ?? "tool_call") !== "tool_call")
    return [];
  const args: Record<string, unknown> = {};
  for (const [arg, predicate] of Object.entries(rule.when?.arguments ?? {})) {
    if (!("equals" in predicate)) return [];
    args[arg] = predicate.equals;
  }
  return [{ name: rule.id, target, args }];
}

export async function checkRules(
  post: Post,
  agentId: string,
  current: Rule[],
  proposed: unknown,
  replay = true,
) {
  if (!Array.isArray(proposed)) throw new Error("rules must be a list");
  const rules = proposed as Rule[];
  invariants(rules);
  const bundle = assemble(rules);
  const before = new Map(current.map((r) => [r.id, JSON.stringify(r)]));
  const touched = rules.filter((r) => before.get(r.id) !== JSON.stringify(r));

  const probes = touched.flatMap(probe);
  const { results = [] } = await post(`/v0/policies/${agentId}/test`, {
    bundle,
    cases: probes,
  });
  for (const result of results)
    if (result.rule_id !== result.name)
      throw new Error(`${result.name} is shadowed by ${result.rule_id}`);

  const changed = replay
    ? await replayChanges(post, agentId, current, bundle)
    : [];
  const ids = new Set(rules.map((r) => r.id));
  return {
    readback: [
      ...touched.map(readback),
      ...current
        .filter((r) => !ids.has(r.id))
        .map((r) => `Removed: ${readback(r)}`),
    ],
    changed,
  };
}

async function replayChanges(
  post: Post,
  agentId: string,
  current: Rule[],
  bundle: string,
) {
  const test = (b: string) =>
    post(`/v0/policies/${agentId}/test`, { bundle: b, executions: {} });
  const previous = await test(assemble(current));
  const after = await test(bundle);
  const decided = new Map(
    (previous.results ?? []).map((r) => [r.step_id, r.decision]),
  );
  return (after.results ?? [])
    .filter((r) => decided.get(r.step_id) !== r.decision)
    .map(
      (r) =>
        `${r.target} ${JSON.stringify(r.args ?? {}).slice(0, 120)}: now ${r.decision} by ${r.rule_id}`,
    );
}
