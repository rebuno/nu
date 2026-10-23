import { Cron } from "croner";
import { requiredEnv } from "../config.js";
import { openDb, type Schedule } from "../db.js";
import { readSettings, timeZone } from "../settings.js";

const GATEWAY_URL = "http://127.0.0.1:4120";
const secret = requiredEnv("GATEWAY_SECRET");
const settings = readSettings();
const heartbeat = settings.heartbeat ?? "*/30 * * * *";
const db = openDb();

if (heartbeat === "off")
  db.prepare("delete from schedules where id = ?").run("heartbeat");
else
  db.prepare(
    "insert into schedules (id, cron, time_zone, instructions, conversation, created_at) values ('heartbeat', ?, ?, ?, 'main', ?) on conflict(id) do update set cron = excluded.cron, time_zone = excluded.time_zone",
  ).run(
    heartbeat,
    timeZone(settings),
    "Heartbeat: check for anything that needs the user's attention now, such as reminders due in your notes, work you promised to follow up on, or schedules that failed. Tell the user only what they need to know.",
    new Date().toISOString(),
  );

function due(schedule: Schedule, now: Date) {
  if (!schedule.cron)
    return schedule.at && new Date(schedule.at) <= now
      ? new Date(schedule.at)
      : undefined;
  const cron = new Cron(schedule.cron, { timezone: schedule.time_zone });
  let fire = cron.nextRun(new Date(schedule.last_fired ?? schedule.created_at));
  if (!fire || fire > now) return undefined;
  for (
    let next = cron.nextRun(fire);
    next && next <= now;
    next = cron.nextRun(next)
  )
    fire = next;
  return fire;
}

async function fire(schedule: Schedule, at: Date) {
  const key = `schedule:${schedule.id}:${at.toISOString()}`;
  const response = await fetch(`${GATEWAY_URL}/internal/turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      conversation: schedule.conversation,
      session: schedule.isolated ? key : undefined,
      message: schedule.instructions,
      idempotency_key: key,
      trigger: schedule.id === "heartbeat" ? "heartbeat" : "schedule",
    }),
  });
  if (!response.ok && response.status !== 409)
    throw new Error(`${response.status} ${await response.text()}`);
  if (!response.ok)
    console.warn(`scheduler: skipped ${schedule.id}: ${await response.text()}`);
  if (schedule.cron)
    db.prepare("update schedules set last_fired = ? where id = ?").run(
      at.toISOString(),
      schedule.id,
    );
  else db.prepare("delete from schedules where id = ?").run(schedule.id);
}

async function tick() {
  const now = new Date();
  for (const schedule of db
    .prepare("select * from schedules")
    .all() as Schedule[]) {
    const at = due(schedule, now);
    if (!at) continue;
    await fire(schedule, at).catch((error) =>
      console.error(`scheduler: firing ${schedule.id} failed`, error),
    );
  }
}

console.log("scheduler: running");
for (;;) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
