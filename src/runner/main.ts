import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { Client } from "rebuno";

import { requiredEnv } from "../config.js";
import { loadExtensions } from "../extensions.js";
import { bundlePath, readEntry, readIndex, sha256 } from "../registry.js";
import { useSandbox } from "../sandbox/index.js";
import { readSettings } from "../settings.js";
import { callMcpTool, contentText, listMcpTools } from "./mcp.js";
import { resolveSecrets } from "./secrets.js";

const TIMEOUT_MS = 10 * 60_000;
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "child.ts");
const secret = requiredEnv("RUNNER_SECRET");
const kernel = new Client({
  baseUrl: env.REBUNO_URL ?? "http://127.0.0.1:4117",
  apiKey: requiredEnv("REBUNO_API_KEY"),
});
useSandbox((await loadExtensions()).sandbox);

class RunError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function run(body: {
  execution_id: string;
  tool: string;
  version: number;
  args: unknown;
}) {
  const steps = await kernel.listSteps(body.execution_id);
  const step = steps.findLast(
    (s) =>
      s.target === body.tool &&
      s.status === "executing" &&
      isDeepStrictEqual(s.args, body.args),
  );
  if (!step)
    throw new RunError(403, `no matching ${body.tool} step is executing`);
  if (body.tool.startsWith("mcp__"))
    return callMcpTool(body.tool, body.args, body.execution_id);
  if (readIndex()[body.tool]?.removed) throw new RunError(410, "tool removed");

  const { manifest, bundleHash } = readEntry(body.tool, body.version);
  const bundle = bundlePath(body.tool, body.version);
  if (sha256(readFileSync(bundle)) !== bundleHash)
    throw new RunError(500, "tool code does not match its registry entry");
  const secrets = await resolveSecrets(manifest.secrets).catch((error) => {
    throw new RunError(400, error.message);
  });

  const config = readSettings().config?.[body.tool.split("__")[0]] ?? {};
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${bundle}`,
      `--allow-fs-read=${CHILD}`,
      CHILD,
      bundle,
    ],
    {
      env: Object.fromEntries(manifest.secrets.map((n) => [n, secrets[n]])),
      stdio: ["pipe", "inherit", "inherit", "pipe"],
      timeout: TIMEOUT_MS,
    },
  );
  child.stdin?.end(
    JSON.stringify({ args: body.args, stepId: step.stepId, config }),
  );
  let output = "";
  child.stdio[3]?.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  const outcome = JSON.parse(
    output || '{"error":"the tool exited without a result"}',
  );
  if ("error" in outcome) throw new RunError(500, outcome.error);
  const content = outcome.result?.content;
  return Array.isArray(content)
    ? contentText(content, body.execution_id)
    : outcome.result;
}

createServer(async (req, res) => {
  const respond = (status: number, body: unknown) =>
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  if (req.headers.authorization !== `Bearer ${secret}`)
    return respond(401, { error: "unauthorized" });
  try {
    if (req.method === "GET" && req.url === "/mcp/tools")
      return respond(200, await listMcpTools());
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    respond(200, {
      result: await run(JSON.parse(Buffer.concat(chunks).toString())),
    });
  } catch (error) {
    respond(error instanceof RunError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}).listen(4119, "127.0.0.1");
console.log("runner: listening");
