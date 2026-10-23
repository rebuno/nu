import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright-core";
import type { MemoryStore } from "./agent/memory.js";
import type { ChannelAdapter } from "./gateway/channel.js";
import { readPackages } from "./registry.js";
import type { Sandbox } from "./sandbox/index.js";
import { readSecrets } from "./secrets.js";
import { readSettings } from "./settings.js";

export type Report = {
  text: string;
  source: string;
  conversation?: string;
  key?: string;
};

export interface BrowserProvider {
  context(profile: string): Promise<BrowserContext>;
  // A link to the provider's own interactive view of the page. Without it, the
  // user gets Nu's view, streamed over CDP from a Chromium page.
  liveView?(page: Page): Promise<string>;
}

export type Watcher = (context: {
  report: (report: Report) => Promise<void>;
}) => void | Promise<void>;

type Awaitable<T> = T | Promise<T>;

export type BeforeAgentStartEvent = {
  agent: string;
  message: string;
  conversation: string;
  trigger?: string;
};

export type InputEvent = {
  text: string;
  channel: string;
  conversation: string;
};

export type InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string }
  | { action: "handled" };

export type TurnEndEvent = {
  executionId: string;
  agent: string;
  conversation: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
};

export type ToolExecutionEndEvent = {
  executionId: string;
  conversation: string;
  stepId: string;
  name: string;
  status: "done" | "failed" | "denied";
  args: unknown;
  result?: unknown;
  error?: unknown;
};

export type Hooks = {
  before_agent_start: (
    event: BeforeAgentStartEvent,
  ) => Awaitable<{ prompt?: string } | undefined>;
  input: (event: InputEvent) => Awaitable<InputEventResult | undefined>;
  turn_end: (event: TurnEndEvent) => Awaitable<void>;
  tool_execution_end: (event: ToolExecutionEndEvent) => Awaitable<void>;
};

export type GatewayHooks = {
  [E in "input" | "turn_end" | "tool_execution_end"]: Registered<E>[];
};

type Registered<E extends keyof Hooks> = {
  namespace: string;
  handler: Hooks[E];
};

export interface NuExtensionAPI {
  readonly config: Record<string, unknown>;
  secret(name: string): string | undefined;
  registerChannel(adapter: ChannelAdapter): void;
  registerMemoryStore(store: MemoryStore): void;
  registerBrowserProvider(provider: BrowserProvider): void;
  registerSandbox(sandbox: Sandbox): void;
  registerWatcher(watcher: Watcher): void;
  on<E extends keyof Hooks>(event: E, handler: Hooks[E]): void;
}

export type Extension = (nu: NuExtensionAPI) => void | Promise<void>;

export const EXTENSION_KEY = /^[A-Za-z][\w-]*$/;

export async function loadExtensions() {
  const settings = readSettings();
  const secrets = readSecrets();
  const loaded = {
    channels: [] as ChannelAdapter[],
    memory: undefined as MemoryStore | undefined,
    browser: undefined as BrowserProvider | undefined,
    sandbox: undefined as Sandbox | undefined,
    watchers: [] as { namespace: string; watcher: Watcher }[],
    hooks: {
      before_agent_start: [],
      input: [],
      turn_end: [],
      tool_execution_end: [],
    } as { [E in keyof Hooks]: Registered<E>[] },
  };
  const entries = Object.values(readPackages()).flatMap(
    ({ namespace, extensions = [], secrets: declared = [] }) =>
      extensions.map((path) => ({ namespace, path, declared })),
  );
  for (const { namespace, path, declared } of entries) {
    try {
      const { default: extension } = (await import(
        pathToFileURL(path).href
      )) as {
        default: Extension;
      };
      await extension({
        config: settings.config?.[namespace] ?? {},
        secret: (name) => {
          const value = declared.includes(name) ? secrets[name] : undefined;
          return typeof value === "string" ? value : undefined;
        },
        registerChannel: (adapter) => loaded.channels.push(adapter),
        registerMemoryStore: (store) => {
          if (loaded.memory)
            throw new Error("another extension registered a memory store");
          loaded.memory = store;
        },
        registerBrowserProvider: (provider) => {
          if (loaded.browser)
            throw new Error("another extension registered a browser provider");
          loaded.browser = provider;
        },
        registerSandbox: (sandbox) => {
          if (loaded.sandbox)
            throw new Error("another extension registered a sandbox");
          loaded.sandbox = sandbox;
        },
        registerWatcher: (watcher) =>
          loaded.watchers.push({ namespace, watcher }),
        on: (event, handler) => {
          const hooks = loaded.hooks[event] as Registered<typeof event>[];
          if (!hooks) throw new Error(`unknown event ${event}`);
          hooks.push({ namespace, handler });
        },
      });
    } catch (error) {
      console.error(
        `nu: extension ${path} failed to load:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return loaded;
}

const failed = (namespace: string, event: string) => (error: unknown) =>
  console.error(
    `nu: ${namespace} ${event} handler failed:`,
    error instanceof Error ? error.message : error,
  );

export function notify<E extends "turn_end" | "tool_execution_end">(
  hooks: Registered<E>[],
  event: E,
  value: Parameters<Hooks[E]>[0],
) {
  for (const { namespace, handler } of hooks)
    Promise.resolve()
      .then(() => (handler as (value: unknown) => unknown)(value))
      .catch(failed(namespace, event));
}

export async function runInput(
  hooks: Registered<"input">[],
  event: InputEvent,
): Promise<string | undefined> {
  let text = event.text;
  for (const { namespace, handler } of hooks) {
    try {
      const result = await handler({ ...event, text });
      if (result?.action === "handled") return undefined;
      if (result?.action === "transform") text = result.text;
    } catch (error) {
      failed(namespace, "input")(error);
    }
  }
  return text;
}

export async function promptAdditions(
  hooks: Registered<"before_agent_start">[],
  event: BeforeAgentStartEvent,
) {
  const additions: string[] = [];
  for (const { namespace, handler } of hooks) {
    try {
      const prompt = (await handler(event))?.prompt;
      if (prompt?.trim()) additions.push(prompt.trim());
    } catch (error) {
      failed(namespace, "before_agent_start")(error);
    }
  }
  return additions;
}
