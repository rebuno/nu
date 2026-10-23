import { DatabaseSync } from "node:sqlite";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { Pinned } from "./registered.js";
import { anyTool } from "./tool.js";

function schemaText(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const { description, properties, items } = schema as Record<string, unknown>;
  return [
    ...(typeof description === "string" ? [description] : []),
    ...Object.entries((properties as Record<string, unknown>) ?? {}).flatMap(
      ([name, property]) => [name, ...schemaText(property)],
    ),
    ...schemaText(items),
  ];
}

function rankTools(tools: Pinned[], query: string, limit: number) {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length || !tools.length) return [];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "create virtual table tools using fts5(name unindexed, text, tokenize = 'porter unicode61')",
    );
    const insert = db.prepare("insert into tools values (?, ?)");
    for (const tool of tools)
      insert.run(
        tool.name,
        [
          tool.name.replaceAll("_", " "),
          tool.description,
          ...schemaText(tool.args_schema),
        ].join(" "),
      );
    const rows = db
      .prepare(
        "select name from tools where tools match ? order by rank limit ?",
      )
      .all(terms.map((term) => `"${term}"`).join(" OR "), limit) as {
      name: string;
    }[];
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

export function loadedTools(messages: AgentMessage[]) {
  const names = new Set<string>();
  for (const message of messages)
    if (message.role === "assistant") {
      for (const part of message.content)
        if (part.type === "toolCall") names.add(part.name);
    } else if (
      message.role === "toolResult" &&
      message.toolName === "tool_search"
    )
      for (const name of (message.details as { loaded?: string[] })?.loaded ??
        [])
        names.add(name);
  return names;
}

export function group(name: string) {
  const [namespace, server] = name.split("__");
  return namespace === "mcp" ? `mcp__${server}` : namespace;
}

export function toolSearch(
  deferred: () => Pinned[],
  load: (names: string[]) => void,
) {
  return anyTool({
    name: "tool_search",
    label: "Find tools",
    description:
      "Find tools listed under <deferred_tools> and load the matches along with the other tools in their packages, so you can call them from your next step.",
    parameters: Type.Object({
      query: Type.String({ description: "What the tool should do" }),
      limit: Type.Optional(Type.Integer({ description: "8 by default" })),
    }),
    execute: async (_id, { query, limit }) => {
      const tools = deferred();
      const groups = new Set(rankTools(tools, query, limit ?? 8).map(group));
      const names = tools
        .map((tool) => tool.name)
        .filter((name) => groups.has(group(name)));
      load(names);
      return {
        content: [
          {
            type: "text",
            text: names.length
              ? `Loaded ${names.join(", ")}.`
              : "No matching tools.",
          },
        ],
        details: { loaded: names },
      };
    },
  });
}
