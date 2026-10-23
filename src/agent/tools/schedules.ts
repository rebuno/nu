import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Type } from "@earendil-works/pi-ai";
import { Cron } from "croner";
import { execution } from "rebuno";

import type { Schedule } from "../../db.js";
import { anyTool, text } from "./tool.js";

export function scheduleTools(
  db: DatabaseSync,
  defaults: { timeZone: string; conversation: string },
) {
  const scheduleCreate = anyTool({
    name: "schedule_create",
    label: "Schedule",
    description:
      "Schedule instructions to run later, once at a time or repeatedly on a cron expression. Each run is a separate turn that starts from the instructions alone, so make them self-contained. Its reply is posted to the conversation.",
    parameters: Type.Object({
      instructions: Type.String(),
      cron: Type.Optional(
        Type.String({ description: "Five-field cron expression" }),
      ),
      at: Type.Optional(
        Type.String({ description: "ISO 8601 time with offset, for one run" }),
      ),
      time_zone: Type.Optional(Type.String({ description: "IANA time zone" })),
      conversation: Type.Optional(
        Type.String({
          description:
            "Conversation key to run in and post to: `main` for the user's direct conversation, or `<channel>:<id>` for a channel or thread. Defaults to this conversation.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description:
            "Run each time in a fresh session that keeps its work out of the conversation's history, for briefs and reports. The reply is still posted.",
        }),
      ),
    }),
    execute: async (_id, args) => {
      if (!args.cron === !args.at)
        throw new Error("give exactly one of cron and at");
      const timeZone = args.time_zone ?? defaults.timeZone;
      if (args.cron) new Cron(args.cron, { timezone: timeZone });
      if (args.at && Number.isNaN(Date.parse(args.at)))
        throw new Error(`at is not a valid time: ${args.at}`);
      const id = createHash("sha256")
        .update(execution().id + JSON.stringify(args))
        .digest("hex")
        .slice(0, 8);
      db.prepare(
        "insert into schedules (id, cron, at, time_zone, instructions, conversation, created_at, isolated) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do nothing",
      ).run(
        id,
        args.cron ?? null,
        args.at ? new Date(args.at).toISOString() : null,
        timeZone,
        args.instructions,
        args.conversation ?? defaults.conversation,
        new Date().toISOString(),
        args.isolated ? 1 : 0,
      );
      return text(`Scheduled ${id}.`);
    },
  });

  const scheduleList = anyTool({
    name: "schedule_list",
    label: "Schedules",
    description: "List schedules.",
    parameters: Type.Object({}),
    execute: async () => {
      const rows = db
        .prepare("select * from schedules order by created_at")
        .all() as Schedule[];
      return text(
        rows
          .map(
            (s) =>
              `${s.id}: ${s.cron ? `cron "${s.cron}"` : `at ${s.at}`} (${s.time_zone}) in ${s.conversation}${s.isolated ? ", isolated" : ""}, last run ${s.last_fired ?? "never"}\n  ${s.instructions}`,
          )
          .join("\n") || "No schedules.",
      );
    },
  });

  const scheduleDelete = anyTool({
    name: "schedule_delete",
    label: "Unschedule",
    description: "Delete a schedule by ID.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, { id }) => {
      const { changes } = db
        .prepare("delete from schedules where id = ?")
        .run(id);
      return text(changes ? `Deleted ${id}.` : `No schedule ${id}.`);
    },
  });

  return { scheduleCreate, scheduleList, scheduleDelete };
}
