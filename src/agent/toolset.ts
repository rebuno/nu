import type { DatabaseSync } from "node:sqlite";
import type { Idempotency } from "rebuno";

import type { MemoryStore } from "./memory.js";
import { browserTools, type Inner } from "./tools/browser.js";
import {
  backgroundTask,
  delegateTool,
  messageSend,
  packageCheckout,
  packageInstall,
  packageRemove,
  packageSearch,
  packageWrite,
  secretsRequest,
  specialistWrite,
} from "./tools/gateway.js";
import { memoryTools } from "./tools/memory.js";
import { policyRead, policyUpdate } from "./tools/policy.js";
import { scheduleTools } from "./tools/schedules.js";
import { skillWrite } from "./tools/skills.js";
import type { NuTool } from "./tools/tool.js";
import { workspaceTools } from "./tools/workspace.js";

export function seedTools(
  db: DatabaseSync,
  memoryStore: MemoryStore,
  turn: {
    timeZone: string;
    conversation: string;
    memoryScope?: string;
    specialists?: { name: string; instructions: string }[];
    inner?: Inner;
  },
): [NuTool, Idempotency][] {
  const memory = memoryTools(
    memoryStore,
    turn.memoryScope ?? "nu",
    !turn.memoryScope,
  );
  const schedules = scheduleTools(db, turn);
  const browser = browserTools(turn.inner);
  return [
    [memory.memorySearch, "safe_to_retry"],
    [memory.memoryWrite, "safe_to_retry"],
    [skillWrite, "safe_to_retry"],
    [browser.observe, "safe_to_retry"],
    [browser.task, "at_most_once"],
    [browser.submit, "at_most_once"],
    [browser.handoff, "safe_to_retry"],
    ...workspaceTools(),
    [messageSend, "at_most_once"],
    [schedules.scheduleCreate, "safe_to_retry"],
    [schedules.scheduleList, "safe_to_retry"],
    [schedules.scheduleDelete, "safe_to_retry"],
    [backgroundTask, "at_most_once"],
    [secretsRequest, "at_most_once"],
    [packageCheckout, "safe_to_retry"],
    [packageWrite, "at_most_once"],
    [policyRead, "safe_to_retry"],
    [policyUpdate, "at_most_once"],
    [packageSearch, "safe_to_retry"],
    [packageInstall, "at_most_once"],
    [packageRemove, "at_most_once"],
    [delegateTool(turn.specialists ?? []), "safe_to_retry"],
    [specialistWrite, "at_most_once"],
  ];
}
