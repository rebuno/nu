import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import { DATA_DIR } from "./config.js";

export type Specialist = {
  name: string;
  instructions: string;
  tools: string[];
  memory_scope: string;
  rules: unknown[];
  model?: string;
};

const DIR = join(DATA_DIR, "specialists");
const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const MAIN_ONLY = new Set(["delegate", "specialist_write", "policy_update"]);

const DEFAULT_RULES = parse(`
- id: reads
  when:
    targets: [memory_search, schedule_list, browser_observe]
  then:
    decision: allow
- id: own-state
  when:
    targets: [memory_write, background_task]
  then:
    decision: allow
- id: workspace
  when:
    targets: [shell, read, write, edit]
  then:
    decision: allow
- id: message-user
  when:
    target: message_send
    arguments:
      to:
        equals: user
  then:
    decision: allow
`) as { when: { target?: string; targets?: string[] } }[];

const defaultRules = (tools: string[]) =>
  DEFAULT_RULES.flatMap((rule) => {
    if (rule.when.target) return tools.includes(rule.when.target) ? [rule] : [];
    const targets = rule.when.targets?.filter((t) => tools.includes(t)) ?? [];
    return targets.length ? [{ ...rule, when: { ...rule.when, targets } }] : [];
  });

export function readSpecialists(): Specialist[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => parse(readFileSync(join(DIR, file), "utf8")) as Specialist);
}

export const readSpecialist = (name: string) =>
  readSpecialists().find((s) => s.name === name);

export function writeSpecialist(specialist: Specialist) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${specialist.name}.yaml`), stringify(specialist));
}

export function validateSpecialist(
  value: unknown,
  tools: string[],
): Specialist {
  const s = value as Partial<Specialist>;
  if (typeof s?.name !== "string" || !NAME.test(s.name) || s.name === "nu")
    throw new Error(
      "name must be lowercase letters, digits, and -, and not nu",
    );
  if (typeof s.instructions !== "string" || !s.instructions)
    throw new Error("instructions are required");
  if (!Array.isArray(s.tools)) throw new Error("tools must be a list");
  for (const tool of s.tools)
    if (MAIN_ONLY.has(tool) || !tools.includes(tool))
      throw new Error(`tool ${tool} is not available to specialists`);
  if (s.rules !== undefined && !Array.isArray(s.rules))
    throw new Error("rules must be a list");
  if (s.model !== undefined && typeof s.model !== "string")
    throw new Error("model must be a provider/id string");
  return {
    name: s.name,
    instructions: s.instructions,
    tools: s.tools,
    memory_scope: s.memory_scope ?? s.name,
    rules: s.rules ?? defaultRules(s.tools),
    model: s.model,
  };
}
