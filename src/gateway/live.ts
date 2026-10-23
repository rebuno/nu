import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Client } from "rebuno";

import { readSettings } from "../settings.js";

const sign = (secret: string, approvalId: string) =>
  createHmac("sha256", secret)
    .update(`browser-live:${approvalId}`)
    .digest("base64url");

export function liveLink(secret: string, approvalId: string) {
  const base = (readSettings().liveUrl ?? "http://127.0.0.1:4122").replace(
    /\/+$/,
    "",
  );
  return `${base}/browser/live/${approvalId}.${sign(secret, approvalId)}`;
}

// A browser_handoff link works while its approval is pending. The page is
// relayed from the agent service, which holds it.
export class LiveView {
  constructor(
    private readonly kernel: Client,
    private readonly agents: { webhookBase: string; secret: string },
  ) {}

  async #handoff(approvalId: string) {
    const approval = await this.kernel.getApproval(approvalId).catch(() => {});
    if (approval?.status !== "pending") return;
    const step = await this.kernel.getStep(
      approval.executionId,
      approval.stepId,
    );
    if (step.target !== "browser_handoff") return;
    const { profile = "default" } = step.args as { profile?: string };
    return `${this.agents.webhookBase}/browser/${approval.executionId}/${encodeURIComponent(profile)}`;
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const [, id = "", signature = "", action] =
      req.url?.match(
        /^\/browser\/live\/([0-9a-f-]+)\.([\w-]+)(?:\/(frames|input))?$/,
      ) ?? [];
    const expected = Buffer.from(sign(this.agents.secret, id));
    const page =
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), expected)
        ? await this.#handoff(id)
        : undefined;
    if (!page)
      return res
        .writeHead(410, { "content-type": "text/plain" })
        .end("This browser handoff is finished or the link is invalid.");
    const headers = { authorization: `Bearer ${this.agents.secret}` };
    if (!action) {
      const { url } = (await (await fetch(page, { headers })).json()) as {
        url?: string;
      };
      if (url) return res.writeHead(302, { location: url }).end();
      return res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(VIEWER);
    }
    if (action === "input") {
      if (req.method !== "POST") return res.writeHead(405).end();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const upstream = await fetch(`${page}/input`, {
        method: "POST",
        headers,
        body: Buffer.concat(chunks),
      });
      return res.writeHead(upstream.status).end();
    }
    const controller = new AbortController();
    const finished = setInterval(async () => {
      if (!(await this.#handoff(id).catch(() => page))) controller.abort();
    }, 5000);
    req.on("close", () => controller.abort());
    try {
      const upstream = await fetch(`${page}/frames`, {
        headers,
        signal: controller.signal,
      });
      res.writeHead(upstream.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      if (upstream.body)
        for await (const chunk of upstream.body) res.write(chunk);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearInterval(finished);
      res.end();
    }
  }
}

const VIEWER = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nu browser</title>
<style>
body { margin: 0; font: 15px system-ui, sans-serif; background: #111; color: #eee; }
p { margin: 10px 12px; color: #aaa; }
canvas { display: block; width: 100%; touch-action: none; background: #222; }
form { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
input { flex: 1 1 12em; font: inherit; padding: 8px; }
button { font: inherit; padding: 8px 12px; }
</style>
</head>
<body>
<p id="status">Connecting…</p>
<canvas id="screen" width="1" height="1"></canvas>
<form id="type">
<input id="text" placeholder="Type into the focused field" autocomplete="off">
<button>Send</button>
<button type="button" data-key="Enter">Enter</button>
<button type="button" data-key="Tab">Tab</button>
<button type="button" data-key="Backspace">⌫</button>
</form>
<script>
const base = location.pathname;
const canvas = document.getElementById("screen");
const context = canvas.getContext("2d");
const status = document.getElementById("status");
const text = document.getElementById("text");
let size = { width: 1, height: 1 };
const send = (input) =>
  fetch(base + "/input", { method: "POST", body: JSON.stringify(input) });
const frames = new EventSource(base + "/frames");
frames.onopen = () => {
  status.textContent = "Tap to click and swipe to scroll. Approve the request in chat when you are done.";
};
frames.onerror = () => {
  frames.close();
  status.textContent = "Disconnected. The handoff may be finished; reload to try again.";
};
frames.onmessage = (message) => {
  const frame = JSON.parse(message.data);
  size = frame;
  const image = new Image();
  image.onload = () => {
    canvas.width = image.width;
    canvas.height = image.height;
    context.drawImage(image, 0, 0);
  };
  image.src = "data:image/jpeg;base64," + frame.data;
};
const point = (event) => {
  const box = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left) / box.width) * size.width,
    y: ((event.clientY - box.top) / box.height) * size.height,
  };
};
let down;
canvas.addEventListener("pointerdown", (event) => {
  down = { ...point(event), clientY: event.clientY };
});
canvas.addEventListener("pointerup", (event) => {
  if (!down) return;
  const dy = down.clientY - event.clientY;
  if (Math.abs(dy) < 10) send({ type: "click", x: down.x, y: down.y });
  else send({ type: "scroll", x: down.x, y: down.y, dy: dy * 2 });
  down = undefined;
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  send({ type: "scroll", ...point(event), dy: event.deltaY });
}, { passive: false });
document.getElementById("type").addEventListener("submit", (event) => {
  event.preventDefault();
  if (text.value) send({ type: "text", text: text.value });
  text.value = "";
});
for (const button of document.querySelectorAll("[data-key]"))
  button.addEventListener("click", () => send({ type: "key", key: button.dataset.key }));
document.addEventListener("keydown", (event) => {
  if (event.target === text || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  send(event.key.length === 1 ? { type: "text", text: event.key } : { type: "key", key: event.key });
});
</script>
</body>
</html>
`;
