import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { env } from "node:process";

import {
  type AgentMessage,
  Agent as Loop,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  normalizeContext,
  Type,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { Agent, previous, Result, raiseForRefusal, step } from "rebuno";

import pkg from "../../package.json" with { type: "json" };
import { AGENT_ID, requiredEnv, SKILLS_DIR } from "../config.js";
import { openDb } from "../db.js";
import { loadExtensions, promptAdditions } from "../extensions.js";
import { activeTools, readPackages } from "../registry.js";
import { useSandbox } from "../sandbox/index.js";
import { readSettings, timeZone } from "../settings.js";
import { readSpecialist, readSpecialists } from "../specialists.js";
import { compactMessages, needsCompaction, prune } from "./compaction.js";
import { sqliteMemory } from "./memory.js";
import { createModels, modelKey } from "./models.js";
import {
  type Context,
  renderPrompt,
  replyText,
  type TurnInput,
} from "./prompt.js";
import { serveLive, useBrowserProvider } from "./tools/browser.js";
import { gateway } from "./tools/gateway.js";
import { mcpTools, registeredTool } from "./tools/registered.js";
import { loadedTools, toolSearch } from "./tools/search.js";
import { BUILT_IN_SKILLS } from "./tools/skills.js";
import { asStep } from "./tools/tool.js";
import { seedTools } from "./toolset.js";

type State = { messages: AgentMessage[] };

const models = await createModels();
await mkdir(SKILLS_DIR, { recursive: true });
const db = openDb();
const extensions = await loadExtensions();
const memory = extensions.memory ?? sqliteMemory(db);
if (extensions.browser) useBrowserProvider(extensions.browser);
useSandbox(extensions.sandbox);

async function loadContext(
  agentId: string,
  input: TurnInput,
): Promise<Context> {
  const specialist = agentId === AGENT_ID ? undefined : readSpecialist(agentId);
  if (agentId !== AGENT_ID && !specialist)
    throw new Error(`no specialist ${agentId}`);
  const allowed = (name: string) =>
    !specialist ||
    specialist.tools.some((tool) =>
      tool.endsWith("__*") ? name.startsWith(tool.slice(0, -1)) : tool === name,
    );
  const settings = readSettings();
  const model =
    (specialist?.model && (await models.find(specialist.model))) ||
    (await models.current());
  if (!model)
    throw new Error(
      "No model chosen. Pick one with /model, or run nu login <provider>.",
    );
  const zone = timeZone(settings);
  const packages = Object.values(readPackages());
  const mcp = await mcpTools();
  return {
    version: pkg.version,
    model: modelKey(model),
    thinking: (settings.defaultThinkingLevel as ThinkingLevel) ?? "medium",
    now: new Date().toISOString(),
    timeZone: zone,
    tools: seedTools(db, memory, { timeZone: zone, conversation: "" })
      .map(([tool]) => tool.name)
      .filter(allowed),
    profile: await memory.profile(),
    skills: [
      BUILT_IN_SKILLS,
      SKILLS_DIR,
      ...packages.flatMap((pkg) => pkg.skills),
    ].flatMap((dir) => loadSkillsFromDir({ dir, source: "workspace" }).skills),
    registered: [
      ...activeTools().map(({ manifest }) => ({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        args_schema: manifest.args_schema,
        idempotency: manifest.idempotency,
      })),
      ...mcp.tools,
    ].filter((tool) => allowed(tool.name)),
    groups: {
      ...Object.fromEntries(
        packages.flatMap(({ namespace, description }) =>
          description ? [[namespace, description]] : [],
        ),
      ),
      ...mcp.servers,
    },
    additions: await promptAdditions(extensions.hooks.before_agent_start, {
      agent: agentId,
      message: input.message,
      conversation: input.conversation ?? "main",
      trigger: input.trigger,
    }),
    specialist,
    specialists: specialist
      ? []
      : readSpecialists().map(({ name, instructions }) => ({
          name,
          instructions,
        })),
  };
}

async function runTurn(agentId: string, input: TurnInput) {
  const ctx = await step("context", () => loadContext(agentId, input));
  if (ctx.version !== pkg.version) throw new Error("runtime changed");
  const model = await models.find(ctx.model);
  if (!model) throw new Error(`model ${ctx.model} is no longer available`);
  const state = await previous<State>();
  const sessionId = `${agentId}:${input.conversation ?? "main"}`;
  const compactHistory = async (messages: AgentMessage[], saved = 0) => {
    const result = await step("compaction", async () => {
      const key = readSettings().compactionModel;
      const summaryModel = key ? await models.find(key) : model;
      if (!summaryModel)
        throw new Error(`compaction model ${key} is unavailable`);
      return compactMessages(messages, model, {
        saved,
        summaryModel,
        summarize: async (systemPrompt, transcript) => {
          const stream = await models.streamUnrecorded(
            summaryModel,
            normalizeContext({ systemPrompt, messages: transcript }),
            {
              sessionId,
              reasoning: ctx.thinking === "off" ? undefined : ctx.thinking,
              maxTokens: Math.min(8_000, summaryModel.maxTokens),
            },
          );
          return stream.result();
        },
      });
    });
    if (!result) return messages;
    return [
      {
        role: "compactionSummary" as const,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        timestamp: Date.now(),
      },
      ...messages.slice(result.keepFrom),
    ];
  };
  let history = state?.messages ?? [];
  if (needsCompaction(history, model)) {
    const pruned = prune(history);
    history = pruned.messages;
    if (needsCompaction(history, model, pruned.saved)) {
      try {
        history = await compactHistory(history, pruned.saved);
      } catch (error) {
        raiseForRefusal(error);
        console.error("agent: compaction failed", error);
      }
    }
  }

  let suspended: unknown;
  const onSuspend = (error: unknown) => {
    suspended ??= error;
    loop.abort();
  };
  const seed = seedTools(db, memory, {
    timeZone: ctx.timeZone,
    conversation: input.conversation ?? "main",
    memoryScope: ctx.specialist?.memory_scope,
    specialists: ctx.specialists,
    inner: { model, streamFn: models.streamUnrecorded },
  })
    .filter(([tool]) => ctx.tools.includes(tool.name))
    .map(([tool, idempotency]) => asStep(tool, idempotency, onSuspend));

  const registered = ctx.registered.map((pinned) =>
    asStep(...registeredTool(pinned), onSuspend),
  );
  const loaded = loadedTools(history);
  const search = toolSearch(
    () => ctx.registered.filter((tool) => !loaded.has(tool.name)),
    (names) => {
      for (const name of names) loaded.add(name);
    },
  );
  const tools = () => [
    ...seed,
    ...(registered.length ? [search] : []),
    ...registered.filter((tool) => loaded.has(tool.name)),
  ];

  let received = 0;
  const drainInbox = async () => {
    const { messages } = await step(
      "inbox",
      ({ after }) =>
        gateway<{ messages: string[] }>("/internal/inbox", {
          after: after as number,
        }).catch((error) => {
          if (error instanceof TypeError) return { messages: [] };
          throw error;
        }),
      { after: received },
    );
    received += messages.length;
    for (const message of messages)
      loop.steer({ role: "user", content: message, timestamp: Date.now() });
  };

  const loop = new Loop({
    initialState: {
      systemPrompt: renderPrompt(ctx, input),
      model,
      thinkingLevel: ctx.thinking,
      tools: tools(),
      messages: history,
    },
    convertToLlm,
    streamFn: models.streamFn(onSuspend),
    sessionId,
    toolExecution: "sequential",
    prepareNextTurnWithContext: ({ context }) => ({
      context: { ...context, tools: tools() },
    }),
    steeringMode: "all",
    finishTurn: async ({ message }) => {
      if (message.stopReason === "error" || message.stopReason === "aborted")
        return;
      await drainInbox();
    },
  });

  await loop.prompt(input.message);
  const failed = loop.state.messages.at(-1);
  if (
    !suspended &&
    failed?.role === "assistant" &&
    failed.stopReason === "error" &&
    isContextOverflow(failed, model.contextWindow)
  ) {
    const tooLong =
      "The conversation is too long to continue; start a new one with /new.";
    const pruned = prune(loop.state.messages.slice(0, -1));
    loop.state.messages = pruned.messages;
    try {
      loop.state.messages = await compactHistory(
        loop.state.messages,
        pruned.saved,
      );
    } catch (error) {
      raiseForRefusal(error);
      console.error("agent: overflow compaction failed", error);
      throw new Error(tooLong);
    }
    await loop.continue();
    const retried = loop.state.messages.at(-1);
    if (
      retried?.role === "assistant" &&
      retried.stopReason === "error" &&
      isContextOverflow(retried, model.contextWindow)
    )
      throw new Error(tooLong);
  }
  if (suspended) throw suspended;
  const { errorMessage } = loop.state;
  if (errorMessage) {
    raiseForRefusal(new Error(errorMessage));
    throw new Error(errorMessage);
  }
  const messages = loop.state.messages.filter((m) => m.role !== "system");
  const reply = replyText(messages);
  const silent = input.trigger && !reply && !received;
  return new Result({
    output: { reply },
    state: silent ? state : { messages },
  });
}

const agentSecret = requiredEnv("REBUNO_AGENT_SECRET");

function agentFor(agentId: string) {
  const agent = new Agent<TurnInput>(agentId, {
    description:
      agentId === AGENT_ID
        ? "Nu, a personal agent"
        : `Nu's ${agentId} specialist`,
    inputSchema: Type.Object({
      message: Type.String(),
      conversation: Type.Optional(Type.String()),
      trigger: Type.Optional(Type.String()),
    }),
    outputSchema: Type.Object({ reply: Type.String() }),
    secret: agentSecret,
    baseUrl: env.REBUNO_URL ?? "http://127.0.0.1:4117",
  });
  agent.bind((input) => runTurn(agentId, input));
  return agent;
}

// `/webhook` serves Nu and `/webhook/<name>` each specialist, which is served
// from its first dispatch on.
const agents = new Map([[AGENT_ID, agentFor(AGENT_ID)]]);

createServer(async (req, res) => {
  const live = req.url?.match(
    /^\/browser\/([0-9a-f-]+)\/([A-Za-z0-9_-]{1,64})(?:\/(frames|input))?$/,
  );
  if (live) {
    if (req.headers.authorization !== `Bearer ${agentSecret}`)
      return res.writeHead(401).end();
    return serveLive(req, res, live[1], live[2], live[3]).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  }
  const name =
    req.url === "/webhook"
      ? AGENT_ID
      : req.url?.match(/^\/webhook\/([a-z0-9-]+)$/)?.[1];
  if (req.method !== "POST" || !name) return res.writeHead(404).end();
  if (!agents.has(name) && readSpecialist(name))
    agents.set(name, agentFor(name));
  const agent = agents.get(name);
  if (!agent) return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const response = await agent.fetch(
    new Request(`http://localhost${req.url}`, {
      method: "POST",
      headers: {
        "Rebuno-Signature": String(req.headers["rebuno-signature"] ?? ""),
      },
      body: Buffer.concat(chunks),
    }),
  );
  res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(env.AGENT_PORT ?? 4118), "127.0.0.1");
console.log("agent: listening");
