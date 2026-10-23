import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pkg from "../../package.json" with { type: "json" };
import { createModels, modelKey } from "../agent/models.js";
import { POLICY_PATH } from "../config.js";
import { readServers, validateServer, writeServer } from "../mcp.js";
import { readPolicy } from "../policy/bundle.js";
import { policyView, type Rule } from "../policy/checks.js";
import { readPackages } from "../registry.js";
import { quote, run } from "../sandbox/index.js";
import {
  hasSecret,
  readSecrets,
  SECRET_NAME,
  syncSandboxEnv,
} from "../secrets.js";
import {
  readSettings,
  setExtensionConfig,
  writeSettings,
} from "../settings.js";
import { HttpError } from "./gateway.js";
import { mcpStatus } from "./mcp.js";
import { finishMcpLogin, startMcpLogin } from "./mcp-login.js";
import {
  clientView,
  commandList,
  installRemotePackage,
  isRemote,
  missingValues,
  removePackage,
  saveSecret,
  uploadPackage,
} from "./packages.js";
import { reloaded } from "./reload.js";
import { TerminalLogin } from "./terminal-login.js";
import { updateNotice } from "./updates.js";

const SETTINGS = new Set([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "compactionModel",
  "timeZone",
  "heartbeat",
  "updateCheck",
  "liveUrl",
]);
const safeKey = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\w-]+$/.test(value) &&
  !["__proto__", "prototype", "constructor"].includes(value);

async function jsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "message too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "expected a JSON object");
  }
}

function sandboxStatus(name: string) {
  const secret = readSecrets()[name];
  if (secret === undefined)
    return `not set; send /secret ${name} <value> in chat`;
  if (typeof secret === "object")
    return "an OAuth sign-in, which sandbox commands do not get";
  return "shared";
}

export class TerminalManagement {
  readonly #login = new TerminalLogin();

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const route = req.url ?? "";
    if (
      ![
        "/terminal/settings",
        "/terminal/secrets",
        "/terminal/packages",
        "/terminal/models",
        "/terminal/policy",
        "/terminal/client",
        "/terminal/login",
        "/terminal/reload",
        "/terminal/mcp",
        "/terminal/mcp/login",
        "/terminal/mcp/callback",
        "/terminal/sandbox",
      ].includes(route) &&
      !/^\/terminal\/login\/[^/]+\/answer$/.test(route)
    )
      return false;
    const send = (body: unknown) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (req.method === "GET" && route === "/terminal/packages") {
      send({ packages: readPackages() });
      return true;
    }
    if (req.method === "GET" && route === "/terminal/mcp") {
      send({ servers: await mcpStatus() });
      return true;
    }
    if (req.method === "GET" && route === "/terminal/sandbox") {
      send({
        secrets: (readSettings().sandboxSecrets ?? []).map((name) => ({
          name,
          status: sandboxStatus(name),
        })),
      });
      return true;
    }
    if (req.method === "GET" && route === "/terminal/client") {
      send({
        tools: clientView().tools,
        commands: commandList(),
        version: pkg.version,
        update: updateNotice(),
      });
      return true;
    }
    if (req.method === "GET" && route === "/terminal/policy") {
      const rules = (await readPolicy(POLICY_PATH)) as Rule[];
      send({
        text: policyView(rules),
        yaml: readFileSync(POLICY_PATH, "utf8"),
      });
      return true;
    }
    if (req.method === "GET" && route === "/terminal/models") {
      const models = await createModels();
      const settings = readSettings();
      const current = await models.current();
      send({
        models: (await models.available()).map((m) => ({
          key: modelKey(m),
          name: m.name,
        })),
        current: current ? modelKey(current) : "",
        thinking: settings.defaultThinkingLevel ?? "medium",
      });
      return true;
    }
    if (
      req.method !== "POST" &&
      !(
        ["/terminal/packages", "/terminal/mcp", "/terminal/sandbox"].includes(
          route,
        ) && req.method === "DELETE"
      )
    )
      throw new HttpError(405, "method not allowed");
    if (
      ["/terminal/models", "/terminal/policy", "/terminal/client"].includes(
        route,
      )
    )
      throw new HttpError(405, "use GET");
    if (route === "/terminal/reload") {
      send({ message: reloaded("") });
      return true;
    }
    const body = await jsonBody(req);
    if (route === "/terminal/login") {
      if (
        body.provider !== undefined &&
        (typeof body.provider !== "string" || !body.provider.trim())
      )
        throw new HttpError(400, "invalid provider");
      await this.#login.start(body.provider as string | undefined, res);
      return true;
    }
    if (route.startsWith("/terminal/login/")) {
      if (typeof body.answer !== "string")
        throw new HttpError(400, "answer is required");
      this.#login.answer(route.split("/")[3], body.answer);
      send({});
      return true;
    }
    if (route === "/terminal/mcp/login") {
      if (
        typeof body.name !== "string" ||
        (body.clientId !== undefined && typeof body.clientId !== "string") ||
        (body.clientSecret !== undefined &&
          typeof body.clientSecret !== "string")
      )
        throw new HttpError(400, "name is required");
      send(await startMcpLogin(body.name, body));
      return true;
    }
    if (route === "/terminal/mcp/callback") {
      if (typeof body.url !== "string")
        throw new HttpError(400, "url is required");
      send({ message: await finishMcpLogin(body.url) });
      return true;
    }
    if (route === "/terminal/sandbox") {
      if (typeof body.name !== "string" || !SECRET_NAME.test(body.name))
        throw new HttpError(400, "secret names are UPPER_SNAKE_CASE");
      const shared = readSettings().sandboxSecrets ?? [];
      const has = shared.includes(body.name);
      if (req.method === "DELETE" && !has)
        throw new HttpError(404, `${body.name} is not shared with the sandbox`);
      writeSettings({
        ...readSettings(),
        sandboxSecrets:
          req.method === "DELETE"
            ? shared.filter((name) => name !== body.name)
            : has
              ? shared
              : [...shared, body.name],
      });
      syncSandboxEnv();
      const author =
        req.method === "DELETE"
          ? undefined
          : await setGitAuthor(body.name).catch(() => undefined);
      send({
        message: [
          req.method === "DELETE"
            ? `Sandbox commands no longer get ${body.name}.`
            : sandboxStatus(body.name) === "shared"
              ? `Sandbox commands get ${body.name} as an environment variable.`
              : `${body.name} is shared but ${sandboxStatus(body.name)}.`,
          author,
        ]
          .filter(Boolean)
          .join(" "),
      });
      return true;
    }
    if (route === "/terminal/settings") {
      if (!safeKey(body.key) || typeof body.value !== "string" || !body.value)
        throw new HttpError(400, "key and value are required");
      if (body.namespace !== undefined) {
        if (!safeKey(body.namespace))
          throw new HttpError(400, "invalid namespace");
        setExtensionConfig(body.namespace, body.key, body.value);
      } else {
        if (!SETTINGS.has(body.key))
          throw new HttpError(400, "unknown setting");
        writeSettings({ ...readSettings(), [body.key]: body.value });
      }
      send({ message: reloaded("Saved.") });
    } else if (route === "/terminal/mcp") {
      if (typeof body.name !== "string")
        throw new HttpError(400, "name is required");
      const exists = body.name in readServers();
      if (req.method === "DELETE") {
        if (!exists) throw new HttpError(404, `no MCP server ${body.name}`);
        writeServer(body.name);
        send({
          message: `Removed MCP server ${body.name}. Its tools are gone from the next turn.`,
        });
        return true;
      }
      let server: ReturnType<typeof validateServer>;
      try {
        server = validateServer(body.name, body.server);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      writeServer(body.name, server);
      const missing = [
        ...new Set(
          [...JSON.stringify(server).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(
            (match) => match[1],
          ),
        ),
      ].filter((name) => !hasSecret(name));
      send({
        message: [
          `${exists ? "Replaced" : "Added"} MCP server ${body.name}. Its tools are available from the next turn.`,
          ...missing.map((name) => `Send /secret ${name} <value> in chat.`),
          "Check it with: nu mcp list",
        ].join("\n"),
      });
    } else if (route === "/terminal/secrets") {
      if (
        typeof body.name !== "string" ||
        !SECRET_NAME.test(body.name) ||
        typeof body.value !== "string" ||
        !body.value
      )
        throw new HttpError(
          400,
          "an UPPER_SNAKE_CASE name and a value are required",
        );
      send({ message: saveSecret(body.name, body.value) });
    } else {
      const source = body.source;
      const files = req.method === "POST" ? body.files : undefined;
      if (
        typeof source !== "string" ||
        !(req.method === "DELETE" || files || isRemote(source))
      )
        throw new HttpError(
          400,
          "Install a local folder, an npm: package, or a Git URL.",
        );
      if (req.method === "DELETE") {
        const extensions = readPackages()[source]?.extensions?.length;
        if (!removePackage(source))
          throw new HttpError(404, "package is not installed");
        send({
          message: extensions
            ? reloaded("Removed.")
            : "Removed. Its tools are gone from the next turn.",
        });
      } else {
        const { pkg, tools, previous } = files
          ? await uploadPackage(files)
          : await installRemotePackage(source);
        const missing = missingValues(pkg);
        send({
          message: [
            `Installed ${pkg.source} (namespace ${pkg.namespace}).`,
            tools.length
              ? `Tools: ${tools.map((t) => `\`${t}\``).join(", ")}.`
              : "",
            pkg.extensions.length
              ? `Extensions: ${pkg.extensions.length}.`
              : "",
            ...missing.secrets.map(
              (name) =>
                `Set its ${name} secret with: printf %s '<value>' | nu secret set ${name}`,
            ),
            ...missing.config.map(
              (key) =>
                `Set its ${key} setting with: nu config set ${pkg.namespace} ${key} <value>`,
            ),
            pkg.rules ? `Suggested policy rules:\n${pkg.rules.trim()}` : "",
            pkg.extensions.length || previous?.extensions?.length
              ? reloaded("")
              : "Its tools are available from the next turn.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }
    }
    return true;
  }
}

// The noreply address credits commits to the account without exposing its email.
async function setGitAuthor(name: string) {
  const token = readSecrets()[name];
  if (!["GITHUB_TOKEN", "GH_TOKEN"].includes(name) || typeof token !== "string")
    return;
  const git = (...args: string[]) =>
    run(`git config --global ${args.map(quote).join(" ")}`);
  try {
    return `Commits are authored as ${(await git("user.name")).trim()}.`;
  } catch {}
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return;
  const user = (await response.json()) as {
    id: number;
    login: string;
    name: string | null;
  };
  await git("user.name", user.name || user.login);
  await git("user.email", `${user.id}+${user.login}@users.noreply.github.com`);
  return `Commits are authored as ${user.name || user.login}.`;
}
