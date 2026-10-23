import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, exit } from "node:process";

import { DATA_DIR, WORKSPACE_DIR } from "./config.js";

const SECRETS = join(DATA_DIR, "secrets");
const SANDBOX_DIR = join(DATA_DIR, "sandbox");
const PG_DATA = join(DATA_DIR, "postgres");
const PG_SOCKET = join(DATA_DIR, "run");
const KERNEL_PORT = "4117";
const KERNEL_URL = `http://127.0.0.1:${KERNEL_PORT}`;
const AGENT_PORT = "4118";
const children = new Map<ChildProcess, string>();
const RELOADED = new Set(["agent", "runner", "gateway", "scheduler"]);
const reloading = new Set<ChildProcess>();
let stopping = false;

async function secret(name: string, dir = SECRETS) {
  const path = join(dir, name);
  if (!existsSync(path))
    await writeFile(path, randomBytes(32).toString("hex"), { mode: 0o600 });
  return (await readFile(path, "utf8")).trim();
}

function supervise(
  name: string,
  command: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    env: { ...childEnv, NU_SUPERVISOR_PID: String(process.pid) },
    stdio: "inherit",
  });
  children.set(child, name);
  child.on("exit", (code) => {
    children.delete(child);
    if (stopping) return;
    if (reloading.delete(child))
      return supervise(name, command, args, childEnv);
    console.error(`nu: ${name} exited with ${code}, restarting`);
    setTimeout(() => supervise(name, command, args, childEnv), 1000);
  });
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    for (const child of children.keys()) child.kill("SIGTERM");
    setTimeout(() => exit(0), 2000);
  });

// Reloading restarts the services that load extensions, settings, and secrets,
// leaving Postgres and the kernel running.
process.on("SIGHUP", () => {
  console.log("nu: reloading");
  for (const [child, name] of children)
    if (RELOADED.has(name)) {
      reloading.add(child);
      child.kill("SIGTERM");
    }
});

await mkdir(SECRETS, { recursive: true, mode: 0o700 });
await mkdir(PG_SOCKET, { recursive: true });
const adminToken = await secret("admin_token");
const agentSecret = await secret("agent_secret");
const gatewaySecret = await secret("gateway_secret");
const runnerSecret = await secret("runner_secret");
await mkdir(SANDBOX_DIR, { recursive: true, mode: 0o700 });
const sandboxSecret = await secret("secret", SANDBOX_DIR);
const agentTmp = join(WORKSPACE_DIR, ".tmp");
await mkdir(agentTmp, { recursive: true });

let dbUrl = env.NU_DB_URL;
if (!dbUrl) {
  const fresh = !existsSync(PG_DATA);
  const pgPassword = await secret("postgres_password");
  if (fresh)
    execFileSync(
      "initdb",
      [
        "-D",
        PG_DATA,
        "-U",
        "nu",
        "--auth=scram-sha-256",
        `--pwfile=${join(SECRETS, "postgres_password")}`,
        "--locale=C.UTF-8",
      ],
      { stdio: "inherit" },
    );
  supervise(
    "postgres",
    "postgres",
    [
      "-D",
      PG_DATA,
      "-k",
      PG_SOCKET,
      "-c",
      "listen_addresses=",
      "-c",
      "synchronous_commit=on",
    ],
    env,
  );
  await waitFor(async () => {
    execFileSync("pg_isready", ["-h", PG_SOCKET, "-U", "nu", "-d", "postgres"]);
    return true;
  }, "postgres");
  if (fresh)
    execFileSync("createdb", ["-h", PG_SOCKET, "-U", "nu", "nu"], {
      stdio: "inherit",
      env: { ...env, PGPASSWORD: pgPassword },
    });
  dbUrl = `postgres://nu:${pgPassword}@/nu?host=${PG_SOCKET}`;
}

supervise(
  "kernel",
  "rebuno",
  [
    "server",
    "--db-url",
    dbUrl,
    "--bearer-token",
    adminToken,
    "--listen-addr",
    `${env.NU_LISTEN_HOST ?? "127.0.0.1"}:${KERNEL_PORT}`,
  ],
  {
    PATH: env.PATH,
    REBUNO_DISPATCH_LEASE_TIMEOUT: "30s",
    REBUNO_RETENTION: env.REBUNO_RETENTION ?? "8760h",
  },
);
await waitFor(
  async () => (await fetch(`${KERNEL_URL}/v0/ready`)).ok,
  "the kernel",
);

const registered = await fetch(`${KERNEL_URL}/v0/agents`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    id: "nu",
    webhook_url: `http://127.0.0.1:${AGENT_PORT}/webhook`,
    secret: agentSecret,
  }),
});
if (!registered.ok)
  throw new Error(`registering the agent: ${await registered.text()}`);

const runnerKeyPath = join(SECRETS, "runner_kernel_key");
if (!existsSync(runnerKeyPath)) {
  const created = await fetch(`${KERNEL_URL}/v0/api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "runner", scopes: ["executions:read"] }),
  });
  if (!created.ok)
    throw new Error(`creating the runner's key: ${await created.text()}`);
  const { token } = (await created.json()) as { token: string };
  await writeFile(runnerKeyPath, token, { mode: 0o600 });
}

const { REBUNO_API_KEY: _, ...agentEnv } = env;
const tsx = [
  "--disable-sigusr1",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "tsx",
];
supervise("agent", process.execPath, [...tsx, "src/agent/main.ts"], {
  ...agentEnv,
  REBUNO_URL: KERNEL_URL,
  REBUNO_AGENT_SECRET: agentSecret,
  AGENT_PORT,
  GATEWAY_SECRET: gatewaySecret,
  RUNNER_SECRET: runnerSecret,
  SANDBOX_SECRET: sandboxSecret,
  TMPDIR: agentTmp,
});
supervise("runner", process.execPath, [...tsx, "src/runner/main.ts"], {
  PATH: env.PATH,
  NU_HOME: DATA_DIR,
  REBUNO_URL: KERNEL_URL,
  REBUNO_API_KEY: (await readFile(runnerKeyPath, "utf8")).trim(),
  RUNNER_SECRET: runnerSecret,
  SANDBOX_URL: env.SANDBOX_URL,
  SANDBOX_SECRET: sandboxSecret,
});
supervise("gateway", process.execPath, [...tsx, "src/gateway/main.ts"], {
  ...env,
  REBUNO_URL: KERNEL_URL,
  REBUNO_API_KEY: adminToken,
  REBUNO_AGENT_SECRET: agentSecret,
  AGENT_WEBHOOK_BASE: `http://127.0.0.1:${AGENT_PORT}`,
  GATEWAY_SECRET: gatewaySecret,
  RUNNER_SECRET: runnerSecret,
  SANDBOX_SECRET: sandboxSecret,
});
supervise("scheduler", process.execPath, [...tsx, "src/scheduler/main.ts"], {
  ...agentEnv,
  GATEWAY_SECRET: gatewaySecret,
});
console.log(`nu: running, kernel at ${KERNEL_URL}`);
