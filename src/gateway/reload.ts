import { env } from "node:process";

// The supervisor in start.ts restarts the gateway, agent, runner, and
// scheduler on SIGHUP. The delay lets the current response reach the client.
export function reload() {
  const supervisor = Number(env.NU_SUPERVISOR_PID);
  if (!supervisor) return false;
  setTimeout(() => process.kill(supervisor, "SIGHUP"), 200);
  return true;
}

export const reloaded = (done: string) =>
  [done, reload() ? "Reloading Nu." : "Restart Nu to load the change."]
    .filter(Boolean)
    .join(" ");
