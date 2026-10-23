import { stdin, stdout } from "node:process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  CustomEditor,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  getSelectListTheme,
  highlightCode,
  keyHint,
  rawKeyHint,
  ToolExecutionComponent,
  type ToolRenderers,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  getKeybindings,
  Key,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TruncatedText,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import pkg from "../../package.json" with { type: "json" };
import type {
  ApprovalDecision,
  ApprovalView,
  CommandInfo,
  ListView,
  TurnEvent,
} from "../gateway/channel.js";
import type { HistoryEntry } from "../gateway/events.js";
import type { ToolDisplay } from "../registry.js";
import { frames, request } from "./http.js";

const WORKSPACE_DIR = process.cwd();
const REPLY = "Reply instead";

import {
  besideMark,
  editorTheme,
  SplitLine,
  setupUi,
  theme,
  WorkingIndicator,
} from "./ui.js";

type ToolEvent = Extract<TurnEvent, { type: "tool" }>;

const RENDERERS: Record<
  string,
  ConstructorParameters<typeof ToolExecutionComponent>[4]
> = {
  shell: createBashToolDefinition(WORKSPACE_DIR),
  read: createReadToolDefinition(WORKSPACE_DIR),
  write: createWriteToolDefinition(WORKSPACE_DIR),
  edit: createEditToolDefinition(WORKSPACE_DIR),
};

const summaryRenderer = (summary: string): ToolRenderers => ({
  renderCall: (_args, theme) =>
    new Text(theme.fg("toolTitle", summary.replace(/\s+/g, " ")), 0, 0),
});

const displayRenderer = (
  display: ToolDisplay,
  summary: string,
): ToolRenderers => ({
  renderCall: (args, theme) => {
    const values = (args ?? {}) as Record<string, unknown>;
    const title = display.title
      ? display.title.replace(/\{(\w+)\}/g, (_, key: string) => {
          const value = values[key];
          if (value === undefined) return "";
          return typeof value === "string" ? value : JSON.stringify(value);
        })
      : (summary.split("\n")[0] ?? "");
    const head = theme.fg(
      "toolTitle",
      `${display.icon ? `${display.icon} ` : ""}${title}`.replace(/\s+/g, " "),
    );
    const body = display.body ? values[display.body] : undefined;
    return new Text(
      typeof body === "string" && body
        ? [head, ...highlightCode(body, display.language)].join("\n")
        : head,
      0,
      0,
    );
  },
});

const errorText = (error: unknown) =>
  typeof error === "string"
    ? error
    : ((error as { message?: string } | null)?.message ??
      JSON.stringify(error));

function toolResult(event: ToolEvent) {
  const text = (value: string, isError: boolean) => ({
    content: [{ type: "text", text: value }],
    isError,
  });
  if (event.status === "denied") return text("Denied.", true);
  if (event.status === "failed") return text(errorText(event.error), true);
  if (typeof event.result === "string") return text(event.result, false);
  const result = event.result as {
    content?: { type: string; text?: string }[];
    details?: unknown;
    isError?: boolean;
  } | null;
  if (!Array.isArray(result?.content))
    return text(JSON.stringify(event.result ?? null, null, 2), false);
  return {
    content: result.content,
    details: result.details,
    isError: result.isError ?? false,
  };
}

export async function chat() {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("nu needs an interactive terminal");
  const controller = new AbortController();
  const history = (await (await request("history")).json()) as HistoryEntry[];
  let response = await request("events", undefined, "GET", controller.signal);
  let connected = true;

  setupUi();
  const ui = new TuiMainScreen(new ProcessTerminal());
  const messages = new Container();
  const editorContainer = new Container();
  const footer = new SplitLine();
  const editor = new CustomEditor(
    ui,
    editorTheme(),
    getKeybindings() as never,
    { paddingX: 1, embedWorkingStatus: true },
  );
  let view: { tools: Record<string, ToolDisplay>; commands: CommandInfo[] } = {
    tools: {},
    commands: [],
  };
  const setCommands = () =>
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(view.commands, process.cwd()),
    );
  setCommands();
  editorContainer.addChild(editor);
  const title = `${theme().bold("nu")} ${theme().fg("dim", `v${pkg.version}`)}`;
  const hints = [
    keyHint("app.interrupt", "stop"),
    rawKeyHint("ctrl+c/ctrl+d", "detach"),
    rawKeyHint("/", "commands"),
    keyHint("app.tools.expand", "expand tools"),
  ].join(theme().fg("muted", " · "));
  ui.addChild(new Spacer(1));
  const header = new Text(`${besideMark([title])}\n\n${hints}`, 1, 0);
  ui.addChild(header);
  ui.addChild(messages);
  ui.addChild(new Spacer(1));
  ui.addChild(editorContainer);
  ui.addChild(footer);
  ui.setFocus(editor);

  type Turn = {
    assistant?: AssistantMessageComponent;
    text: string;
    thinking: string;
    paused: boolean;
    compacting?: boolean;
    tools: Map<string, ToolExecutionComponent>;
    open: Set<string>;
  };
  const turns = new Map<string, Turn>();
  const cards: ToolExecutionComponent[] = [];
  const pending: (ApprovalView & { turn?: string })[] = [];
  let expanded = false;
  let selecting = false;
  let writing = false;
  let replying = false;
  let showing: "editor" | "approval" | "picker" = "editor";
  let indicator: WorkingIndicator | undefined;
  let working: string | undefined;
  let model = "";
  let thinking = "medium";

  const select = (
    component: Component,
    focus: Component,
    as: "approval" | "picker",
  ) => {
    showing = as;
    editorContainer.clear();
    editorContainer.addChild(component);
    ui.setFocus(focus);
    ui.requestRender();
  };
  const restoreEditor = () => {
    showing = "editor";
    editorContainer.clear();
    editorContainer.addChild(editor);
    ui.setFocus(editor);
    ui.requestRender();
  };
  const renderFooter = () => {
    const state = !connected
      ? "reconnecting"
      : pending.length
        ? `${pending.length} pending approval${pending.length === 1 ? "" : "s"}${showing === "editor" ? " (send to deny, or clear the message to decide)" : ""}`
        : turns.size
          ? "working"
          : "ready";
    footer.left = theme().fg("dim", `main conversation  •  ${state}`);
    footer.right = theme().fg(
      "dim",
      [model, thinking].filter(Boolean).join(" • "),
    );
    ui.requestRender();
  };
  const updateWorking = () => {
    const active = [...turns.values()];
    const message = active.some((turn) => turn.compacting)
      ? "Compacting conversation…"
      : replying && pending.length
        ? "Reply to Nu; sending denies the call"
        : active.some((turn) => !turn.paused)
          ? `Working... (${keyHint("app.interrupt", "to stop")})`
          : active.length || pending.length
            ? "Waiting for approval"
            : undefined;
    if (message !== working) {
      working = message;
      indicator?.dispose();
      indicator = message ? new WorkingIndicator(ui, message) : undefined;
      indicator?.start();
      editor.setWorkingStatusIndicator(indicator as never);
    }
    renderFooter();
  };
  type ModelList = {
    models: { key: string; name: string }[];
    current: string;
    thinking: string;
  };
  const getModels = async () =>
    (await (await request("models")).json()) as ModelList;
  const refreshModel = async () => {
    const data = await getModels();
    model = data.current;
    thinking = data.thinking;
    renderFooter();
  };

  const info = (value: string) => {
    if (!value) return;
    messages.addChild(new Spacer(1));
    messages.addChild(new Text(value, 1, 0));
    ui.requestRender();
  };
  const post = async (route: string, body: unknown) => {
    const result = await request(route, body, "POST", controller.signal);
    const data = (await result.json()) as { message?: string; error?: string };
    if (!result.ok) throw new Error(data.error ?? `HTTP ${result.status}`);
    return data.message ?? "";
  };
  const report = (error: unknown) => {
    if (controller.signal.aborted) return;
    messages.addChild(new Spacer(1));
    messages.addChild(
      new TruncatedText(
        theme().fg(
          "error",
          error instanceof Error ? error.message : String(error),
        ),
        1,
        0,
      ),
    );
    ui.requestRender();
  };
  const showList = ({ title, items, footer }: ListView) => {
    const t = theme();
    messages.addChild(new Spacer(1));
    messages.addChild(
      new Text(
        [
          t.bold(title),
          ...items.map(({ name, text }) => {
            const [first, ...rest] = text.split("\n");
            return [
              `${t.fg("accent", name)} ${first}`,
              ...rest.map((line) => t.fg("dim", line)),
            ].join("\n");
          }),
          ...(footer ? [t.fg("dim", footer)] : []),
        ].join("\n\n"),
        1,
        0,
      ),
    );
    ui.requestRender();
  };
  const command = async (name: string, args = "") => {
    const result = await request(
      "command",
      { name, args },
      "POST",
      controller.signal,
    );
    const data = (await result.json()) as {
      message?: string;
      view?: ListView;
      error?: string;
    };
    if (!result.ok) throw new Error(data.error ?? `HTTP ${result.status}`);
    if (data.view) showList(data.view);
    else info(data.message ?? "");
    if (name === "model") await refreshModel();
  };
  const renderAssistant = (
    turn: Turn,
    done = false,
    status?: string,
    errorMessage?: string,
  ) => {
    if (!turn.assistant) {
      turn.assistant = new AssistantMessageComponent(undefined, false);
      messages.addChild(turn.assistant);
    }
    const message: AssistantMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "nu",
      model: "nu",
      content: [
        ...(turn.thinking
          ? [{ type: "thinking" as const, thinking: turn.thinking }]
          : []),
        ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: done
        ? status === "failed"
          ? "error"
          : status === "cancelled"
            ? "aborted"
            : "stop"
        : "pending",
      errorMessage,
      timestamp: Date.now(),
    };
    turn.assistant.updateContent(message, !done);
  };
  const endMessage = (turn: Turn) => {
    if (turn.assistant) renderAssistant(turn, true);
    turn.assistant = undefined;
    turn.text = "";
    turn.thinking = "";
  };
  const pickModel = async () => {
    const data = await getModels();
    if (!data.models.length) {
      info("No models available. Run nu login <provider>.");
      return;
    }
    const selector = new SelectList(
      data.models.map((m) => ({
        value: m.key,
        label: m.key,
        description: m.name,
      })),
      12,
      getSelectListTheme(),
    );
    const current = data.models.findIndex((m) => m.key === data.current);
    if (current >= 0) selector.setSelectedIndex(current);
    selector.onSelect = ({ value }) => {
      restoreEditor();
      void command("model", value).catch(report);
    };
    selector.onCancel = restoreEditor;
    select(selector, selector, "picker");
  };
  const toggleTools = () => {
    expanded = !expanded;
    for (const card of cards) card.setExpanded(expanded);
    ui.requestRender();
  };
  // A card arriving mid-message waits until the message is sent or cleared, so
  // the keys typed for the message never decide it.
  const showApproval = () => {
    const approval = pending.at(-1);
    if (!approval) {
      if (showing === "approval") restoreEditor();
      return;
    }
    if (showing === "editor" && (replying || editor.getText().trim())) {
      renderFooter();
      return;
    }
    const title = [
      RENDERERS[approval.target]
        ? `${approval.target} needs approval`
        : approval.summary,
      approval.reason && theme().fg("muted", approval.reason),
      approval.status && theme().fg("dim", approval.status),
    ]
      .filter(Boolean)
      .join("\n");
    const decide = (decision: ApprovalDecision, text?: string) => {
      if (selecting) return;
      selecting = true;
      void post("approval", { approvalId: approval.id, decision, text })
        .then((message) => {
          if (decision !== "rule") {
            const index = pending.findIndex((item) => item.id === approval.id);
            if (index !== -1) pending.splice(index, 1);
          }
          if (decision !== "once" && decision !== "deny")
            info(theme().fg("dim", message));
          showApproval();
          updateWorking();
        })
        .catch(report)
        .finally(() => {
          selecting = false;
        });
    };
    const selector = new ExtensionSelectorComponent(
      title,
      [...approval.choices.map((choice) => choice.label), REPLY],
      (label) => {
        if (label === REPLY) {
          replying = true;
          restoreEditor();
          updateWorking();
          return;
        }
        const decision =
          approval.choices.find((choice) => choice.label === label)?.decision ??
          "deny";
        if (decision !== "rule") return decide(decision);
        const done = (text?: string) => {
          writing = false;
          if (text?.trim()) decide("rule", text);
          else showApproval();
        };
        writing = true;
        const input = new ExtensionInputComponent(
          "Describe the rule for this call",
          undefined,
          done,
          () => done(),
          { tui: ui },
        );
        select(input, input, "approval");
      },
      () => decide("deny"),
      { tui: ui, onToggleToolsExpanded: toggleTools },
    );
    select(selector, selector, "approval");
  };
  const tool = (turn: Turn, event: ToolEvent) => {
    let card = turn.tools.get(event.id);
    if (!card) {
      card = new ToolExecutionComponent(
        event.name,
        event.id,
        event.args ?? {},
        {},
        RENDERERS[event.name] ??
          (view.tools[event.name]
            ? displayRenderer(view.tools[event.name], event.summary)
            : summaryRenderer(event.summary)),
        ui,
        WORKSPACE_DIR,
      );
      card.setArgsComplete();
      card.setExpanded(expanded);
      turn.tools.set(event.id, card);
      turn.open.add(event.id);
      cards.push(card);
      messages.addChild(card);
    }
    if (event.status === "running") card.markExecutionStarted();
    else if (event.status !== "waiting") {
      turn.open.delete(event.id);
      card.updateResult(toolResult(event), false);
    }
  };
  const event = ({ turn: id, event }: { turn?: string; event: TurnEvent }) => {
    if (event.type === "message") {
      info(event.text);
      return;
    }
    if (event.type === "approval") {
      const index = pending.findIndex(
        (approval) => approval.id === event.approval.id,
      );
      if (!event.approval.choices.length) {
        if (index !== -1) pending.splice(index, 1);
        if (event.approval.status)
          info(theme().fg("dim", event.approval.status));
      } else if (index !== -1)
        pending[index] = { ...event.approval, turn: pending[index].turn };
      else pending.push({ ...event.approval, turn: id });
      if (showing !== "picker" && !writing) showApproval();
      updateWorking();
      return;
    }
    if (!id) return;
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        text: "",
        thinking: "",
        paused: false,
        tools: new Map(),
        open: new Set(),
      };
      turns.set(id, turn);
    }
    turn.paused = event.type === "paused";
    switch (event.type) {
      case "text":
        if (!event.text) endMessage(turn);
        else {
          turn.text = event.text;
          renderAssistant(turn);
        }
        break;
      case "thinking":
        turn.thinking = event.text;
        if (turn.thinking || turn.assistant) renderAssistant(turn);
        break;
      case "paused":
        endMessage(turn);
        break;
      case "compaction":
        turn.compacting = event.status === "running";
        break;
      case "tool":
        tool(turn, event);
        break;
      case "finished":
        if (event.status !== "completed")
          renderAssistant(turn, true, event.status, event.text);
        else if (event.text) {
          turn.text = event.text;
          renderAssistant(turn, true, event.status);
        }
        for (const open of turn.open)
          turn.tools.get(open)?.updateResult(
            {
              content: [
                {
                  type: "text",
                  text: `Not finished: the turn ${event.status}.`,
                },
              ],
              isError: true,
            },
            false,
          );
        turns.delete(id);
        for (let i = pending.length - 1; i >= 0; i--)
          if (pending[i].turn === id) pending.splice(i, 1);
        showApproval();
        break;
    }
    updateWorking();
  };
  for (const entry of history) {
    if (entry.type === "event") event(entry);
    else if (entry.type === "note") info(theme().fg("dim", entry.text));
    else {
      messages.addChild(new Spacer(1));
      messages.addChild(new UserMessageComponent(entry.text));
    }
  }
  editor.onSubmit = (value) => {
    if (!value.trim()) return;
    replying = false;
    updateWorking();
    editor.setText("");
    if (value.startsWith("/")) {
      const [name, ...args] = value.slice(1).split(/\s+/);
      if (name === "model" && !args.join("")) void pickModel().catch(report);
      else void command(name, args.join(" ")).catch(report);
    } else {
      editor.addToHistory(value);
      messages.addChild(new Spacer(1));
      messages.addChild(new UserMessageComponent(value));
      void post("message", { text: value }).catch(report);
    }
    ui.requestRender();
  };
  let draft = "";
  editor.onChange = (text) => {
    const cleared = draft.trim() && !text.trim();
    draft = text;
    if (!cleared) return;
    replying = false;
    updateWorking();
    if (pending.length && showing === "editor") showApproval();
  };
  editor.onEscape = () => {
    if (turns.size) void post("command", { name: "stop" }).catch(report);
  };
  editor.onAction("app.tools.expand", toggleTools);
  ui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      controller.abort();
      return { consume: true };
    }
    return undefined;
  });
  const detach = () => controller.abort();
  process.once("SIGTERM", detach);
  ui.start();
  renderFooter();
  void refreshModel().catch(report);
  void request("client")
    .then(async (response) => {
      const info = (await response.json()) as typeof view & {
        update?: string;
      };
      view = info;
      setCommands();
      if (info.update) {
        header.setText(
          `${besideMark([title, theme().fg("warning", info.update)])}\n\n${hints}`,
        );
        ui.requestRender();
      }
    })
    .catch(report);
  try {
    for (let attempt = 0; !controller.signal.aborted; ) {
      try {
        for await (const frame of frames(response)) {
          attempt = 0;
          event(frame as { turn?: string; event: TurnEvent });
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        if (!(error instanceof TypeError)) throw error;
      }
      if (controller.signal.aborted) break;
      connected = false;
      renderFooter();
      for (;;) {
        if (++attempt > 30)
          throw new Error("Gateway disconnected. Run nu again to resume.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          response = await request(
            "events",
            undefined,
            "GET",
            controller.signal,
          );
          break;
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
      }
      connected = true;
      renderFooter();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort();
    indicator?.dispose();
    process.removeListener("SIGTERM", detach);
    ui.stop();
  }
}
