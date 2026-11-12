import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";

import type { MemoryStore } from "../memory.js";
import { anyTool, text } from "./tool.js";

export function memoryTools(
  store: MemoryStore,
  memoryScope: string,
  profile: boolean,
) {
  const entry = {
    key: str({ description: "Short topic key, such as `diet`" }),
    text: str(),
  };
  const memoryWrite = anyTool({
    name: "memory_write",
    label: "Remember",
    description: profile
      ? "Save a memory entry under a key, replacing any entry with that key; empty text deletes it. Scope `profile` holds stable facts and preferences about the user, shown at the start of every conversation. Scope `notes` holds everything else, found with memory_search."
      : "Save a note under a key, replacing any note with that key; empty text deletes it. Find notes with memory_search.",
    parameters: obj(
      profile
        ? {
            ...entry,
            scope: opt(oneOf(["profile", "notes"])),
          }
        : entry,
      { open: true },
    ),
    execute: async (
      _id,
      {
        key,
        text: value,
        scope,
      }: { key: string; text: string; scope?: string },
    ) => {
      if (profile && scope === "profile") await store.writeProfile(key, value);
      else await store.writeNote(memoryScope, key, value);
      return text(value ? `Saved ${key}.` : `Deleted ${key}.`);
    },
  });

  const memorySearch = anyTool({
    name: "memory_search",
    label: "Recall",
    description: "Search saved notes by keywords.",
    parameters: obj({ query: str() }, { open: true }),
    execute: async (_id, { query }) => {
      const notes = await store.searchNotes(memoryScope, query, 8);
      return text(
        notes
          .map((note) => `## ${note.key} (${note.updated_at})\n${note.text}`)
          .join("\n\n") || "No matching notes.",
      );
    },
  });

  return { memoryWrite, memorySearch };
}
