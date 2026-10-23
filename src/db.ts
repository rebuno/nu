import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.js";

export type Schedule = {
  id: string;
  cron: string | null;
  at: string | null;
  time_zone: string;
  instructions: string;
  conversation: string;
  last_fired: string | null;
  created_at: string;
  isolated: number;
};

export function openDb() {
  const db = new DatabaseSync(join(DATA_DIR, "nu.db"));
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    create table if not exists profile (
      key text primary key,
      value text not null,
      updated_at text not null
    );
    create virtual table if not exists notes using fts5(
      key unindexed, text, updated_at unindexed, scope unindexed
    );
    create table if not exists schedules (
      id text primary key,
      cron text,
      at text,
      time_zone text not null,
      instructions text not null,
      conversation text not null,
      last_fired text,
      created_at text not null,
      isolated integer not null default 0
    );
  `);
  return db;
}
