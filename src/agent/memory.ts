import type { DatabaseSync } from "node:sqlite";

export type ProfileEntry = { key: string; value: string };
export type Note = { key: string; text: string; updated_at: string };

export interface MemoryStore {
  profile(): Promise<ProfileEntry[]>;
  writeProfile(key: string, value: string): Promise<void>;
  writeNote(scope: string, key: string, text: string): Promise<void>;
  searchNotes(scope: string, query: string, limit: number): Promise<Note[]>;
}

export function sqliteMemory(db: DatabaseSync): MemoryStore {
  return {
    async profile() {
      return db
        .prepare("select key, value from profile order by key")
        .all() as ProfileEntry[];
    },
    async writeProfile(key, value) {
      if (value)
        db.prepare(
          "insert into profile values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
        ).run(key, value, new Date().toISOString());
      else db.prepare("delete from profile where key = ?").run(key);
    },
    async writeNote(scope, key, text) {
      db.prepare("delete from notes where key = ? and scope = ?").run(
        key,
        scope,
      );
      if (text)
        db.prepare("insert into notes values (?, ?, ?, ?)").run(
          key,
          text,
          new Date().toISOString(),
          scope,
        );
    },
    async searchNotes(scope, query, limit) {
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!terms.length) return [];
      return db
        .prepare(
          "select key, text, updated_at from notes where notes match ? and scope = ? order by rank limit ?",
        )
        .all(
          terms.map((term) => `"${term}"`).join(" OR "),
          scope,
          limit,
        ) as Note[];
    },
  };
}
