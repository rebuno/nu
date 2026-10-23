import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Client, type Event, NotFoundError } from "rebuno";
import { parse, stringify } from "yaml";
import { createModels, modelKey } from "../agent/models.js";
import { AGENT_ID } from "../config.js";
import {
  EXTENSION_KEY,
  type GatewayHooks,
  notify,
  type Report,
  runInput,
} from "../extensions.js";
import { assemble, readPolicy } from "../policy/bundle.js";
import {
  applyEdits,
  checkRules,
  describe,
  invariants,
  POLICY_DEFAULTS,
  policyView,
  RESERVED,
  type Rule,
  type RuleEdit,
} from "../policy/checks.js";
import {
  activeTools,
  NAMESPACE,
  readIndex,
  readPackages,
  SEED_TOOLS,
} from "../registry.js";
import { sandbox } from "../sandbox/index.js";
import { SECRET_NAME } from "../secrets.js";
import {
  readSettings,
  setExtensionConfig,
  writeSettings,
} from "../settings.js";
import {
  readSpecialist,
  readSpecialists,
  type Specialist,
  validateSpecialist,
  writeSpecialist,
} from "../specialists.js";

import type {
  ApprovalAction,
  ApprovalView,
  ChannelAdapter,
  Command,
  InboundMessage,
  Location,
  ReplyTarget,
  TurnEvent,
  TurnHandler,
} from "./channel.js";
import {
  deltaLine,
  finished,
  type HistoryEntry,
  summarize,
  TurnEvents,
} from "./events.js";
import { liveLink } from "./live.js";
import { mcpStatus } from "./mcp.js";
import {
  checkoutPackage,
  clientView,
  commandList,
  type FetchedPackage,
  installRemotePackage,
  missingValues,
  previewPackage,
  removePackage,
  resolveVersion,
  saveSecret,
  validateWrite,
  writeLocalPackage,
  writeSummary,
} from "./packages.js";
import { reload, reloaded } from "./reload.js";
import { split, textTurn } from "./reply.js";
import { updateNotice } from "./updates.js";

const TOOL_ENDS = new Set(["done", "failed", "denied"]);

const TERMINAL = new Set([
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
]);

const TOOL_STATUS: Record<string, "done" | "failed" | "denied"> = {
  succeeded: "done",
  failed: "failed",
  cancelled: "failed",
  rate_limited: "failed",
  denied: "denied",
};

type Place = { channel: string; target: ReplyTarget };

type Turn = Place & {
  agentId: string;
  conversation: string;
  session: string;
  quiet: boolean;
  silent?: boolean;
  trigger?: string;
  approvals: string[];
};

type Queued = { text: string; messageId: string; takenBy?: string };

type State = {
  generations: Record<string, number>;
  agents: Record<string, string>;
  places: Record<string, Place>;
  direct: Record<string, Place>;
  turns: Record<string, Turn>;
  inbox: Record<string, Queued[]>;
};

type TurnRequest = Place & {
  conversation: string;
  session: string;
  message: string;
  idempotencyKey: string;
  trigger?: string;
  agentId?: string;
  spawnedBy?: { executionId: string; stepId: string };
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Tools that change what needs approval, or always hand off to the user, are
// decided one call at a time.
const ONCE_ONLY = new Set([
  "policy_update",
  "specialist_write",
  "browser_handoff",
]);

export class Gateway {
  readonly #adapters = new Map<string, ChannelAdapter>();
  readonly #state: State;
  readonly #statePath: string;
  readonly #policyPath: string;
  #models?: ReturnType<typeof createModels>;
  #reloadWhenIdle = false;
  #policyQueue: Promise<unknown> = Promise.resolve();
  #posted = "";
  #applied = "";
  readonly #cards = new Map<
    string,
    {
      handler: TurnHandler;
      view: ApprovalView;
      choices: ApprovalView["choices"];
    }
  >();
  readonly #ruleRequests = new Set<string>();

  constructor(
    private readonly kernel: Client,
    private readonly kernelUrl: string,
    private readonly apiKey: string,
    dataDir: string,
    private readonly agents: { webhookBase: string; secret: string },
    private readonly hooks: GatewayHooks = {
      input: [],
      turn_end: [],
      tool_execution_end: [],
    },
  ) {
    this.#statePath = join(dataDir, "gateway.json");
    this.#policyPath = join(dataDir, "policy.yaml");
    const statePath = this.#statePath;
    this.#state = {
      generations: {},
      agents: {},
      places: {},
      direct: {},
      turns: {},
      inbox: {},
      ...(existsSync(statePath)
        ? JSON.parse(readFileSync(statePath, "utf8"))
        : {}),
    };
  }

  async start(adapters: ChannelAdapter[]) {
    for (const { name } of readSpecialists())
      await this.#registerSpecialist(name);
    for (const adapter of adapters) {
      this.#adapters.set(adapter.name, adapter);
      await adapter.start({
        commands: commandList(),
        onMessage: (message) => this.#onMessage(adapter, message),
        onApprovalAction: (action) => this.#onApprovalAction(adapter, action),
        onCommand: (command) => this.#onCommand(adapter, command),
      });
    }
    for (const [id, turn] of Object.entries(this.#state.turns)) {
      if (turn.conversation.startsWith("policy:"))
        this.#ruleRequests.add(turn.conversation.slice("policy:".length));
      void this.#follow(id);
    }
    setInterval(
      () =>
        void this.#syncPolicy().catch((error) =>
          console.error("gateway: policy sync failed", error),
        ),
      5000,
    ).unref();
  }

  async internal(path: string, body: Record<string, unknown>) {
    const executionId = String(body.execution_id ?? "");
    switch (path) {
      case "/internal/inbox":
        return this.#takeInbox(executionId, Number(body.after ?? 0));
      case "/internal/message_send":
        return this.#messageSend(executionId);
      case "/internal/background_task":
        return this.#backgroundTask(executionId);
      case "/internal/turns":
        return this.#scheduledTurn(body);
      case "/internal/secrets_request":
        return this.#secretsRequest(executionId);
      case "/internal/package_checkout":
        return this.#packageCheckout(executionId);
      case "/internal/package_write":
        return this.#packageWrite(executionId);
      case "/internal/policy_update":
        return this.#policyUpdate(executionId);
      case "/internal/package_resolve":
        return { version: await resolveVersion(String(body.source)) };
      case "/internal/package_install":
        return this.#packageInstall(executionId);
      case "/internal/package_remove":
        return this.#packageRemove(executionId);
      case "/internal/delegate":
        return this.#delegate(executionId);
      case "/internal/specialist_write":
        return this.#specialistWrite(executionId);
      default:
        throw new HttpError(404, `no route ${path}`);
    }
  }

  #save() {
    writeFileSync(this.#statePath, JSON.stringify(this.#state, null, 2));
  }

  async #admin(path: string, body: unknown) {
    const response = await fetch(`${this.kernelUrl}${path}`, {
      method: "POST",
      headers: {
        ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new HttpError(400, JSON.parse(text || "{}").message ?? text);
    return text ? JSON.parse(text) : {};
  }

  // Policy loads, writes, and syncs run one at a time, so a sync never reads a
  // bundle that a write is replacing.
  #serial<T>(task: () => Promise<T>) {
    const result = this.#policyQueue.then(task);
    this.#policyQueue = result.catch(() => {});
    return result;
  }

  loadPolicy() {
    return this.#serial(() => this.#loadPolicy());
  }

  async #liveBundle() {
    const response = await fetch(`${this.kernelUrl}/v0/agents/${AGENT_ID}`, {
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { policy_bundle?: string })
      .policy_bundle;
  }

  #syncPolicy() {
    return this.#serial(async () => {
      const live = await this.#liveBundle();
      if (live && live !== this.#applied) {
        let notice: string;
        try {
          const rules = ((parse(live)?.rules ?? []) as Rule[]).filter(
            (rule) => !RESERVED.has(rule.id),
          );
          invariants(rules);
          writeFileSync(this.#policyPath, stringify({ rules }));
          notice = `Nu adopted the policy edited in the dashboard:\n${policyView(rules)}`;
        } catch (error) {
          notice = `Nu undid a policy edit from the dashboard: ${error instanceof Error ? error.message : String(error)}`;
        }
        await this.#loadPolicy();
        await this.#tellUser(notice);
      } else if (!live) await this.#loadPolicy();
      else {
        const rules = (await readPolicy(this.#policyPath)) as Rule[];
        if (assemble(rules) === this.#posted) return;
        let notice: string;
        try {
          invariants(rules);
          notice = `Nu loaded a policy edit made in policy.yaml:\n${policyView(rules)}`;
        } catch (error) {
          const posted = ((parse(this.#posted)?.rules ?? []) as Rule[]).filter(
            (rule) => !RESERVED.has(rule.id),
          );
          writeFileSync(this.#policyPath, stringify({ rules: posted }));
          notice = `Nu undid an edit to policy.yaml: ${error instanceof Error ? error.message : String(error)}`;
        }
        await this.#loadPolicy();
        await this.#tellUser(notice);
      }
    });
  }

  async #tellUser(text: string) {
    if (!this.#state.places.main) return;
    const place = this.#userPlace();
    await this.#adapter(place)
      .reply(place.target, text)
      .catch(() => {});
  }

  async #loadPolicy() {
    this.#posted = assemble(await readPolicy(this.#policyPath));
    await this.#admin(`/v0/policies/${AGENT_ID}`, { bundle: this.#posted });
    this.#applied = (await this.#liveBundle()) ?? "";
    for (const specialist of readSpecialists())
      await this.#admin(`/v0/policies/${specialist.name}`, {
        bundle: assemble(specialist.rules),
      });
    void this.#recheckApprovals();
  }

  async #changeRules(rules: unknown, replay = true) {
    const result = await checkRules(
      (path, body) => this.#admin(path, body),
      AGENT_ID,
      (await readPolicy(this.#policyPath)) as Rule[],
      rules,
      replay,
    );
    return {
      ...result,
      apply: () =>
        this.#serial(async () => {
          writeFileSync(this.#policyPath, stringify({ rules }));
          await this.#loadPolicy();
        }),
    };
  }

  async #editRules(changes: unknown) {
    return this.#changeRules(
      applyEdits(
        (await readPolicy(this.#policyPath)) as Rule[],
        changes as RuleEdit[],
      ),
    );
  }

  #conversation(adapter: ChannelAdapter, where: Location) {
    if (where.direct) return "main";
    return `${adapter.name}:${where.threadId ?? where.conversationId}`;
  }

  #session(conversation: string) {
    const agent = this.#state.agents[conversation];
    return `${agent ? `${agent}@` : ""}${conversation}:${this.#state.generations[conversation] ?? 0}`;
  }

  #busy(session: string) {
    return Object.values(this.#state.turns).some((t) => t.session === session);
  }

  async #startTurn(request: TurnRequest) {
    const { channel, target, conversation, session, message, trigger } =
      request;
    const agentId =
      request.agentId ?? this.#state.agents[conversation] ?? AGENT_ID;
    const execution = await this.kernel.create(
      agentId,
      { message, conversation, ...(trigger && { trigger }) },
      {
        session,
        idempotencyKey: request.idempotencyKey,
        spawnedBy: request.spawnedBy,
      },
    );
    if (this.#state.turns[execution.id]) return execution.id;
    this.#state.turns[execution.id] = {
      channel,
      target,
      agentId,
      conversation,
      session,
      quiet: Boolean(trigger) || Boolean(request.spawnedBy),
      silent: Boolean(request.spawnedBy),
      trigger,
      approvals: [],
    };
    this.#save();
    void this.#follow(execution.id);
    return execution.id;
  }

  async #onMessage(adapter: ChannelAdapter, message: InboundMessage) {
    if (message.senderId !== adapter.userId) return;
    const saved = await saveAttachments(message);
    const raw = [message.text.trim(), ...saved].filter(Boolean).join("\n");
    if (!raw) return;
    const conversation = this.#conversation(adapter, message);
    const text = await runInput(this.hooks.input, {
      text: raw,
      channel: adapter.name,
      conversation,
    });
    if (!text?.trim()) return;
    const place: Place = {
      channel: adapter.name,
      target: {
        conversationId: message.conversationId,
        threadId: message.threadId,
        direct: message.direct,
        messageId: message.messageId,
      },
    };
    this.#state.places[conversation] = place;
    if (conversation === "main") {
      delete this.#state.direct[adapter.name];
      this.#state.direct[adapter.name] = place;
    }
    const session = this.#session(conversation);
    if (this.#busy(session)) {
      this.#state.inbox[session] = [
        ...(this.#state.inbox[session] ?? []),
        { text, messageId: message.messageId },
      ];
      this.#save();
      await this.#denyWaiting(session);
      return;
    }
    this.#save();
    await this.#startTurn({
      ...place,
      conversation,
      session,
      message: text,
      idempotencyKey: `${adapter.name}:${message.messageId}`,
    });
  }

  async #denyWaiting(session: string) {
    const ids = Object.values(this.#state.turns)
      .filter((turn) => turn.session === session)
      .flatMap((turn) => turn.approvals)
      .filter((id) => this.#cards.has(id) && !this.#ruleRequests.has(id));
    for (const id of ids) {
      try {
        await this.kernel.denyApproval(id, {
          rationale: "the user sent a new message instead of deciding",
        });
        this.#updateCard(id, {
          status: "Denied: you sent a new message.",
          choices: [],
        });
      } catch (error) {
        console.error(`denying approval ${id} failed`, error);
      }
    }
  }

  async #onApprovalAction(adapter: ChannelAdapter, action: ApprovalAction) {
    if (action.senderId !== adapter.userId) return "Only Nu's user can decide.";
    const approval = await this.kernel.getApproval(action.approvalId);
    if (approval.status !== "pending") return `Already ${approval.status}.`;
    if (action.decision === "rule")
      return this.#requestRule(action.approvalId, action.text ?? "");
    this.#cards.delete(action.approvalId);
    const rationale = `user via ${adapter.name}`;
    if (action.decision === "deny") {
      await this.kernel.denyApproval(action.approvalId, { rationale });
      return "Denied.";
    }
    let outcome = "Allowed once.";
    if (action.decision === "always") {
      const step = await this.kernel.getStep(
        approval.executionId,
        approval.stepId,
      );
      const rule = alwaysRule(step.target);
      try {
        if (!rule) throw new Error("this tool cannot be always allowed");
        const { agentId } = await this.kernel.get(approval.executionId);
        const specialist = readSpecialist(agentId);
        let readback: string[];
        if (specialist) {
          const updated = { ...specialist, rules: [rule, ...specialist.rules] };
          ({ readback } = await this.#checkSpecialist(updated, false));
          await this.#admin(`/v0/policies/${agentId}`, {
            bundle: assemble(updated.rules),
          });
          writeSpecialist(updated);
          void this.#recheckApprovals();
        } else {
          const current = await readPolicy(this.#policyPath);
          const change = await this.#changeRules([rule, ...current], false);
          await change.apply();
          ({ readback } = change);
        }
        outcome = `Allowed, and added: ${readback[0]}`;
      } catch (error) {
        outcome = `Allowed once; the rule was not added: ${error instanceof Error ? error.message : error}`;
      }
    }
    await this.kernel.grantApproval(action.approvalId, { rationale });
    return outcome;
  }

  async #requestRule(id: string, text: string) {
    const request = text.trim();
    if (!request) return "Describe the rule.";
    const card = this.#cards.get(id);
    if (!card) return "This call can no longer get a rule.";
    if (this.#ruleRequests.has(id))
      return "Nu is already writing a rule for this call.";
    const approval = await this.kernel.getApproval(id);
    const [step, { agentId }] = await Promise.all([
      this.kernel.getStep(approval.executionId, approval.stepId),
      this.kernel.get(approval.executionId),
    ]);
    const origin = this.#state.turns[approval.executionId] ?? this.#userPlace();
    const conversation = `policy:${id}`;
    this.#state.places[conversation] = origin;
    this.#ruleRequests.add(id);
    try {
      await this.#startTurn({
        channel: origin.channel,
        target: origin.target,
        conversation,
        session: this.#session(conversation),
        message: [
          `Policy request: ${request}`,
          `It is about this call, waiting for the user's approval: \`${step.target}\` with arguments ${JSON.stringify(step.args)}.`,
          agentId === AGENT_ID
            ? ""
            : `The call is from the ${agentId} specialist, whose rules change with specialist_write.`,
        ]
          .filter(Boolean)
          .join("\n"),
        idempotencyKey: `rule:${id}:${randomUUID()}`,
      });
    } catch (error) {
      this.#ruleRequests.delete(id);
      throw error;
    }
    this.#updateCard(id, {
      status: `Rule requested: "${request}"`,
      choices: card.choices.filter((choice) => choice.decision !== "rule"),
    });
    return "Asked Nu to write the rule.";
  }

  #ruleDone(id: string, reply: string) {
    this.#ruleRequests.delete(id);
    const card = this.#cards.get(id);
    if (!card) return;
    const line = reply.trim().split("\n")[0] ?? "";
    this.#updateCard(id, {
      status: line
        ? `Nu: ${line.length > 200 ? `${line.slice(0, 199)}…` : line}`
        : "Rule not added.",
      choices: card.choices,
    });
  }

  #updateCard(id: string, change: Partial<ApprovalView>) {
    const card = this.#cards.get(id);
    if (!card) return;
    card.view = { ...card.view, ...change };
    if (!card.view.choices.length) this.#cards.delete(id);
    card.handler
      .event({ type: "approval", approval: card.view })
      .catch(() => {});
  }

  async #recheckApprovals() {
    for (const id of [...this.#cards.keys()]) {
      try {
        const approval = await this.kernel.getApproval(id);
        if (approval.status !== "pending") {
          this.#cards.delete(id);
          continue;
        }
        const [step, { agentId }] = await Promise.all([
          this.kernel.getStep(approval.executionId, approval.stepId),
          this.kernel.get(approval.executionId),
        ]);
        const specialist = readSpecialist(agentId);
        const { results = [] } = (await this.#admin(
          `/v0/policies/${agentId}/test`,
          {
            bundle: specialist ? assemble(specialist.rules) : this.#posted,
            cases: [{ name: id, target: step.target, args: step.args }],
          },
        )) as { results?: { decision: string; rule_id: string }[] };
        const [result] = results;
        if (result?.decision !== "allow" && result?.decision !== "deny")
          continue;
        const rationale = `rule ${result.rule_id}`;
        if (result.decision === "allow")
          await this.kernel.grantApproval(id, { rationale });
        else await this.kernel.denyApproval(id, { rationale });
        this.#updateCard(id, {
          status: `${result.decision === "allow" ? "Allowed" : "Denied"} by rule ${result.rule_id}.`,
          choices: [],
        });
      } catch (error) {
        console.error(`rechecking approval ${id} failed`, error);
      }
    }
  }

  async #onCommand(adapter: ChannelAdapter, command: Command) {
    if (command.senderId !== adapter.userId)
      return command.respond("Only Nu's user can use Nu.");
    const conversation = this.#conversation(adapter, command);
    const session = this.#session(conversation);
    const running = Object.entries(this.#state.turns);
    switch (command.name) {
      case "new":
        this.#state.generations[conversation] =
          (this.#state.generations[conversation] ?? 0) + 1;
        this.#save();
        return command.respond("Started a new conversation.");
      case "stop": {
        const here = running.filter(([, turn]) => turn.session === session);
        if (!here.length) return command.respond("Nothing is running here.");
        for (const [id] of here) await this.kernel.cancel(id).catch(() => {});
        return command.respond("Stopped.");
      }
      case "status": {
        const approvals = await this.kernel.listApprovals();
        return command.respond(
          [
            `Running turns: ${running.length}. Pending approvals: ${approvals.length}.`,
            updateNotice(),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      case "secret": {
        const [name, ...value] = command.args.trim().split(/\s+/);
        if (!SECRET_NAME.test(name ?? "") || !value.length)
          return command.respond("Use /secret NAME value.");
        return command.respond(saveSecret(name as string, value.join(" ")));
      }
      case "config": {
        const [namespace, key, ...value] = command.args.trim().split(/\s+/);
        if (
          !NAMESPACE.test(namespace ?? "") ||
          !EXTENSION_KEY.test(key ?? "") ||
          !value.length
        )
          return command.respond("Use /config namespace key value.");
        setExtensionConfig(namespace as string, key as string, value.join(" "));
        return command.respond(reloaded(`Saved ${namespace} ${key}.`));
      }
      case "policy":
        if (!command.args.trim()) {
          const rules = (await readPolicy(this.#policyPath)) as Rule[];
          return command.respond(policyView(rules), {
            title: "Policy",
            items: rules.map((rule) => ({
              name: rule.id,
              text: describe(rule),
            })),
            footer: POLICY_DEFAULTS,
          });
        }
        await this.#onMessage(adapter, {
          ...command,
          messageId: `policy-${Date.now()}`,
          text: `Policy request: ${command.args.trim()}`,
        });
        return command.respond("Asked Nu to draft the change.");
      case "specialist": {
        const name = command.args.trim();
        if (!name)
          return command.respond(
            readSpecialists()
              .map((s) => `${s.name}: ${s.instructions}`)
              .join("\n") || "No specialists yet.",
          );
        if (name === AGENT_ID) delete this.#state.agents[conversation];
        else if (readSpecialist(name)) this.#state.agents[conversation] = name;
        else return command.respond(`No specialist ${name}.`);
        this.#save();
        return command.respond(
          name === AGENT_ID
            ? "This conversation is with Nu."
            : `This conversation is with ${name} now.`,
        );
      }
      case "model": {
        this.#models ??= createModels();
        const models = await this.#models;
        const settings = readSettings();
        const key = command.args.trim();
        if (!key) {
          const current = await models.current();
          return command.respond(
            current
              ? `Nu uses ${modelKey(current)}.`
              : "No model chosen. Pick one with /model <provider/model>.",
          );
        }
        const model = await models.find(key);
        if (!model) return command.respond(`No available model ${key}.`);
        writeSettings({
          ...settings,
          defaultProvider: model.provider,
          defaultModel: model.id,
        });
        return command.respond(`Nu uses ${key} from the next turn.`);
      }
      case "reload":
        return command.respond(
          reload() ? "Reloading Nu." : "Restart Nu to reload.",
        );
      case "tools": {
        const items = activeTools().map(({ manifest }) => ({
          name: manifest.name,
          text: `v${manifest.version}: ${manifest.description}`,
        }));
        if (!items.length) return command.respond("No tools are registered.");
        return command.respond(
          items.map((item) => `\`${item.name}\` ${item.text}`).join("\n"),
          { title: "Tools", items },
        );
      }
      case "mcp": {
        const items = (await mcpStatus()).map((server) => ({
          name: server.name,
          text: server.error
            ? `${server.target}\nerror: ${server.error}`
            : `${server.target}\n${server.tools.length} tools: ${server.tools.join(", ")}`,
        }));
        if (!items.length)
          return command.respond(
            "No MCP servers. Add one with nu mcp add on the host.",
          );
        return command.respond(
          items.map((item) => `\`${item.name}\` ${item.text}`).join("\n"),
          { title: "MCP servers", items },
        );
      }
      default: {
        const custom = clientView().commands[command.name];
        if (!custom)
          return command.respond(`Unknown command /${command.name}.`);
        const text = custom.message.replaceAll("{args}", command.args.trim());
        await this.#onMessage(adapter, {
          ...command,
          messageId: `command-${Date.now()}`,
          text,
        });
        return command.respond(`Sent: ${text}`);
      }
    }
  }

  #takeInbox(executionId: string, after: number) {
    const turn = this.#state.turns[executionId];
    const queue = turn ? (this.#state.inbox[turn.session] ?? []) : [];
    for (const queued of queue) queued.takenBy ??= executionId;
    this.#save();
    return {
      messages: queue
        .filter((queued) => queued.takenBy === executionId)
        .slice(after)
        .map((queued) => queued.text),
    };
  }

  async #executing(executionId: string, target: string) {
    const steps = await this.kernel.listSteps(executionId);
    const step = steps.findLast(
      (s) => s.target === target && s.status === "executing",
    );
    if (!step) throw new HttpError(403, `no ${target} step is executing`);
    return { stepId: step.stepId, args: step.args as Record<string, string> };
  }

  #adapter(place: Place) {
    const adapter = this.#adapters.get(place.channel);
    if (!adapter) throw new HttpError(409, `channel ${place.channel} is off`);
    return adapter;
  }

  async #messageSend(executionId: string) {
    const { args } = await this.#executing(executionId, "message_send");
    const place = args.to === "user" ? this.#userPlace() : this.#place(args.to);
    if (!place) throw new HttpError(400, `no conversation ${args.to}`);
    const adapter = this.#adapter(place);
    const paths = (args.files ?? []) as unknown as string[];
    if (paths.length && !adapter.sendFiles)
      throw new HttpError(409, `${adapter.name} cannot send files`);
    const files = await Promise.all(paths.map(workspaceFile));
    for (const part of split(args.text, adapter.limits.maxMessageLength))
      await adapter.reply(place.target, part);
    if (files.length) await adapter.sendFiles?.(place.target, files);
    return {};
  }

  async #backgroundTask(executionId: string) {
    const { stepId, args } = await this.#executing(
      executionId,
      "background_task",
    );
    const origin = this.#state.turns[executionId] ?? this.#userPlace();
    const adapter = this.#adapter(origin);
    const target =
      adapter.createThread && !origin.target.direct
        ? await adapter.createThread(origin.target, args.title)
        : origin.target;
    const conversation = target.threadId
      ? `${adapter.name}:${target.threadId}`
      : `task:${stepId}`;
    const place = { channel: adapter.name, target };
    this.#state.places[conversation] = place;
    await this.#startTurn({
      ...place,
      conversation,
      session: this.#session(conversation),
      message: args.instructions,
      idempotencyKey: `task:${stepId}`,
    });
    return { conversation };
  }

  async report(report: Report) {
    await this.#scheduledTurn({
      conversation: report.conversation ?? "main",
      message: report.text,
      idempotency_key: `${report.source}:${report.key ?? randomUUID()}`,
      trigger: report.source,
    });
  }

  async #scheduledTurn(body: Record<string, unknown>) {
    const conversation = String(body.conversation);
    const place =
      conversation === "main" && this.#state.places.main
        ? this.#userPlace()
        : this.#place(conversation);
    if (!place)
      throw new HttpError(409, `no place to post to for ${conversation}`);
    const executionId = await this.#startTurn({
      ...place,
      conversation,
      session: body.session
        ? String(body.session)
        : this.#session(conversation),
      message: String(body.message),
      idempotencyKey: String(body.idempotency_key),
      trigger: String(body.trigger ?? "schedule"),
    });
    return { execution_id: executionId };
  }

  async #follow(executionId: string) {
    const turn = this.#state.turns[executionId];
    const adapter = turn && this.#adapters.get(turn.channel);
    if (!adapter) return;
    if (adapter.name === "terminal") turn.approvals = [];
    const channelTurn =
      adapter.turn?.(turn.target) ?? textTurn(adapter, turn.target);
    let delivery = Promise.resolve();
    const handler: TurnHandler = {
      event: (event) => {
        if (event.type === "tool" && TOOL_ENDS.has(event.status))
          notify(this.hooks.tool_execution_end, "tool_execution_end", {
            executionId,
            conversation: turn.conversation,
            stepId: event.id,
            name: event.name,
            status: event.status as "done" | "failed" | "denied",
            args: event.args,
            result: event.result,
            error: event.error,
          });
        delivery = delivery
          .then(() => channelTurn.event(event))
          .catch((error) =>
            console.error(
              `gateway: delivering ${event.type} for ${executionId} failed`,
              error,
            ),
          );
        return delivery;
      },
    };
    if (!turn.quiet) void handler.event({ type: "started" });
    const events = new TurnEvents(handler);
    const live = new AbortController();
    const stream = !turn.quiet
      ? this.#stream(executionId, events, live.signal)
      : Promise.resolve();
    try {
      for await (const event of this.#events(executionId)) {
        if (event.type === "approval.requested")
          await this.#postApproval(executionId, turn, handler, event);
        if (!turn.quiet)
          await events.kernel(event, (id) =>
            this.kernel.getStep(executionId, id),
          );
        if (!TERMINAL.has(event.type)) continue;
        live.abort();
        const execution = await this.kernel.get(executionId);
        await stream;
        const ended = finished(execution, { quiet: true });
        if (turn.conversation.startsWith("policy:"))
          this.#ruleDone(
            turn.conversation.slice("policy:".length),
            ended.type === "finished" ? ended.text : "",
          );
        if (ended.type === "finished")
          notify(this.hooks.turn_end, "turn_end", {
            executionId,
            agent: turn.agentId,
            conversation: turn.conversation,
            status: ended.status,
            text: ended.text,
          });
        await handler.event(finished(execution, turn));
      }
    } catch (error) {
      live.abort();
      if (!(error instanceof NotFoundError)) {
        console.error(`following ${executionId} failed; retrying`, error);
        setTimeout(() => void this.#follow(executionId), 5000);
        return;
      }
      console.error(`following ${executionId} failed`, error);
    }
    live.abort();
    delete this.#state.turns[executionId];
    this.#save();
    await this.#startQueued(turn, executionId);
    if (this.#reloadWhenIdle && !Object.keys(this.#state.turns).length) {
      this.#reloadWhenIdle = false;
      reload();
    }
  }

  async #startQueued(turn: Turn, executionId: string) {
    const queue = this.#state.inbox[turn.session] ?? [];
    const left = queue.filter((queued) => !queued.takenBy);
    delete this.#state.inbox[turn.session];
    this.#save();
    if (!left.length || this.#busy(turn.session)) {
      if (left.length) this.#state.inbox[turn.session] = left;
      return;
    }
    const place = this.#state.places[turn.conversation] ?? turn;
    await this.#startTurn({
      channel: place.channel,
      target: place.target,
      agentId: turn.agentId,
      conversation: turn.conversation,
      session: turn.session,
      message: left.map((queued) => queued.text).join("\n\n"),
      idempotencyKey: `${place.channel}:${left[0].messageId}`,
    }).catch((error) =>
      console.error(`starting queued turn after ${executionId}`, error),
    );
  }

  async *#events(executionId: string): AsyncGenerator<Event> {
    let afterSeq = 0;
    while (true) {
      const events = await this.kernel.events(executionId, { afterSeq });
      for (const event of events) {
        afterSeq = event.eventSeq;
        yield event;
        if (TERMINAL.has(event.type)) return;
      }
      if (!events.length) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async #postApproval(
    executionId: string,
    turn: Turn,
    handler: TurnHandler,
    event: Event,
  ) {
    const { approval_id: id, step_id: stepId } = event.payload as {
      approval_id: string;
      step_id: string;
    };
    const posted = turn.approvals.includes(id);
    if (posted && this.#cards.has(id)) return;
    const [step, approval] = await Promise.all([
      this.kernel.getStep(executionId, stepId),
      this.kernel.getApproval(id),
    ]);
    if (approval.status !== "pending") return;
    const args = step.args as Record<string, unknown>;
    let summary: string;
    try {
      summary = await this.#summary(step.target, args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.kernel.denyApproval(id, { rationale: reason });
      await this.#adapter(turn).reply(
        turn.target,
        `Refused \`${step.target}\`: ${reason}`,
      );
      return;
    }
    if (step.target === "browser_handoff")
      summary += `\nOpen the page: ${liveLink(this.agents.secret, id)}`;
    const choices: ApprovalView["choices"] = ONCE_ONLY.has(step.target)
      ? [
          { decision: "once", label: "Allow once" },
          { decision: "deny", label: "Deny" },
        ]
      : [
          { decision: "once", label: "Allow once" },
          { decision: "always", label: `Always allow ${step.target}` },
          { decision: "rule", label: "Write a rule…" },
          { decision: "deny", label: "Deny" },
        ];
    const view = {
      id,
      target: step.target,
      summary,
      reason: approval.message,
      choices: this.#ruleRequests.has(id)
        ? choices.filter((choice) => choice.decision !== "rule")
        : choices,
    };
    this.#cards.set(id, { handler, view, choices });
    if (posted) return;
    await handler.event({ type: "approval", approval: view });
    turn.approvals.push(id);
    this.#save();
  }

  async #summary(target: string, args: Record<string, unknown>) {
    switch (target) {
      case "policy_update": {
        const { readback, changed } = await this.#editRules(args.changes);
        return [
          `Change policy: ${args.reason}`,
          ...readback.map((line) => `• ${line}`),
          changed.length
            ? `Past decisions that change (${changed.length}):\n${changed.slice(0, 10).join("\n")}`
            : "No past decisions change.",
        ].join("\n");
      }
      case "specialist_write": {
        const specialist = await this.#parseSpecialist(args);
        const { readback } = await this.#checkSpecialist(specialist);
        return [
          `${readSpecialist(specialist.name) ? "Replace" : "Create"} specialist **${specialist.name}**: ${specialist.instructions}`,
          `Tools: ${specialist.tools.map((t) => `\`${t}\``).join(", ") || "none"}. Memory scope: ${specialist.memory_scope}.`,
          "Rules:",
          ...(readback.length
            ? readback
            : ["(none; every tool call asks)"]
          ).map((line) => `• ${line}`),
        ].join("\n");
      }
      case "package_write":
        return writeSummary(args);
      case "package_install":
        return previewPackage(String(args.source), String(args.version));
      default:
        return summarize(target, args);
    }
  }

  async #parseSpecialist(args: Record<string, unknown>) {
    return validateSpecialist(parse(String(args.manifest)), [
      ...SEED_TOOLS,
      ...Object.keys(readIndex()),
      ...(await mcpStatus()).flatMap(({ name, tools }) => [
        `mcp__${name}__*`,
        ...tools.map((tool) => `mcp__${name}__${tool}`),
      ]),
    ]);
  }

  #checkSpecialist(specialist: Specialist, replay = true) {
    const existing = readSpecialist(specialist.name);
    return checkRules(
      (path, body) => this.#admin(path, body),
      existing ? specialist.name : AGENT_ID,
      (existing?.rules ?? []) as Rule[],
      specialist.rules,
      replay && Boolean(existing),
    );
  }

  #registerSpecialist(name: string) {
    return this.#admin("/v0/agents", {
      id: name,
      webhook_url: `${this.agents.webhookBase}/webhook/${name}`,
      secret: this.agents.secret,
    });
  }

  async #specialistWrite(executionId: string) {
    const { args } = await this.#executing(executionId, "specialist_write");
    const specialist = await this.#parseSpecialist(args);
    await this.#registerSpecialist(specialist.name);
    await this.#checkSpecialist(specialist);
    await this.#admin(`/v0/policies/${specialist.name}`, {
      bundle: assemble(specialist.rules),
    });
    writeSpecialist(specialist);
    void this.#recheckApprovals();
    return { name: specialist.name };
  }

  async #delegate(executionId: string) {
    const { stepId, args } = await this.#executing(executionId, "delegate");
    const specialist = readSpecialist(args.specialist);
    if (!specialist)
      throw new HttpError(404, `no specialist ${args.specialist}`);
    const origin = this.#state.turns[executionId] ?? this.#userPlace();
    const conversation = `${specialist.name}@task:${stepId}`;
    this.#state.places[conversation] = origin;
    const wait = (args.wait as unknown) !== false;
    await this.#startTurn({
      channel: origin.channel,
      target: origin.target,
      agentId: specialist.name,
      conversation,
      session: `${conversation}:0`,
      message: args.task,
      idempotencyKey: `delegate:${stepId}`,
      spawnedBy: wait ? { executionId, stepId } : undefined,
    });
    return wait ? { step_id: stepId } : { conversation };
  }

  async history(conversation: string): Promise<HistoryEntry[]> {
    const get = async <T>(path: string) => {
      const response = await fetch(`${this.kernelUrl}${path}`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    };
    const { executions } = await get<{
      executions: {
        id: string;
        status: string;
        input: { message?: string; trigger?: string } | null;
        output: { reply?: string } | null;
        failure_reason?: string;
      }[];
    }>(
      `/v0/executions?${new URLSearchParams({ session: this.#session(conversation), limit: "20" })}`,
    );
    const shown = executions
      .filter(
        (e) =>
          ["completed", "failed", "cancelled"].includes(e.status) &&
          !(e.input?.trigger && e.status === "completed" && !e.output?.reply),
      )
      .reverse();
    const turns = await Promise.all(
      shown.map(async (execution) => {
        const steps = await get<
          {
            kind: string;
            target: string;
            step_id: string;
            status: string;
            args: Record<string, unknown>;
            result?: unknown;
            error?: unknown;
            started_at?: string;
          }[]
        >(`/v0/executions/${execution.id}/steps`);
        steps.sort((a, b) =>
          (a.started_at ?? "").localeCompare(b.started_at ?? ""),
        );
        const { message = "", trigger } = execution.input ?? {};
        const entries: HistoryEntry[] = [
          trigger
            ? { type: "note", text: `${trigger}: ${message.split("\n")[0]}` }
            : { type: "user", text: message },
        ];
        const push = async (event: TurnEvent) => {
          entries.push({ type: "event", turn: execution.id, event });
        };
        const events = new TurnEvents({ event: push });
        for (const step of steps) {
          const result = step.result as {
            message?: AssistantMessage;
            messages?: unknown[];
          } | null;
          if (step.kind === "llm_call" && result?.message)
            await events.stream(
              step.step_id,
              result.message.content
                .map((block) =>
                  block.type === "text"
                    ? deltaLine("text", block.text)
                    : block.type === "thinking"
                      ? deltaLine("thinking", block.thinking)
                      : "",
                )
                .join(""),
            );
          else if (step.kind === "local" && step.target === "inbox")
            for (const text of result?.messages ?? [])
              if (typeof text === "string")
                entries.push({ type: "user", text });
          if (step.kind !== "tool_call") continue;
          await push({
            type: "tool",
            id: step.step_id,
            name: step.target,
            summary: summarize(step.target, step.args ?? {}),
            status: TOOL_STATUS[step.status] ?? "running",
            args: step.args,
            result: step.result,
            error: step.error,
          });
        }
        await push(
          finished(
            {
              status: execution.status,
              output: execution.output,
              failureReason: execution.failure_reason,
            },
            { quiet: Boolean(trigger) },
          ),
        );
        return entries;
      }),
    );
    return turns.flat();
  }

  #place(conversation: string): Place | undefined {
    const known = this.#state.places[conversation];
    if (known) return known;
    const split = conversation.indexOf(":");
    const channel = conversation.slice(0, split);
    if (split < 1 || !this.#adapters.has(channel)) return;
    return {
      channel,
      target: { conversationId: conversation.slice(split + 1), direct: false },
    };
  }

  #userPlace() {
    const places = Object.values(this.#state.direct).reverse();
    if (!places.length && this.#state.places.main)
      places.push(this.#state.places.main);
    const place =
      places.find((p) => {
        const adapter = this.#adapters.get(p.channel);
        return adapter && (adapter.reachable?.() ?? true);
      }) ?? places[0];
    if (!place) throw new HttpError(409, "the user has not messaged Nu yet");
    return place;
  }

  async #secretsRequest(executionId: string) {
    const { args } = await this.#executing(executionId, "secrets_request");
    const place = this.#userPlace();
    await this.#adapter(place).reply(
      place.target,
      `Nu asks for the secret **${args.name}**: ${args.reason}\nSend it with \`/secret ${args.name} <value>\`.`,
    );
    return {};
  }

  async #packageCheckout(executionId: string) {
    const { args } = await this.#executing(executionId, "package_checkout");
    return { dir: await checkoutPackage(String(args.namespace)) };
  }

  async #packageWrite(executionId: string) {
    const { args } = await this.#executing(executionId, "package_write");
    const { namespace, files } = validateWrite(args);
    const { pkg, previous } = await writeLocalPackage(namespace, files);
    await this.#requestMissing(pkg);
    const reloads = Boolean(
      pkg.extensions.length || previous?.extensions?.length,
    );
    if (reloads) this.#reloadWhenIdle = true;
    return {
      namespace,
      tools: pkg.tools.map(({ entry }) => entry.manifest.name),
      reloaded: reloads,
    };
  }

  async #requestMissing(pkg: FetchedPackage) {
    if (!this.#state.places.main) return;
    const place = this.#userPlace();
    const { secrets, config } = missingValues(pkg);
    for (const name of secrets)
      await this.#adapter(place).reply(
        place.target,
        `The ${pkg.namespace} package needs the secret **${name}**. Send it with \`/secret ${name} <value>\`.`,
      );
    for (const key of config)
      await this.#adapter(place).reply(
        place.target,
        `The ${pkg.namespace} package needs the setting **${key}**. Send it with \`/config ${pkg.namespace} ${key} <value>\`.`,
      );
  }

  async #policyUpdate(executionId: string) {
    const { args } = await this.#executing(executionId, "policy_update");
    const change = await this.#editRules(args.changes);
    await change.apply();
    return {};
  }

  async #packageInstall(executionId: string) {
    const { args } = await this.#executing(executionId, "package_install");
    const source = String(args.source);
    const {
      pkg,
      previous,
      tools: installed,
    } = await installRemotePackage(source, String(args.version));
    await this.#requestMissing(pkg);
    const reloads = Boolean(
      pkg.extensions.length || previous?.extensions?.length,
    );
    if (reloads) this.#reloadWhenIdle = true;
    return { tools: installed, rules: pkg.rules, reloaded: reloads };
  }

  async #packageRemove(executionId: string) {
    const { args } = await this.#executing(executionId, "package_remove");
    const reloads = Boolean(readPackages()[args.source]?.extensions?.length);
    if (!removePackage(args.source))
      throw new HttpError(404, `${args.source} is not installed`);
    if (reloads) this.#reloadWhenIdle = true;
    return { reloaded: reloads };
  }

  async #stream(executionId: string, events: TurnEvents, signal: AbortSignal) {
    try {
      const response = await fetch(
        `${this.kernelUrl}/v0/executions/${executionId}/stream`,
        {
          headers: this.apiKey
            ? { authorization: `Bearer ${this.apiKey}` }
            : {},
          signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(`HTTP ${response.status}`);
      let buffer = "";
      for await (const chunk of response.body.pipeThrough(
        new TextDecoderStream(),
      )) {
        buffer += chunk;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data:")) continue;
          const delta = JSON.parse(frame.slice(5)) as {
            step_id: string;
            data: string;
          };
          await events.stream(delta.step_id, delta.data);
        }
      }
    } catch (error) {
      if (!signal.aborted) console.warn(`stream for ${executionId}`, error);
    }
  }
}

function alwaysRule(target: string) {
  if (ONCE_ONLY.has(target)) return undefined;
  return {
    id: `always-${target}`,
    when:
      target === "package_write"
        ? { target, arguments: { extensions: { equals: false } } }
        : { target },
    // biome-ignore lint/suspicious/noThenProperty: policy rule syntax
    then: { decision: "allow" },
  };
}

async function workspaceFile(path: string) {
  try {
    return {
      name: basename(path),
      data: await sandbox.readFile(resolve(sandbox.workdir, path)),
    };
  } catch (error) {
    throw new HttpError(
      400,
      `${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

const MAX_ATTACHMENT = 25_000_000;

async function saveAttachments(message: InboundMessage) {
  const lines: string[] = [];
  if (!message.attachments?.length) return lines;
  const dir = join(
    sandbox.workdir,
    "attachments",
    message.messageId.replace(/[^\w-]/g, "_"),
  );
  for (const { name, url } of message.attachments) {
    const file = basename(name).replace(/[^\w.-]/g, "_") || "file";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get("content-length")) > MAX_ATTACHMENT)
        throw new Error("too large");
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_ATTACHMENT) throw new Error("too large");
      await sandbox.writeFile(join(dir, file), data);
      lines.push(`[attached ${join(dir, file)}]`);
    } catch (error) {
      lines.push(
        `[attachment ${file} could not be saved: ${error instanceof Error ? error.message : error}]`,
      );
    }
  }
  return lines;
}
