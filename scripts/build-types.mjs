import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const EXTERNAL = /^(node:|playwright-core$)/;

const emitted = mkdtempSync(join(tmpdir(), "nu-types-"));
execFileSync(
  "node_modules/.bin/tsc",
  [
    "--noEmit",
    "false",
    "--declaration",
    "--emitDeclarationOnly",
    "--outDir",
    emitted,
  ],
  { stdio: "inherit" },
);

// Only the declarations index.d.ts reaches are published.
const root = join(emitted, "src");
const reached = new Set();
const visit = (file) => {
  if (reached.has(file)) return;
  reached.add(file);
  const source = readFileSync(file, "utf8");
  for (const [, from, imported] of source.matchAll(
    /from "([^"]+)"|import\("([^"]+)"\)/g,
  )) {
    const specifier = from ?? imported;
    if (specifier.startsWith("."))
      visit(resolve(dirname(file), specifier.replace(/\.js$/, ".d.ts")));
    else if (!EXTERNAL.test(specifier))
      throw new Error(
        `${relative(root, file)} imports ${specifier}, which the types package does not depend on`,
      );
  }
};
visit(join(root, "index.d.ts"));

rmSync("dist/types", { recursive: true, force: true });
for (const file of reached)
  cpSync(file, join("dist/types", relative(root, file)));
rmSync(emitted, { recursive: true });

const nu = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "dist/types/package.json",
  `${JSON.stringify(
    {
      name: "@rebuno/nu-types",
      version: nu.version,
      description: "Types for Nu packages: tools, extensions, and channels",
      license: "MIT",
      type: "module",
      exports: { ".": { types: "./index.d.ts" } },
      peerDependencies: { "@types/node": "*", "playwright-core": "*" },
      peerDependenciesMeta: { "@types/node": { optional: true } },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  "dist/types/README.md",
  `# @rebuno/nu-types

Types for writing [Nu](https://github.com/rebuno/nu) packages.

\`\`\`ts
import type { Extension, ToolHandler } from "@rebuno/nu-types";
\`\`\`

See [Extensions](https://docs.rebuno.io/nu/extensions).
`,
);
