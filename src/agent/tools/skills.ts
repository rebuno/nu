import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import { stringify } from "yaml";

import { SKILLS_DIR } from "../../config.js";
import { anyTool, text } from "./tool.js";

export const BUILT_IN_SKILLS = fileURLToPath(
  new URL("../skills", import.meta.url),
);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillWrite = anyTool({
  name: "skill_write",
  label: "Write skill",
  description:
    "Create or replace a skill: instructions for a kind of task, listed by name and description in every conversation and read when a task matches. Keep scripts it runs in the workspace and name them by absolute path. An empty body deletes the skill. Skills are available from the next turn.",
  parameters: Type.Object({
    name: Type.String({
      description:
        "Lowercase letters and digits joined by single hyphens, at most 64 characters",
    }),
    description: Type.String({
      description: "When to use the skill, at most 1024 characters",
    }),
    body: Type.String({ description: "The instructions, in Markdown" }),
  }),
  execute: async (_id, { name, description, body }) => {
    if (!NAME.test(name) || name.length > 64)
      throw new Error(
        "a skill name is lowercase letters and digits joined by single hyphens, at most 64 characters",
      );
    if (existsSync(join(BUILT_IN_SKILLS, name)))
      throw new Error(`${name} is a built-in skill`);
    const dir = join(SKILLS_DIR, name);
    if (!body.trim()) {
      rmSync(dir, { recursive: true, force: true });
      return text(`Deleted skill ${name}.`);
    }
    if (!description.trim() || description.length > 1024)
      throw new Error("a skill needs a description of at most 1024 characters");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\n${stringify({ name, description })}---\n\n${body.trim()}\n`,
    );
    return text(`Saved skill ${name}; it is available from the next turn.`);
  },
});
