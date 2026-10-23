import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { env } from "node:process";

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

const SECRET_FILE = "/run/nu-sandbox/secret";
const ENV_FILE = join(dirname(SECRET_FILE), "env.json");
const KEEPALIVE_MS = 30_000;

const readSecret = () =>
  existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, "utf8").trim() : "";
while (!readSecret()) await new Promise((r) => setTimeout(r, 1000));
const secret = readSecret();
const shell = createLocalBashOperations();

const commandEnv = () => {
  try {
    return { ...env, ...JSON.parse(readFileSync(ENV_FILE, "utf8")) };
  } catch {
    return env;
  }
};

type FileRequest = {
  op: "read" | "access" | "write";
  path: string;
  data?: string;
  write?: boolean;
};

async function file({ op, path, data, write }: FileRequest) {
  switch (op) {
    case "read":
      return { data: (await readFile(path)).toString("base64") };
    case "access":
      await access(
        path,
        write ? constants.R_OK | constants.W_OK : constants.R_OK,
      );
      return {};
    case "write":
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(data ?? "", "base64"));
      return {};
  }
}

// Output streams as one JSON frame per line, ending with the exit code or an
// error. Empty frames keep a quiet command's connection open.
async function exec(
  { command, cwd, timeout }: { command: string; cwd: string; timeout?: number },
  res: ServerResponse,
) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const send = (frame: object) => res.write(`${JSON.stringify(frame)}\n`);
  const keepalive = setInterval(() => send({}), KEEPALIVE_MS);
  try {
    const { exitCode } = await shell.exec(command, cwd, {
      onData: (data) => send({ data: data.toString("base64") }),
      signal: controller.signal,
      timeout,
      env: commandEnv(),
    });
    send({ exitCode });
  } catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}

createServer(async (req, res) => {
  if (req.method !== "POST" || req.headers.authorization !== `Bearer ${secret}`)
    return res.writeHead(401).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (req.url === "/exec") return exec(body, res);
  if (req.url !== "/fs") return res.writeHead(404).end();
  try {
    const result = await file(body);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  } catch (error) {
    const { message, code } = error as NodeJS.ErrnoException;
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: message, code }));
  }
}).listen(4121, "0.0.0.0");
console.log("sandbox: listening");
