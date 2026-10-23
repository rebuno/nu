import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { env } from "node:process";

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import { WORKSPACE_DIR } from "../config.js";
import { readSandboxEnv } from "../secrets.js";

export interface ExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env: Record<string, string>;
}

// Where shell commands and file edits run. exec's timeout is in seconds,
// writeFile creates missing parent directories, and access throws when the
// path is missing or, with write, cannot be written.
export interface Sandbox {
  readonly workdir: string;
  exec(
    command: string,
    cwd: string,
    options: ExecOptions,
  ): Promise<{ exitCode: number | null }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  access(path: string, write?: boolean): Promise<void>;
}

const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;
const commandEnv = Object.fromEntries(
  Object.entries(env).filter(([name]) => !SECRET.test(name)),
) as Record<string, string>;

// Judged after symlinks resolve, so a link cannot reach Nu's own data.
export async function confine(path: string, roots: string[]) {
  let real: string | undefined;
  for (let dir = path; !real; dir = dirname(dir))
    real = await realpath(dir).then(
      (resolved) => join(resolved, relative(dir, path)),
      () => undefined,
    );
  for (const root of roots) {
    const resolved = await realpath(root).catch(() => undefined);
    if (resolved && (real === resolved || real.startsWith(resolved + sep)))
      return real;
  }
  throw new Error(`${path} is outside the workspace`);
}

const shell = createLocalBashOperations();
const inWorkspace = (path: string) => confine(path, [WORKSPACE_DIR]);

// Runs in Nu itself, for when no sandbox is set up.
const none: Sandbox = {
  workdir: WORKSPACE_DIR,
  exec: (command, cwd, options) =>
    shell.exec(command, cwd, {
      ...options,
      env: { ...commandEnv, ...options.env },
    }),
  readFile: async (path) => readFile(await inWorkspace(path)),
  writeFile: async (path, data) => {
    const real = await inWorkspace(path);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, data);
  },
  access: async (path, write) =>
    access(
      await inWorkspace(path),
      write ? constants.R_OK | constants.W_OK : constants.R_OK,
    ),
};

function container(url: string, secret: string): Sandbox {
  const headers = { authorization: `Bearer ${secret}` };
  const file = async <T>(op: string, path: string, extra: object = {}) => {
    const response = await fetch(`${url}/fs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op, path, ...extra }),
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.error), { code: result.code });
    return result as T;
  };
  return {
    workdir: WORKSPACE_DIR,
    exec: async (command, cwd, { onData, signal, timeout }) => {
      try {
        const response = await fetch(`${url}/exec`, {
          method: "POST",
          headers,
          body: JSON.stringify({ command, cwd, timeout }),
          signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`sandbox: HTTP ${response.status}`);
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(
          new TextDecoderStream(),
        )) {
          const lines = (buffer + chunk).split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const frame = JSON.parse(line);
            if (frame.data) onData(Buffer.from(frame.data, "base64"));
            if (frame.error) throw new Error(frame.error);
            if ("exitCode" in frame) return { exitCode: frame.exitCode };
          }
        }
        throw new Error("sandbox: the command ended without an exit code");
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        throw error;
      }
    },
    readFile: async (path) =>
      Buffer.from((await file<{ data: string }>("read", path)).data, "base64"),
    writeFile: async (path, data) => {
      await file("write", path, {
        data: Buffer.from(data).toString("base64"),
      });
    },
    access: async (path, write) => {
      await file("access", path, { write });
    },
  };
}

const docker = env.SANDBOX_URL
  ? container(env.SANDBOX_URL, env.SANDBOX_SECRET ?? "")
  : undefined;

export let sandbox: Sandbox = docker ?? none;

export const inContainer = () => sandbox === docker;

// The sandbox container reads the shared secrets itself, so Nu only reads them
// for a sandbox that cannot.
export const sharedSecrets = () => (inContainer() ? {} : readSandboxEnv());

export function useSandbox(next: Sandbox | undefined) {
  if (next) sandbox = next;
}

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export async function run(command: string, cwd = sandbox.workdir) {
  const chunks: Buffer[] = [];
  const { exitCode } = await sandbox.exec(command, cwd, {
    onData: (data) => chunks.push(data),
    timeout: 60,
    env: {},
  });
  const output = Buffer.concat(chunks).toString();
  if (exitCode !== 0)
    throw new Error(`${command} exited with ${exitCode}: ${output.trim()}`);
  return output;
}

export async function readDir(dir: string) {
  const paths = (
    await run(
      "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*'",
      dir,
    )
  )
    .split("\n")
    .filter(Boolean);
  const files: Record<string, string> = {};
  for (const path of paths)
    files[path.slice(2)] = (await sandbox.readFile(join(dir, path))).toString(
      "utf8",
    );
  return files;
}
