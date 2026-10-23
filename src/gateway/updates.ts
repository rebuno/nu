import pkg from "../../package.json" with { type: "json" };
import { readSettings } from "../settings.js";

const RELEASES = "https://api.github.com/repos/rebuno/nu/releases/latest";
const DAY_MS = 86_400_000;

let latest: string | undefined;

const parts = (version: string) => version.split(".").map(Number);

function newer(version: string, than: string) {
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < 3; i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// The request names nothing about this install.
async function check() {
  if (readSettings().updateCheck === "off") return;
  try {
    const response = await fetch(RELEASES, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const { tag_name } = (await response.json()) as { tag_name?: string };
    const version = String(tag_name ?? "").replace(/^v/, "");
    latest =
      /^\d+\.\d+\.\d+$/.test(version) && newer(version, pkg.version)
        ? version
        : undefined;
  } catch {}
}

export function checkForUpdates() {
  void check();
  setInterval(check, DAY_MS).unref();
}

export const updateNotice = () =>
  latest && readSettings().updateCheck !== "off"
    ? `Nu ${latest} is available. Run nu update.`
    : undefined;
