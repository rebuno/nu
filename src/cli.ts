#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv, stdin } from "node:process";
import { clientConfigPath, request } from "./terminal/http.js";
import { searchPackages } from "./terminal/npm.js";

const USAGE = `Usage:
  nu                            (open terminal chat)
  nu login [provider]
  nu connect <url>   (terminal token on standard input)
  nu set <setting> <value>
  nu update
  nu search [query]
  nu install <source>
  nu remove <source>
  nu list
  nu policy [--yaml]
  nu reload
  nu config set <namespace> <key> <value>
  nu secret set <NAME>   (value on standard input)
  nu mcp add|login|remove|list
  nu sandbox add|remove <NAME>   (share a secret with sandbox commands)
  nu sandbox list`;

// A local folder is sent as its files, since the server may not see it.
function packageFiles(dir: string) {
  const files: Record<string, string> = {};
  for (const item of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = relative(dir, join(item.parentPath, item.name));
    if (item.isFile() && !/(^|\/)(node_modules|\.git)(\/|$)/.test(path))
      files[path] = readFileSync(join(dir, path), "utf8");
  }
  return files;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString().trim();
}

async function main() {
  const [command, ...args] = argv.slice(2);
  const [action, ...rest] = args;
  let route: string;
  let body: unknown;
  let method = "POST";
  if (!command) {
    const { chat } = await import("./terminal/client.js");
    return chat();
  }
  if (command === "login" && args.length <= 1) {
    const { login } = await import("./terminal/login.js");
    return login(action);
  }
  if (command === "connect" && args.length === 1) {
    const token = await readStdin();
    if (!/^https?:\/\//.test(action))
      throw new Error("the URL must start with http:// or https://");
    if (!token) throw new Error("pass the terminal token on standard input");
    const path = clientConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ url: action, token }, null, 2), {
      mode: 0o600,
    });
    const { version } = (await (await request("client")).json()) as {
      version: string;
    };
    console.log(`Connected to Nu ${version} at ${action}.`);
    return;
  }
  if (command === "update" && !args.length) {
    const { update } = await import("./terminal/update.js");
    return update();
  }
  if (command === "mcp") {
    const { mcp } = await import("./terminal/mcp.js");
    return mcp(args);
  }
  if (command === "search") {
    const packages = await searchPackages(args.join(" "));
    if (!packages.length) console.log("No packages found.");
    for (const { source, version, description } of packages)
      console.log(`nu install ${source}  (${version})\n  ${description}`);
    return;
  }
  if (command === "set" && args.length === 2) {
    route = "settings";
    body = { key: action, value: rest[0] };
  } else if (
    (command === "install" || command === "remove") &&
    args.length === 1
  ) {
    route = "packages";
    const files =
      existsSync(action) && statSync(action).isDirectory()
        ? packageFiles(resolve(action))
        : undefined;
    const namespace = files
      ? JSON.parse(files["package.json"] ?? "{}").nu?.namespace
      : undefined;
    body = {
      source: namespace ? `local:${namespace}` : action,
      files: command === "install" ? files : undefined,
    };
    method = command === "remove" ? "DELETE" : "POST";
  } else if (
    command === "policy" &&
    (!args.length || (args.length === 1 && action === "--yaml"))
  ) {
    const data = (await (await request("policy")).json()) as {
      text: string;
      yaml: string;
    };
    console.log(action ? data.yaml.trimEnd() : data.text);
    return;
  } else if (command === "sandbox" && action === "list" && !rest.length) {
    const { secrets } = (await (await request("sandbox")).json()) as {
      secrets: { name: string; status: string }[];
    };
    if (!secrets.length)
      console.log(
        "Sandbox commands get no secrets. Share one with nu sandbox add.",
      );
    for (const { name, status } of secrets)
      console.log(`${name.padEnd(24)} ${status}`);
    return;
  } else if (
    command === "sandbox" &&
    (action === "add" || action === "remove") &&
    rest.length === 1
  ) {
    route = "sandbox";
    body = { name: rest[0] };
    method = action === "remove" ? "DELETE" : "POST";
  } else if (command === "reload" && !args.length) {
    route = "reload";
    body = {};
  } else if (command === "list" && !args.length) {
    const data = (await (await request("packages")).json()) as {
      packages: Record<string, { namespace: string }>;
    };
    for (const [source, pkg] of Object.entries(data.packages))
      console.log(`${pkg.namespace.padEnd(16)} ${source}`);
    return;
  } else if (command === "config" && action === "set" && rest.length === 3) {
    route = "settings";
    body = { namespace: rest[0], key: rest[1], value: rest[2] };
  } else if (command === "secret" && action === "set" && rest.length === 1) {
    const value = await readStdin();
    if (!value) throw new Error("pass the secret's value on standard input");
    route = "secrets";
    body = { name: rest[0], value };
  } else throw new Error(USAGE);
  const data = (await (await request(route, body, method)).json()) as {
    message?: string;
  };
  if (data.message) console.log(data.message);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
