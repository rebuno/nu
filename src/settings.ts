import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.js";

const SETTINGS_PATH = join(DATA_DIR, "settings.json");

type Settings = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  timeZone?: string;
  heartbeat?: string;
  updateCheck?: string;
  liveUrl?: string;
  sandboxSecrets?: string[];
  compactionModel?: string;
  config?: Record<string, Record<string, unknown>>;
};

export const readSettings = (): Settings =>
  existsSync(SETTINGS_PATH)
    ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8"))
    : {};

export function writeSettings(settings: Settings) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

export function setExtensionConfig(
  namespace: string,
  key: string,
  value: string,
) {
  const settings = readSettings();
  writeSettings({
    ...settings,
    config: {
      ...settings.config,
      [namespace]: { ...settings.config?.[namespace], [key]: value },
    },
  });
}

export const timeZone = (settings: Settings) =>
  settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
