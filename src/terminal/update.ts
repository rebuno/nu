import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

const INSTALLER = "https://raw.githubusercontent.com/rebuno/nu/main/install.sh";

function run(command: string, args: string[], input?: string) {
  const { status, error } = spawnSync(command, args, {
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (error) throw error;
  if (status !== 0) throw new Error(`${command} exited with ${status}`);
}

// The installer replaces compose.yaml, pulls the images, restarts what
// changed, and installs the client, so running it again is the update.
export async function update() {
  const home = env.NU_HOME ?? join(homedir(), ".nu");
  if (existsSync(join(home, "compose.yaml"))) {
    const response = await fetch(INSTALLER);
    if (!response.ok)
      throw new Error(
        `Downloading the installer failed: HTTP ${response.status}`,
      );
    run("sh", [], await response.text());
    return;
  }
  run("npm", ["install", "-g", "@rebuno/nu@latest"]);
  console.log(
    "Updated the client. Run nu update where Nu runs to update the server.",
  );
}
