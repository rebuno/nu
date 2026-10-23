import { chmod, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/client/nu.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  metafile: true,
});
for (const input of Object.keys(result.metafile.inputs)) {
  if (
    input !== "src/cli.ts" &&
    input !== "package.json" &&
    !input.startsWith("src/terminal/")
  )
    throw new Error(`Server code entered the client bundle: ${input}`);
}
await chmod("dist/client/nu.js", 0o755);

const root = JSON.parse(await readFile("package.json", "utf8"));
const imported = new Set(
  Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((i) => i.external && !i.path.startsWith("node:"))
    .map((i) => i.path.match(/^(@[^/]+\/)?[^/]+/)[0]),
);
const dependencies = Object.fromEntries(
  [...imported].sort().map((name) => {
    const version = root.dependencies[name];
    if (!version) throw new Error(`${name} is not a dependency of Nu`);
    return [name, version];
  }),
);
await writeFile(
  "dist/client/package.json",
  `${JSON.stringify(
    {
      name: "@rebuno/nu",
      version: root.version,
      description: "Terminal client for Nu",
      license: "MIT",
      type: "module",
      bin: { nu: "nu.js" },
      engines: root.engines,
      dependencies,
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  "dist/client/README.md",
  `# @rebuno/nu

The terminal client for [Nu](https://github.com/rebuno/nu), the personal agent
that runs on your rules.

Install Nu, which sets up the server and this client:

\`\`\`bash
curl -fsSL https://nu.rebuno.io/install.sh | sh
nu login
nu
\`\`\`

To use Nu running on another machine, install only the client:

\`\`\`bash
npm install -g @rebuno/nu
\`\`\`

Then connect it as described in
[Remote access](https://docs.rebuno.io/nu/deployment#remote-access).

See the [Nu documentation](https://docs.rebuno.io/nu/overview).
`,
);
