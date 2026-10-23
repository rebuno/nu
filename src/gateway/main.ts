import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { env } from "node:process";

import { Client } from "rebuno";

import { DATA_DIR, requiredEnv } from "../config.js";
import { loadExtensions } from "../extensions.js";
import { useSandbox } from "../sandbox/index.js";
import { syncSandboxEnv } from "../secrets.js";
import { Gateway, HttpError } from "./gateway.js";
import { LiveView } from "./live.js";
import { discardUnusedFetches } from "./packages.js";
import { TerminalChannel } from "./terminal.js";
import { checkForUpdates } from "./updates.js";

const kernelUrl = env.REBUNO_URL ?? "http://127.0.0.1:4117";
const apiKey = requiredEnv("REBUNO_API_KEY");
const secret = requiredEnv("GATEWAY_SECRET");

env.npm_config_ignore_scripts = "true";
await mkdir(DATA_DIR, { recursive: true });
syncSandboxEnv();
discardUnusedFetches();

const extensions = await loadExtensions();
useSandbox(extensions.sandbox);

const kernel = new Client({ baseUrl: kernelUrl, apiKey });
const agents = {
  webhookBase: env.AGENT_WEBHOOK_BASE ?? "http://127.0.0.1:4118",
  secret: requiredEnv("REBUNO_AGENT_SECRET"),
};
const gateway = new Gateway(
  kernel,
  kernelUrl,
  apiKey,
  DATA_DIR,
  agents,
  extensions.hooks,
);
await gateway.loadPolicy();
checkForUpdates();

const terminal = new TerminalChannel(DATA_DIR, () => gateway.history("main"));
const live = new LiveView(kernel, agents);

const serve = (internal: boolean) =>
  createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      if (res.headersSent) return res.end();
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    };
    try {
      if (!internal) {
        if (req.url?.startsWith("/browser/live/"))
          return await live.handle(req, res);
        if (!req.url?.startsWith("/terminal/"))
          return respond(404, { error: "no public route" });
        return await terminal.handle(req, res);
      }
      if (!req.url?.startsWith("/internal/"))
        return respond(404, { error: "no internal route" });
      if (req.headers.authorization !== `Bearer ${secret}`)
        return respond(401, { error: "unauthorized" });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      respond(200, await gateway.internal(req.url, body));
    } catch (error) {
      respond(error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

serve(false).listen(4122, env.NU_LISTEN_HOST ?? "127.0.0.1");
serve(true).listen(4120, "127.0.0.1");

await gateway.start([terminal, ...extensions.channels]);
for (const { namespace, watcher } of extensions.watchers)
  Promise.resolve()
    .then(() => watcher({ report: (report) => gateway.report(report) }))
    .catch((error) =>
      console.error(
        `gateway: watcher ${namespace} failed:`,
        error instanceof Error ? error.message : error,
      ),
    );
console.log(
  `gateway: started ${[terminal, ...extensions.channels].map((a) => a.name).join(", ")}`,
);
