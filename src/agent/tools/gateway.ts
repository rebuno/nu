import { resolve } from "node:path";
import { env } from "node:process";

import { Type } from "@earendil-works/pi-ai";
import { execution } from "rebuno";
import { codeHash } from "../../registry.js";
import { readDir, sandbox } from "../../sandbox/index.js";
import { searchPackages } from "../../terminal/npm.js";
import { anyTool, type NuTool, text } from "./tool.js";

const GATEWAY_URL = "http://127.0.0.1:4120";

// The gateway reads the arguments from the executing step in the kernel, so it
// acts only on calls policy allowed.
export async function gateway<T>(path: string, body: object = {}) {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GATEWAY_SECRET ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ execution_id: execution().id, ...body }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result as T;
}

export const messageSend = anyTool({
  name: "message_send",
  label: "Message",
  description:
    "Send a message now, outside your reply. `to` is `user` for the user's direct conversation, or a conversation key: `<channel>:<id>` for a channel or thread. `files` are workspace paths to attach.",
  parameters: Type.Object({
    to: Type.String(),
    text: Type.String(),
    files: Type.Optional(Type.Array(Type.String())),
  }),
  execute: async () => {
    await gateway("/internal/message_send");
    return text("Sent.");
  },
});

export const backgroundTask = anyTool({
  name: "background_task",
  label: "Background task",
  description:
    "Start a task in its own thread and conversation, and return immediately. Use it for long work or work that may wait on the user's approval, so this conversation stays free. The task starts from the instructions alone, so make them self-contained.",
  parameters: Type.Object({
    title: Type.String({ description: "Short thread title" }),
    instructions: Type.String(),
  }),
  execute: async () => {
    const { conversation } = await gateway<{ conversation: string }>(
      "/internal/background_task",
    );
    return text(`Started in conversation ${conversation}.`);
  },
});

export const secretsRequest = anyTool({
  name: "secrets_request",
  label: "Request secret",
  description:
    "Ask the user to provide a credential, such as an API token a tool needs. The user answers outside this conversation, and the value never reaches you. Ask for the narrowest credential that works, and say what it is for.",
  parameters: Type.Object({
    name: Type.String({ description: "Secret name in UPPER_SNAKE_CASE" }),
    reason: Type.String(),
  }),
  execute: async () => {
    await gateway("/internal/secrets_request");
    return text("Asked the user.");
  },
});

export const packageCheckout = anyTool({
  name: "package_checkout",
  label: "Check out package",
  description:
    "Copy an installed package's files into the workspace at packages/<namespace> so you can change it, then write it back with package_write.",
  parameters: Type.Object({ namespace: Type.String() }),
  execute: async () => {
    const { dir } = await gateway<{ dir: string }>(
      "/internal/package_checkout",
    );
    return text(`Checked out to ${dir}.`);
  },
});

export const packageWrite: NuTool = {
  ...anyTool({
    name: "package_write",
    label: "Write package",
    description:
      "Create or update a local package from a workspace directory. Write a tool only for work that needs the user's credentials or acts on the user's accounts; for anything else, a script in the workspace and a skill are enough. The directory holds package.json with a one-sentence description and a nu key: namespace (lowercase), tools (globs of tool.yaml files), skills (skill directories), extensions (entry files), and client (how the terminal shows its tools: client.tools.<tool> with icon, title with {arg} placeholders, body naming an argument shown as code, and language; and slash commands: client.commands.<name> with description and message, where {args} is the text after the command). Writing over a package installed from elsewhere replaces it with the local copy; check it out with package_checkout first. Each tool directory holds tool.yaml and its entry. tool.yaml has name (<namespace>__<tool>), version (a whole number, raised whenever the tool's code or anything it imports changes), description, args_schema (a JSON Schema object), idempotency (safe_to_retry or at_most_once), secrets (environment variable names), and entry (the TypeScript file to run). The entry's default export is an async function (args, { stepId, config }) that returns JSON, where config holds the package's settings; it reads secrets from process.env and can use fetch. Nu bundles each tool with what it imports, so tools can share code from elsewhere in the package, but every import must stay inside the package and the tool cannot read files at runtime. For npm packages, put dependencies in the package's package.json and run npm install --omit=dev --legacy-peer-deps in the package directory so it writes package-lock.json; packages must be plain JavaScript, without native addons or install scripts. Test it first and include the output. Tools and skills are available from the next turn; extension changes reload Nu.",
    parameters: Type.Object({
      dir: Type.String({ description: "Package directory in the workspace" }),
      test_output: Type.Optional(Type.String()),
    }),
    execute: async () => {
      const { namespace, tools, reloaded } = await gateway<{
        namespace: string;
        tools: string[];
        reloaded: boolean;
      }>("/internal/package_write");
      return text(
        [
          `Wrote package ${namespace}.`,
          tools.length ? `Tools: ${tools.join(", ")}.` : "",
          reloaded
            ? "Nu reloads when this turn ends, to load its extensions."
            : "Its tools and skills are available from the next turn.",
        ]
          .filter(Boolean)
          .join(" "),
      );
    },
  }),
  // The step records the files themselves, so the approval covers exactly
  // what the gateway writes.
  stepArgs: async (params) => {
    const { dir, test_output } = params as {
      dir: string;
      test_output?: string;
    };
    const files = await readDir(resolve(sandbox.workdir, dir));
    const nu = JSON.parse(files["package.json"] ?? "{}").nu ?? {};
    return {
      namespace: String(nu.namespace ?? ""),
      extensions: Boolean(nu.extensions?.length),
      files,
      code_hash: codeHash(files),
      test_output: test_output ?? "",
    };
  },
};

export const packageSearch = anyTool({
  name: "package_search",
  label: "Search packages",
  description:
    "Search npm for Nu packages that add tools, skills, or chat apps. Returns each package's source, version, and description; install one with package_install.",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (_id, { query }) =>
    text(JSON.stringify(await searchPackages(query))),
});

export const packageInstall: NuTool = {
  ...anyTool({
    name: "package_install",
    label: "Install package",
    description:
      "Install a package of skills, tools, and extensions, from npm, such as npm:@someone/nu-linear@1.2.0, or a git URL. Save a package from a workspace directory with package_write instead. Returns its suggested policy rules; propose the ones the user wants with policy_update. Its tools are available from the next turn; extensions reload Nu.",
    parameters: Type.Object({ source: Type.String() }),
    execute: async () => {
      const { tools, rules, reloaded } = await gateway<{
        tools: string[];
        rules: string;
        reloaded: boolean;
      }>("/internal/package_install");
      return text(
        [
          `Installed tools: ${tools.join(", ") || "none"}.`,
          reloaded
            ? "Nu reloads when this turn ends, to load its extensions."
            : "",
          `Suggested rules:\n${rules || "none"}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    },
  }),
  stepArgs: async (params) => {
    const { source } = params as { source: string };
    const { version } = await gateway<{ version: string }>(
      "/internal/package_resolve",
      { source },
    );
    return { source, version };
  },
};

export const packageRemove = anyTool({
  name: "package_remove",
  label: "Remove package",
  description: "Remove an installed package by its source.",
  parameters: Type.Object({ source: Type.String() }),
  execute: async () => {
    const { reloaded } = await gateway<{ reloaded: boolean }>(
      "/internal/package_remove",
    );
    return text(
      reloaded ? "Removed. Nu reloads when this turn ends." : "Removed.",
    );
  },
});

export function delegateTool(
  specialists: { name: string; instructions: string }[],
) {
  return anyTool({
    name: "delegate",
    label: "Delegate",
    description: `Hand a task to a specialist, an agent with its own tools, policy, and memory. With wait (the default) its answer comes back as this call's result; without it the specialist works in its own conversation and replies there. The specialist sees only the task, so make it self-contained. Specialists:\n${specialists.map((s) => `- ${s.name}: ${s.instructions}`).join("\n") || "(none yet)"}`,
    parameters: Type.Object({
      specialist: Type.String(),
      task: Type.String(),
      wait: Type.Optional(Type.Boolean()),
    }),
    execute: async () => {
      const { step_id, conversation } = await gateway<{
        step_id?: string;
        conversation?: string;
      }>("/internal/delegate");
      if (step_id) return (await execution().awaitSubagent(step_id)) as never;
      return text(`Started in conversation ${conversation}.`);
    },
  });
}

export const specialistWrite = anyTool({
  name: "specialist_write",
  label: "Write specialist",
  description:
    "Create or replace a specialist the user described. The manifest is YAML with name (lowercase), instructions, tools (seed, registered, and MCP tool names it may use; mcp__<server>__* allows all of a server's tools), memory_scope (defaults to the name), model (optional provider/id), and rules (its policy rules, in the same form as the user's rules; tools without a rule ask). Without rules, it may use memory_search, schedule_list, browser_observe, memory_write, background_task, shell, read, write, and edit, and message the user, without asking. The user approves it after a readback.",
  parameters: Type.Object({ manifest: Type.String() }),
  execute: async () => {
    const { name } = await gateway<{ name: string }>(
      "/internal/specialist_write",
    );
    return text(`Specialist ${name} is ready.`);
  },
});
