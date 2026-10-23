import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  DefaultPackageManager,
  generateDiffString,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildSync } from "esbuild";
import { parse } from "yaml";

import { PACKAGES_DIR } from "../config.js";
import { EXTENSION_KEY } from "../extensions.js";
import {
  activate,
  type ClientView,
  codeHash,
  dependencies,
  type Entry,
  type Manifest,
  NAMESPACE,
  RESERVED_NAMESPACES,
  readEntry,
  readFiles,
  readIndex,
  readPackages,
  removePackageTools,
  sha256,
  validateManifest,
  writePackages,
} from "../registry.js";
import { sandbox } from "../sandbox/index.js";
import {
  hasSecret,
  SECRET_NAME,
  setSecret,
  syncSandboxEnv,
} from "../secrets.js";
import { readSettings } from "../settings.js";
import { COMMANDS, type CommandInfo } from "./channel.js";
import { reloaded } from "./reload.js";

const REMOTE_DIR = join(PACKAGES_DIR, "remote");
const KEYS = new Set([
  "namespace",
  "tools",
  "skills",
  "policy",
  "client",
  "extensions",
  "secrets",
  "config",
]);
export type FetchedPackage = {
  source: string;
  link?: string;
  namespace: string;
  description?: string;
  path: string;
  root?: string;
  skills: string[];
  extensions: string[];
  secrets: string[];
  config: string[];
  tools: { entry: Entry; bundle: string; npm: string[] }[];
  rules: string;
  client?: ClientView;
};

export const isRemote = (source: string) =>
  source.startsWith("npm:") || /^(git:|https?:|ssh:|git@)/.test(source);

// The exact npm version or Git commit a source points to now. An approved
// install records it, so the approval and the install fetch the same code.
export async function resolveVersion(source: string) {
  if (source.startsWith("npm:")) {
    const { stdout } = await promisify(execFile)("npm", [
      "view",
      source.slice(4),
      "version",
      "--json",
    ]);
    const found = JSON.parse(stdout || "null");
    const version = Array.isArray(found) ? found.at(-1) : found;
    if (typeof version !== "string") throw new Error(`no version of ${source}`);
    return version;
  }
  const pkg = await fetchPackage(source);
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: pkg.path })
      .toString()
      .trim();
  } finally {
    discardPackage(pkg);
  }
}

// Replaces any version or ref in the source, splitting it where Pi does.
function pinnedSource(source: string, version: string) {
  if (source.startsWith("npm:")) {
    if (!/^[\w.+-]+$/.test(version))
      throw new Error(`invalid version ${version}`);
    return `npm:${source.slice(4).replace(/(.)@.*$/, "$1")}@${version}`;
  }
  if (!/^[0-9a-f]{40,64}$/.test(version))
    throw new Error(`invalid commit ${version}`);
  const url = source.replace(/^git:/, "");
  const path = url.includes("://")
    ? url.indexOf("/", url.indexOf("://") + 3)
    : url.startsWith("git@")
      ? url.indexOf(":")
      : url.indexOf("/");
  const at = path < 0 ? -1 : url.indexOf("@", path);
  const base =
    at < 0 ? source : source.slice(0, source.length - url.length + at);
  return `${base}@${version}`;
}

// The link is built from the source the user approves, not from the package's
// own metadata, which could point anywhere.
function sourceLink(source: string, version: string, fetched: string) {
  if (source.startsWith("npm:"))
    return `https://www.npmjs.com/package/${source.slice(4).replace(/(.)@.*$/, "$1")}/v/${version}`;
  if (!isRemote(source)) return undefined;
  const match = source
    .replace(/^git:/, "")
    .replace(/^\w+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .match(/^([^/:]+)[/:]([^@]+?)(?:\.git)?(?:@.+)?$/);
  if (!match) return undefined;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fetched })
    .toString()
    .trim();
  return `https://${match[1]}/${match[2]}/tree/${commit}`;
}

// Fetching runs no package code: npm install scripts are off in the gateway.
// Each fetch gets its own folder, which becomes the installed copy or is
// discarded, so an installed package changes only when an install succeeds.
// Local packages are read from their copy in packages/local, which changes
// only through an approved write.
async function fetchPackage(
  source: string,
  {
    replace = false,
    dir,
    spec = source,
  }: { replace?: boolean; dir?: string; spec?: string } = {},
): Promise<FetchedPackage> {
  if (dir) return readPackage(source, dir, replace);
  if (!isRemote(source))
    throw new Error(
      "install an npm: package or a Git URL; write a workspace package with package_write",
    );
  mkdirSync(REMOTE_DIR, { recursive: true });
  const root = mkdtempSync(`${REMOTE_DIR}/`);
  try {
    const packages = new DefaultPackageManager({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.create(root, root, {
        projectTrusted: false,
      }),
    });
    await packages.install(spec);
    const fetched = packages.getInstalledPath(spec, "user") ?? root;
    return { ...readPackage(source, fetched, replace, root), root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const discardPackage = (pkg: { root?: string }) =>
  pkg.root && rmSync(pkg.root, { recursive: true, force: true });

// Removes fetches that never became an install, such as ones a crash cut short.
export function discardUnusedFetches() {
  if (!existsSync(REMOTE_DIR)) return;
  const used = new Set(Object.values(readPackages()).map((pkg) => pkg.root));
  for (const name of readdirSync(REMOTE_DIR))
    if (!used.has(join(REMOTE_DIR, name)))
      rmSync(join(REMOTE_DIR, name), { recursive: true, force: true });
}

export async function previewPackage(source: string, version: string) {
  const pkg = await fetchPackage(source, {
    spec: pinnedSource(source, version),
  });
  try {
    return packageSummary(pkg, version);
  } finally {
    discardPackage(pkg);
  }
}

export async function installRemotePackage(source: string, version?: string) {
  const pkg = await fetchPackage(source, {
    spec: version ? pinnedSource(source, version) : source,
  });
  const previous = readPackages()[source];
  try {
    return { pkg, previous, tools: installPackage(pkg) };
  } catch (error) {
    discardPackage(pkg);
    throw error;
  }
}

// A tool runs as one file: its entry bundled with everything it imports. The
// imports must resolve inside the fetched folder, so a tool cannot pull in
// files such as Nu's secrets. Sources are keyed by their path in the package,
// or in node_modules, so the same code hashes the same from any source.
function bundleTool(entry: string, path: string, root: string) {
  const top = realpathSync(root);
  let result: ReturnType<typeof buildSync>;
  try {
    result = buildSync({
      entryPoints: [entry],
      absWorkingDir: top,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      write: false,
      metafile: true,
      logLevel: "silent",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
  } catch (error) {
    const errors = (error as { errors?: { text: string }[] }).errors;
    throw new Error(
      `${relative(path, entry)} does not bundle: ${errors?.map((e) => e.text).join("; ") ?? error}`,
    );
  }
  const own = realpathSync(path);
  const sources: Record<string, string> = {};
  const npm = new Set<string>();
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const file = resolve(top, input);
    if (relative(top, file).startsWith(".."))
      throw new Error(
        `${relative(path, entry)} imports ${input}, outside the package`,
      );
    const inPackage = relative(own, file);
    const at = file.lastIndexOf("/node_modules/");
    const key =
      !inPackage.startsWith("..") && !inPackage.startsWith("node_modules/")
        ? inPackage
        : at < 0
          ? relative(top, file)
          : file.slice(at + 1);
    sources[key] = readFileSync(file, "utf8");
    const name = key.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
    if (name) {
      const manifest = join(
        file.slice(0, at),
        "node_modules",
        name,
        "package.json",
      );
      npm.add(`${name}@${JSON.parse(readFileSync(manifest, "utf8")).version}`);
    }
  }
  return {
    bundle: result.outputFiles?.[0]?.text ?? "",
    sources,
    npm: [...npm].sort(),
  };
}

function readPackage(
  source: string,
  path: string,
  replace: boolean,
  root?: string,
): FetchedPackage {
  if (!existsSync(join(path, "package.json")))
    throw new Error(`no package.json at ${source}`);
  const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const nu = pkg.nu as Record<string, unknown> | undefined;
  if (!nu) throw new Error(`${source} has no nu key in package.json`);
  const unknown = Object.keys(nu).filter((key) => !KEYS.has(key));
  if (unknown.length)
    throw new Error(`${source} has unknown nu keys (${unknown.join(", ")})`);
  const namespace = String(nu.namespace ?? "");
  if (!NAMESPACE.test(namespace) || RESERVED_NAMESPACES.includes(namespace))
    throw new Error(
      `namespace ${namespace || "(none)"} is invalid or reserved`,
    );
  const secrets = (nu.secrets as string[] | undefined) ?? [];
  const config = (nu.config as string[] | undefined) ?? [];
  for (const name of secrets)
    if (typeof name !== "string" || !SECRET_NAME.test(name))
      throw new Error(`secret ${name} must be UPPER_SNAKE_CASE`);
  for (const name of config)
    if (typeof name !== "string" || !EXTENSION_KEY.test(name))
      throw new Error(`${name} must be letters, digits, _ and -`);
  const owner = Object.entries(readPackages()).find(
    ([other, installed]) =>
      installed.namespace === namespace && other !== source,
  );
  if (owner && !replace)
    throw new Error(`namespace ${namespace} belongs to ${owner[0]}`);
  const tools = ((nu.tools as string[] | undefined) ?? [])
    .flatMap((pattern) => globSync(pattern, { cwd: path }))
    .map((manifestPath) => {
      const yaml = readFileSync(join(path, manifestPath), "utf8");
      const manifest = validateManifest(parse(yaml), namespace);
      const { bundle, sources, npm } = bundleTool(
        join(path, dirname(manifestPath), manifest.entry),
        path,
        root ?? path,
      );
      return {
        entry: {
          manifest,
          hash: codeHash({ ...sources, [manifestPath]: yaml }),
          bundleHash: sha256(bundle),
          package: source,
        },
        bundle,
        npm,
      };
    });
  return {
    source,
    link: sourceLink(source, pkg.version, path),
    namespace,
    description: text(pkg.description, 200, "description"),
    path,
    skills: ((nu.skills as string[] | undefined) ?? []).map((dir) =>
      resolve(path, dir),
    ),
    extensions: ((nu.extensions as string[] | undefined) ?? []).map((entry) =>
      resolve(path, entry),
    ),
    secrets,
    config,
    tools,
    rules: nu.policy
      ? readFileSync(resolve(path, String(nu.policy)), "utf8")
      : "",
    client: nu.client
      ? validateClient(nu.client, namespace, source)
      : undefined,
  };
}

const text = (value: unknown, max: number, what: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new Error(`${what} must be text of at most ${max} characters`);
  return value;
};

// A package styles only its own tools, so it cannot disguise another tool, and
// its commands cannot take a built-in or another package's name.
function validateClient(value: unknown, namespace: string, source: string) {
  const { tools = {}, commands = {} } = value as {
    tools?: Record<string, Record<string, unknown>>;
    commands?: Record<string, Record<string, unknown>>;
  };
  const view: Required<ClientView> = { tools: {}, commands: {} };
  for (const [name, display] of Object.entries(tools)) {
    if (!name.startsWith(`${namespace}__`))
      throw new Error(`client tool ${name} is outside namespace ${namespace}`);
    const body = text(display.body, 64, `${name} body`);
    if (body !== undefined && !/^\w+$/.test(body))
      throw new Error(`${name} body must name an argument`);
    const language = text(display.language, 20, `${name} language`);
    if (language !== undefined && !/^[\w+#-]+$/.test(language))
      throw new Error(`${name} language`);
    view.tools[name] = {
      icon: text(display.icon, 4, `${name} icon`),
      title: text(display.title, 200, `${name} title`),
      body,
      language,
    };
  }
  const taken = Object.entries(readPackages()).flatMap(([other, installed]) =>
    other === source || installed.namespace === namespace
      ? []
      : Object.keys(installed.client?.commands ?? {}),
  );
  for (const [name, command] of Object.entries(commands)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name))
      throw new Error(
        `command ${name} must be lowercase letters, digits, and dashes`,
      );
    if (COMMANDS.some((c) => c.name === name) || taken.includes(name))
      throw new Error(`command /${name} is already taken`);
    view.commands[name] = {
      description: text(command.description, 100, `/${name} description`) ?? "",
      message: text(command.message, 2000, `/${name} message`) ?? "",
    };
    if (!view.commands[name].message)
      throw new Error(`/${name} needs a message`);
  }
  return view;
}

// Every tool is checked before any is activated, so a rejected package leaves
// the installed one as it was.
function checkVersions(pkg: FetchedPackage) {
  const index = readIndex();
  for (const { entry } of pkg.tools) {
    const { name, version } = entry.manifest;
    const current = index[name];
    if (!current || current.removed) continue;
    if (version < current.version)
      throw new Error(`${name} is already at version ${current.version}`);
    if (
      version === current.version &&
      readEntry(name, version).hash !== entry.hash
    )
      throw new Error(
        `${name} changed; raise its version above ${current.version}`,
      );
  }
}

function installPackage(pkg: FetchedPackage) {
  checkVersions(pkg);
  const index = readIndex();
  const tools: string[] = [];
  for (const { entry, bundle } of pkg.tools) {
    const current = index[entry.manifest.name];
    if (current?.version !== entry.manifest.version || current.removed)
      activate(entry, bundle);
    tools.push(entry.manifest.name);
  }
  const previous = readPackages()[pkg.source];
  writePackages({
    ...readPackages(),
    [pkg.source]: {
      namespace: pkg.namespace,
      description: pkg.description,
      path: pkg.path,
      root: pkg.root,
      skills: pkg.skills,
      extensions: pkg.extensions,
      secrets: pkg.secrets,
      tools,
      client: pkg.client,
    },
  });
  if (previous?.root !== pkg.root) discardPackage(previous ?? {});
  return tools;
}

export function missingValues(pkg: FetchedPackage) {
  const config = readSettings().config?.[pkg.namespace] ?? {};
  const secrets = [
    ...pkg.secrets,
    ...pkg.tools.flatMap(({ entry }) => entry.manifest.secrets),
  ];
  return {
    secrets: [...new Set(secrets)].filter((name) => !hasSecret(name)),
    config: pkg.config.filter((key) => !(key in config)),
  };
}

export function saveSecret(name: string, value: string) {
  setSecret(name, value);
  syncSandboxEnv();
  return Object.values(readPackages()).some(
    (pkg) => pkg.extensions?.length && pkg.secrets?.includes(name),
  )
    ? reloaded(`Saved ${name}.`)
    : `Saved ${name}.`;
}

export function removePackage(source: string) {
  const { [source]: removed, ...rest } = readPackages();
  if (!removed) return false;
  removePackageTools(source);
  writePackages(rest);
  discardPackage(removed);
  return true;
}

function describe(manifest: Manifest, npm: string[] = []) {
  return [
    `**${manifest.name}** v${manifest.version}: ${manifest.description}`,
    `  ${manifest.idempotency === "at_most_once" ? "Not retried after a crash" : "Safe to retry"}; secrets ${manifest.secrets.join(", ") || "none"}`,
    npm.length
      ? `  npm packages (${npm.length}): ${npm.slice(0, 20).join(", ")}${npm.length > 20 ? ", …" : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function packageSummary(pkg: FetchedPackage, version: string) {
  return [
    `Install package ${pkg.source} at ${version} (namespace ${pkg.namespace}):`,
    pkg.link ? `Source: ${pkg.link}` : "",
    pkg.extensions.length ? EXTENSIONS_WARNING : "",
    pkg.secrets.length ? `Extension secrets: ${pkg.secrets.join(", ")}.` : "",
    pkg.config.length ? `Settings: ${pkg.config.join(", ")}.` : "",
    ...pkg.tools.map(({ entry, npm }) => describe(entry.manifest, npm)),
    pkg.tools.length ? "" : "No tools.",
    `Skills: ${pkg.skills.length}.`,
    pkg.rules
      ? `Suggested rules:\n\`\`\`yaml\n${pkg.rules.trim()}\n\`\`\``
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const EXTENSIONS_WARNING =
  "Includes extensions, which run inside Nu with full access.";
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;
const DIFF_LINES = 40;

const localDir = (namespace: string) => join(PACKAGES_DIR, "local", namespace);
const localSource = (namespace: string) => `local:${namespace}`;

function installedPackage(namespace: string) {
  const found = Object.entries(readPackages()).find(
    ([, installed]) => installed.namespace === namespace,
  );
  if (!found) return undefined;
  const [source, installed] = found;
  return { source, files: installed.path, ...installed };
}

export async function checkoutPackage(namespace: string) {
  const installed = installedPackage(namespace);
  if (!installed) throw new Error(`no package has namespace ${namespace}`);
  const dir = join("packages", namespace);
  const to = join(sandbox.workdir, dir);
  if (
    await sandbox.access(to).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`${dir} already exists in the workspace`);
  for (const item of readdirSync(installed.files, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = relative(installed.files, join(item.parentPath, item.name));
    if (item.isFile() && !SKIP.test(path))
      await sandbox.writeFile(
        join(to, path),
        readFileSync(join(installed.files, path)),
      );
  }
  return dir;
}

// The recorded files must be the ones hashed, and the extensions flag policy
// sees must match them.
export function validateWrite(args: Record<string, unknown>) {
  const files = args.files as Record<string, string>;
  if (codeHash(files) !== args.code_hash)
    throw new Error("the files do not match code_hash");
  const nu = JSON.parse(files["package.json"] ?? "{}").nu as
    | Record<string, unknown>
    | undefined;
  if (!nu) throw new Error("package.json needs a nu key");
  const namespace = String(nu.namespace ?? "");
  if (
    namespace !== args.namespace ||
    !NAMESPACE.test(namespace) ||
    RESERVED_NAMESPACES.includes(namespace)
  )
    throw new Error(
      `namespace ${namespace || "(none)"} is invalid or reserved`,
    );
  if (
    Boolean((nu.extensions as unknown[] | undefined)?.length) !==
    args.extensions
  )
    throw new Error("extensions does not match package.json");
  return { namespace, files };
}

export async function uploadPackage(files: unknown) {
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.every(([, content]) => typeof content === "string"))
    throw new Error("files must map paths to text");
  const text = Object.fromEntries(entries) as Record<string, string>;
  const namespace = String(
    JSON.parse(text["package.json"] ?? "{}").nu?.namespace ?? "",
  );
  if (!NAMESPACE.test(namespace) || RESERVED_NAMESPACES.includes(namespace))
    throw new Error(
      `namespace ${namespace || "(none)"} is invalid or reserved`,
    );
  const { pkg, previous } = await writeLocalPackage(namespace, text);
  return {
    pkg,
    previous,
    tools: pkg.tools.map(({ entry }) => entry.manifest.name),
  };
}

function npmCi(dir: string) {
  execFileSync(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: dir },
  );
}

export async function writeLocalPackage(
  namespace: string,
  files: Record<string, string>,
) {
  for (const path of Object.keys(files))
    if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
      throw new Error(`${path} is outside the package`);
  const dir = localDir(namespace);
  const next = `${dir}.next`;
  const prev = `${dir}.prev`;
  rmSync(next, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(next, path)), { recursive: true });
    writeFileSync(join(next, path), content);
  }
  if (files["package-lock.json"]) npmCi(next);
  const previous = installedPackage(namespace);
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, prev);
  renameSync(next, dir);
  try {
    const pkg = await fetchPackage(localSource(namespace), {
      replace: true,
      dir,
    });
    checkVersions(pkg);
    if (previous) removePackage(previous.source);
    installPackage(pkg);
    rmSync(prev, { recursive: true, force: true });
    return { pkg, previous };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(prev)) renameSync(prev, dir);
    throw error;
  }
}

function diffFiles(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  const stats: string[] = [];
  const lines: string[] = [];
  for (const path of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    const old = before[path] ?? "";
    const next = after[path] ?? "";
    if (old === next) continue;
    const diff = generateDiffString(old, next).diff.split("\n");
    const added = diff.filter((l) => l.startsWith("+")).length;
    const removed = diff.filter((l) => l.startsWith("-")).length;
    const state = !(path in before)
      ? " (new)"
      : !(path in after)
        ? " (deleted)"
        : "";
    stats.push(`\`${path}\`${state} +${added} -${removed}`);
    if (path.endsWith("package-lock.json")) continue;
    lines.push(
      `--- ${path}`,
      ...diff.map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)),
    );
  }
  return { stats, lines };
}

export function writeSummary(args: Record<string, unknown>) {
  const { namespace, files } = validateWrite(args);
  const installed = installedPackage(namespace);
  const current =
    installed && existsSync(installed.files) ? readFiles(installed.files) : {};
  const header = !installed
    ? `Create package **${namespace}**:`
    : installed.source === localSource(namespace)
      ? `Update package **${namespace}**:`
      : `Replace package **${namespace}** from ${installed.source} with a local copy:`;
  const tools = Object.keys(files)
    .filter((path) => basename(path) === "tool.yaml")
    .map((path) => describe(parse(files[path] ?? "") as Manifest));
  const npm = dependencies(files);
  const { stats, lines } = diffFiles(current, files);
  const tests = String(args.test_output ?? "")
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
  return [
    header,
    args.extensions ? EXTENSIONS_WARNING : "",
    ...tools,
    npm.length
      ? `npm packages (${npm.length}): ${npm.slice(0, 20).join(", ")}${npm.length > 20 ? ", …" : ""}`
      : "",
    stats.length ? `Changes:\n${stats.join("\n")}` : "No file changes.",
    lines.length
      ? `\`\`\`diff\n${lines
          .slice(0, DIFF_LINES)
          .concat(
            lines.length > DIFF_LINES
              ? [`… ${lines.length - DIFF_LINES} more lines`]
              : [],
          )
          .join("\n")
          .replaceAll("```", "`\u200b``")}\n\`\`\``
      : "",
    tests ? `Tests:\n\`\`\`\n${tests}\n\`\`\`` : "No test output.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function clientView() {
  const view: Required<ClientView> = { tools: {}, commands: {} };
  for (const { client } of Object.values(readPackages())) {
    Object.assign(view.tools, client?.tools);
    Object.assign(view.commands, client?.commands);
  }
  return view;
}

export const commandList = (): CommandInfo[] => [
  ...COMMANDS,
  ...Object.entries(clientView().commands).map(
    ([name, { description, message }]) => ({
      name,
      description,
      args: message.includes("{args}") ? "text" : undefined,
    }),
  ),
];
