import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { Agent as Loop, type StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import { type BrowserContext, chromium, type Page } from "playwright";
import { execution, resource, step } from "rebuno";

import { DATA_DIR } from "../../config.js";
import type { BrowserProvider } from "../../extensions.js";
import { type AnyTool, anyTool, type NuTool, text } from "./tool.js";

const PROFILES_DIR = join(DATA_DIR, "browser");
const MAX_PAGES = 5;
const MAX_ACTIONS = 40;
const MAX_SNAPSHOT = 30_000;
const ACTION_TIMEOUT = 10_000;

let provider: BrowserProvider = {
  context: (profile) =>
    chromium.launchPersistentContext(join(PROFILES_DIR, profile), {
      headless: true,
    }),
};

export function useBrowserProvider(next: BrowserProvider) {
  provider = next;
}

type Binding = { profile: string; session: string };
type Handle = Binding & { page: Page; reset: boolean };
export type Inner = { model: Model<Api>; streamFn: StreamFn };

const contexts = new Map<string, Promise<BrowserContext>>();
const pages = new Map<string, Page>();
const handles = new Map<string, Handle>();
const recorded = new WeakSet<Handle>();

function context(profile: string) {
  let opened = contexts.get(profile);
  if (!opened) {
    opened = provider.context(profile);
    opened.then((ctx) => ctx.on("close", () => contexts.delete(profile)));
    contexts.set(profile, opened);
  }
  return opened;
}

async function newPage(binding: Binding) {
  const page = await (await context(binding.profile)).newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT);
  pages.set(binding.session, page);
  for (const [session, old] of [...pages].slice(0, -MAX_PAGES)) {
    pages.delete(session);
    await old.close().catch(() => {});
  }
  return page;
}

// Pages live in this process. A later dispatch whose page is gone, after a
// restart or once the page was closed, starts a new page from the profile.
const driver = (profile: string) => ({
  driverId: "nu-browser-local",
  create: async () => {
    const binding = { profile, session: randomUUID() };
    return {
      handle: { ...binding, page: await newPage(binding), reset: false },
      binding,
    };
  },
  open: async (binding: Binding): Promise<Handle> => {
    const page = pages.get(binding.session);
    if (page && !page.isClosed()) return { ...binding, page, reset: false };
    return { ...binding, page: await newPage(binding), reset: true };
  },
});

const handleKey = (profile: string) => `${execution().id}:${profile}`;

async function openBrowser(profile: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile))
    throw new Error("a profile name has letters, digits, - and _ only");
  const handle = await resource<Handle, Binding>(`browser.${profile}`, {
    driver: driver(profile),
  });
  if (handle.reset && !recorded.has(handle)) {
    recorded.add(handle);
    await step("browser_reset", () => ({ reset: true }), {
      profile,
      session: handle.session,
    });
  }
  handles.set(handleKey(profile), handle);
}

function browser(profile: string) {
  const handle = handles.get(handleKey(profile));
  if (!handle) throw new Error(`browser profile ${profile} is not open`);
  return handle;
}

const GUARD = () => {
  const w = window as unknown as { __nuGuard?: boolean; __nuBlocked?: number };
  if (w.__nuGuard !== undefined) {
    w.__nuGuard = true;
    return;
  }
  w.__nuGuard = true;
  w.__nuBlocked = 0;
  document.addEventListener(
    "submit",
    (event) => {
      if (!w.__nuGuard) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      w.__nuBlocked = (w.__nuBlocked ?? 0) + 1;
    },
    true,
  );
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (w.__nuGuard) w.__nuBlocked = (w.__nuBlocked ?? 0) + 1;
    else submit.call(this);
  };
};

async function describe(page: Page) {
  const snapshot = await page
    .ariaSnapshot({ mode: "ai" })
    .catch((error) => `(no snapshot: ${error.message})`);
  return [
    `URL: ${page.url()}`,
    `Title: ${await page.title().catch(() => "")}`,
    "",
    snapshot.length > MAX_SNAPSHOT
      ? `${snapshot.slice(0, MAX_SNAPSHOT)}\n(truncated)`
      : snapshot,
  ].join("\n");
}

function notice(handle: Handle) {
  if (!handle.reset) return "";
  handle.reset = false;
  return "The browser page was reset since the last call; navigate again if needed.\n\n";
}

const ref = (r: string) => `aria-ref=${r}`;
const profileArg = Type.Optional(
  Type.String({ description: "Browser profile, `default` if omitted" }),
);

async function runTask(page: Page, task: string, inner: Inner) {
  let actions = 0;
  let summary = "";
  const act = (
    name: string,
    description: string,
    parameters: ReturnType<typeof Type.Object>,
    run: (args: Record<string, string>) => Promise<unknown>,
  ): AnyTool =>
    anyTool({
      name,
      label: name,
      description,
      parameters,
      execute: async (_id, args) => {
        if (++actions > MAX_ACTIONS) throw new Error("too many actions");
        await page.evaluate(GUARD).catch(() => {});
        await run(args as Record<string, string>);
        await page.waitForLoadState().catch(() => {});
        await page.evaluate(GUARD).catch(() => {});
        return text(await describe(page));
      },
    });
  const tools = [
    act("goto", "Open a URL.", Type.Object({ url: Type.String() }), ({ url }) =>
      page.goto(url),
    ),
    act(
      "click",
      "Click the element with a ref from the snapshot.",
      Type.Object({ ref: Type.String() }),
      (args) => page.locator(ref(args.ref)).click(),
    ),
    act(
      "fill",
      "Replace the text in a field.",
      Type.Object({ ref: Type.String(), text: Type.String() }),
      (args) => page.locator(ref(args.ref)).fill(args.text),
    ),
    act(
      "select",
      "Choose an option in a select element by its label.",
      Type.Object({ ref: Type.String(), option: Type.String() }),
      (args) =>
        page.locator(ref(args.ref)).selectOption({ label: args.option }),
    ),
    act(
      "press",
      "Press a key, such as Enter or ArrowDown.",
      Type.Object({ key: Type.String() }),
      ({ key }) => page.keyboard.press(key),
    ),
    anyTool({
      name: "done",
      label: "done",
      description:
        "Finish, with a summary of what you did and what is left for the submission.",
      parameters: Type.Object({ summary: Type.String() }),
      execute: async (_id, args) => {
        summary = args.summary;
        return { ...text("Done."), terminate: true };
      },
    }),
  ];
  const loop = new Loop({
    initialState: {
      systemPrompt:
        "You operate a web browser to carry out a task. Elements in a snapshot carry refs like [ref=e4]; act on them with the tools. Form submissions are blocked during the task: fill in everything, then stop before the final submit, purchase, or send, and call done with a summary of what is ready to submit. If the page needs a login you were not given, a CAPTCHA or other human check, or a verification code, stop and call done saying what the user has to complete.",
      model: inner.model,
      tools,
      messages: [],
    },
    streamFn: inner.streamFn,
    toolExecution: "sequential",
  });
  const abort = () => loop.abort();
  execution().signal.addEventListener("abort", abort);
  try {
    await loop.prompt(
      `Task: ${task}\n\nCurrent page:\n${await describe(page)}`,
    );
  } finally {
    execution().signal.removeEventListener("abort", abort);
  }
  if (execution().signal.aborted)
    throw new Error("the dispatch lease was lost");
  if (loop.state.errorMessage) throw new Error(loop.state.errorMessage);
  return summary || "The task ended without a summary.";
}

async function choose(page: Page, args: Record<string, string>, inner: Inner) {
  let choice: { ref?: string; mismatch?: string } = {};
  const loop = new Loop({
    initialState: {
      systemPrompt:
        "You check a web page before a submission. Call submit with the ref of the one control that performs the described submission when the page matches the description, or mismatch when it does not.",
      model: inner.model,
      tools: [
        anyTool({
          name: "submit",
          label: "submit",
          description: "The control that performs the submission.",
          parameters: Type.Object({ ref: Type.String() }),
          execute: async (_id, { ref }) => {
            choice = { ref };
            return { ...text("OK"), terminate: true };
          },
        }),
        anyTool({
          name: "mismatch",
          label: "mismatch",
          description: "The page does not match the described submission.",
          parameters: Type.Object({ reason: Type.String() }),
          execute: async (_id, { reason }) => {
            choice = { mismatch: reason };
            return { ...text("OK"), terminate: true };
          },
        }),
      ],
      messages: [],
    },
    streamFn: inner.streamFn,
  });
  await loop.prompt(
    `Submission: ${args.action}\nWhat is submitted: ${args.summary}\n\nPage:\n${await describe(page)}`,
  );
  if (loop.state.errorMessage) throw new Error(loop.state.errorMessage);
  return choice;
}

export function browserTools(model?: Inner) {
  const inner = () => {
    if (!model) throw new Error("no model for browser tasks");
    return model;
  };
  const withBrowser = (tool: AnyTool): NuTool => ({
    ...tool,
    before: (params) =>
      openBrowser((params as { profile?: string }).profile ?? "default"),
  });

  const observe = withBrowser(
    anyTool({
      name: "browser_observe",
      label: "Observe page",
      description:
        "Read the current page of a browser profile as an accessibility snapshot, opening a URL first if given. Profiles keep their cookies and logins between turns.",
      parameters: Type.Object({
        profile: profileArg,
        url: Type.Optional(Type.String()),
      }),
      execute: async (_id, { profile, url }) => {
        const handle = browser(profile ?? "default");
        if (url) await handle.page.goto(url);
        return text(notice(handle) + (await describe(handle.page)));
      },
    }),
  );

  const task = withBrowser(
    anyTool({
      name: "browser_task",
      label: "Browser task",
      description:
        "Carry out a described task in a browser profile, such as filling in a form, stopping before any submission. Form submissions are blocked during the task; use browser_submit for the final one.",
      parameters: Type.Object({ profile: profileArg, task: Type.String() }),
      execute: async (_id, args) => {
        const handle = browser(args.profile ?? "default");
        const summary = await runTask(handle.page, args.task, inner());
        return text(
          `${notice(handle)}${summary}\n\n${await describe(handle.page)}`,
        );
      },
    }),
  );

  const submit = withBrowser(
    anyTool({
      name: "browser_submit",
      label: "Submit",
      description:
        "Perform one submission on the current page of a browser profile, after checking that the page matches the description. `site` is the page's domain, `action` the button or action (such as 'Place order'), and `summary` what is submitted.",
      parameters: Type.Object({
        profile: profileArg,
        site: Type.String(),
        action: Type.String(),
        summary: Type.String(),
      }),
      execute: async (_id, args) => {
        const handle = browser(args.profile ?? "default");
        const { page } = handle;
        const host = new URL(page.url()).hostname;
        if (host !== args.site && !host.endsWith(`.${args.site}`))
          throw new Error(`the page is on ${host}, not ${args.site}`);
        const choice = await choose(page, args, inner());
        if (!choice.ref)
          throw new Error(`the page does not match: ${choice.mismatch}`);
        await page.evaluate(() => {
          (window as unknown as { __nuGuard?: boolean }).__nuGuard = false;
        });
        await page.locator(ref(choice.ref)).click();
        await page.waitForLoadState().catch(() => {});
        return text(notice(handle) + (await describe(page)));
      },
    }),
  );

  const handoff = withBrowser(
    anyTool({
      name: "browser_handoff",
      label: "Hand off to user",
      description:
        "Ask the user to complete a step in a browser profile themselves, such as a login, a CAPTCHA, or a verification code. The user gets a link to an interactive view of the current page and approves this call when done; the result is the page afterwards. The profile keeps the login for later tasks.",
      parameters: Type.Object({
        profile: profileArg,
        reason: Type.String({
          description: "What the user needs to do on the page",
        }),
      }),
      execute: async (_id, { profile }) => {
        const handle = browser(profile ?? "default");
        return text(notice(handle) + (await describe(handle.page)));
      },
    }),
  );
  return { observe, task, submit, handoff };
}

type LiveInput =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string };

async function applyInput(page: Page, input: LiveInput) {
  switch (input.type) {
    case "click":
      return page.mouse.click(input.x, input.y);
    case "scroll":
      await page.mouse.move(input.x, input.y);
      return page.mouse.wheel(0, input.dy);
    case "text":
      return page.keyboard.insertText(input.text.slice(0, 1000));
    case "key":
      return page.keyboard.press(input.key.slice(0, 32));
  }
}

// The user's view of a page handed off by an execution: the provider's link,
// a stream of screencast frames, or one input event. The submission guard is
// off while the user acts on the page.
export async function serveLive(
  req: IncomingMessage,
  res: ServerResponse,
  executionId: string,
  profile: string,
  action?: string,
) {
  const page = handles.get(`${executionId}:${profile}`)?.page;
  if (!page || page.isClosed())
    return res.writeHead(404).end("The browser page is gone.");
  if (!action) {
    const url = await provider.liveView?.(page);
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ url }));
  }
  await page
    .evaluate(() => {
      (window as unknown as { __nuGuard?: boolean }).__nuGuard = false;
    })
    .catch(() => {});
  if (action === "input") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    await applyInput(page, JSON.parse(Buffer.concat(chunks).toString()));
    return res.writeHead(204).end();
  }
  const session = await page.context().newCDPSession(page);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    res.write(
      `data: ${JSON.stringify({ data, width: metadata.deviceWidth, height: metadata.deviceHeight })}\n\n`,
    );
    session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  req.on("close", () => session.detach().catch(() => {}));
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
}
