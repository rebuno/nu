import { request } from "./http.js";
import { catchRedirect } from "./login.js";

const USAGE = `Usage:
  nu mcp add <server> [--env KEY=VALUE]... [--cwd <dir>] [--description <text>] -- <command> [args...]
  nu mcp add <server> --url <url> [--header KEY=VALUE]... [--bearer-token-secret <NAME>] [--description <text>]
  nu mcp login <server> [--client-id <id>] [--client-secret <secret>]
  nu mcp remove <server>
  nu mcp list

\${NAME} in a value is replaced with the secret NAME, set with /secret NAME <value> in chat:
  nu mcp add notion --env NOTION_TOKEN='\${NOTION_TOKEN}' -- npx -y @notionhq/notion-mcp-server
  nu mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-token-secret GITHUB_TOKEN`;

const LISTS = new Set(["env", "header"]);
const VALUES = new Set(["url", "cwd", "description", "bearer-token-secret"]);

const nonEmpty = (record: Record<string, string>) =>
  Object.keys(record).length ? record : undefined;

function parseAdd(args: string[]) {
  const split = args.indexOf("--");
  const options = split < 0 ? args : args.slice(0, split);
  const command = split < 0 ? [] : args.slice(split + 1);
  const values = new Map<string, string>();
  const pairs: Record<string, Record<string, string>> = { env: {}, header: {} };
  let name: string | undefined;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].startsWith("--") ? options[i].slice(2) : "";
    if (!option) {
      if (name) throw new Error(USAGE);
      name = options[i];
      continue;
    }
    const value = options[++i];
    if (value === undefined || !(LISTS.has(option) || VALUES.has(option)))
      throw new Error(USAGE);
    if (!LISTS.has(option)) {
      values.set(option, value);
      continue;
    }
    const at = value.indexOf("=");
    if (at <= 0) throw new Error(`--${option} expects KEY=VALUE, got ${value}`);
    pairs[option][value.slice(0, at)] = value.slice(at + 1);
  }
  const url = values.get("url");
  if (!name || (url === undefined) === (command.length === 0))
    throw new Error(USAGE);
  const description = values.get("description");
  const secret = values.get("bearer-token-secret");
  if (secret) pairs.header.Authorization = `Bearer \${${secret}}`;
  if (url !== undefined) {
    if (values.has("cwd") || nonEmpty(pairs.env))
      throw new Error("--env and --cwd only apply to stdio servers");
    return {
      name,
      server: { url, headers: nonEmpty(pairs.header), description },
    };
  }
  if (nonEmpty(pairs.header))
    throw new Error(
      "--header and --bearer-token-secret only apply to HTTP servers (--url)",
    );
  return {
    name,
    server: {
      command: command[0],
      args: command.length > 1 ? command.slice(1) : undefined,
      env: nonEmpty(pairs.env),
      cwd: values.get("cwd"),
      description,
    },
  };
}

async function login(args: string[]) {
  const [name, ...options] = args;
  const flags = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i];
    if (!["--client-id", "--client-secret"].includes(flag) || !options[i + 1])
      throw new Error(USAGE);
    flags.set(flag, options[i + 1]);
  }
  if (!name) throw new Error(USAGE);
  const { url, redirect } = (await (
    await request("mcp/login", {
      name,
      clientId: flags.get("--client-id"),
      clientSecret: flags.get("--client-secret"),
    })
  ).json()) as { url: string; redirect: string };
  let server: ReturnType<typeof catchRedirect> | undefined;
  const callback = await new Promise<string>((resolve, reject) => {
    server = catchRedirect(new URL(redirect), resolve);
    server.on("error", reject);
    console.log(`Open ${url}`);
  }).finally(() => server?.close());
  const data = (await (
    await request("mcp/callback", { url: callback })
  ).json()) as { message: string };
  console.log(data.message);
}

export async function mcp(args: string[]) {
  const [action, ...rest] = args;
  if (action === "add") {
    const data = (await (await request("mcp", parseAdd(rest))).json()) as {
      message: string;
    };
    console.log(data.message);
  } else if (action === "login") {
    await login(rest);
  } else if (action === "remove" && rest.length === 1) {
    const data = (await (
      await request("mcp", { name: rest[0] }, "DELETE")
    ).json()) as { message: string };
    console.log(data.message);
  } else if (action === "list" && !rest.length) {
    const { servers } = (await (await request("mcp")).json()) as {
      servers: {
        name: string;
        target: string;
        tools: string[];
        error?: string;
      }[];
    };
    if (!servers.length)
      console.log("No MCP servers. Add one with nu mcp add.");
    for (const server of servers) {
      console.log(`${server.name.padEnd(16)} ${server.target}`);
      console.log(
        server.error
          ? `  error: ${server.error}`
          : `  ${server.tools.length} tools: ${server.tools.join(", ")}`,
      );
    }
    if (servers.some((server) => server.error)) process.exitCode = 1;
  } else throw new Error(USAGE);
}
