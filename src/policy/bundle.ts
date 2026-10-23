import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "yaml";

const DEFAULT_POLICY = `rules:
  - id: reads
    when:
      targets:
        - memory_search
        - schedule_list
        - browser_observe
        - policy_read
        - package_search
    then:
      decision: allow

  - id: nu-state
    when:
      targets:
        - memory_write
        - skill_write
        - schedule_create
        - schedule_delete
        - background_task
        - delegate
        - secrets_request
    then:
      decision: allow

  - id: workspace
    when:
      targets: ["shell", "read", "write", "edit"]
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
`;

export async function readPolicy(path: string): Promise<unknown[]> {
  if (!existsSync(path)) await writeFile(path, DEFAULT_POLICY);
  return parse(await readFile(path, "utf8"))?.rules ?? [];
}

export const assemble = (rules: unknown[]) =>
  stringify({
    default_action: "deny",
    rules: [
      {
        id: "allow-llm",
        when: { step_kind: "llm_call" },
        // biome-ignore lint/suspicious/noThenProperty: policy rule syntax
        then: { decision: "allow" },
      },
      {
        id: "handoff",
        when: { target: "browser_handoff" },
        // biome-ignore lint/suspicious/noThenProperty: policy rule syntax
        then: {
          decision: "require_approval",
          approval_config: { timeout: "12h" },
        },
      },
      ...rules,
      {
        id: "ask",
        when: { step_kind: "tool_call" },
        // biome-ignore lint/suspicious/noThenProperty: policy rule syntax
        then: {
          decision: "require_approval",
          approval_config: { timeout: "12h" },
        },
      },
    ],
  });
