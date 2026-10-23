import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { Idempotency } from "rebuno";
import { PACKAGES_DIR, SKILLS_DIR } from "../../config.js";
import { confine, sandbox, sharedSecrets } from "../../sandbox/index.js";
import { BUILT_IN_SKILLS } from "./skills.js";
import { type AnyTool, anyTool } from "./tool.js";

// Skills and long shell output stay on Nu's disk, read-only, wherever the
// sandbox runs.
const OWN = [SKILLS_DIR, PACKAGES_DIR, BUILT_IN_SKILLS, tmpdir()];
const own = (path: string) => confine(path, OWN).catch(() => undefined);

const read = async (path: string) => {
  const local = await own(path);
  return local ? readFile(local) : sandbox.readFile(path);
};

// Matches pi's detectSupportedImageMimeType, which it does not export.
function imageMime(data: Buffer) {
  const ascii = (at: number, text: string) =>
    data.subarray(at, at + text.length).toString("latin1") === text;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return data[3] === 0xf7 ? null : "image/jpeg";
  if (ascii(0, "\x89PNG\r\n\x1a\n")) {
    if (data.length < 16 || data.readUInt32BE(8) !== 13 || !ascii(12, "IHDR"))
      return null;
    for (let at = 8; at + 8 <= data.length; ) {
      if (ascii(at + 4, "acTL")) return null;
      if (ascii(at + 4, "IDAT")) break;
      const next = at + 12 + data.readUInt32BE(at);
      if (next <= at || next > data.length) break;
      at = next;
    }
    return "image/png";
  }
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM") && data.length >= 26) {
    const size = data.readUInt32LE(2);
    const offset = data.readUInt32LE(10);
    const header = data.readUInt32LE(14);
    const at = header === 12 ? 22 : header >= 40 && header <= 124 ? 26 : 0;
    if (!at || data.length < at + 4) return null;
    if ((size && (size < 26 || offset >= size)) || offset < 14 + header)
      return null;
    return data.readUInt16LE(at) === 1 &&
      [1, 4, 8, 16, 24, 32].includes(data.readUInt16LE(at + 2))
      ? "image/bmp"
      : null;
  }
  return null;
}

// pi reads a file right after sniffing it, so the sniffed contents are kept
// for that read.
const sniffed = new Map<string, Buffer>();

export function workspaceTools(): [AnyTool, Idempotency][] {
  const { workdir } = sandbox;
  return [
    [
      anyTool({
        ...createBashTool(workdir, {
          exposeSessionEnvironment: false,
          operations: {
            exec: (command, cwd, options) =>
              sandbox.exec(command, cwd, { ...options, env: sharedSecrets() }),
          },
        }),
        name: "shell",
      }),
      "at_most_once",
    ],
    [
      anyTool(
        createReadTool(workdir, {
          operations: {
            readFile: async (path) => {
              const data = sniffed.get(path);
              sniffed.delete(path);
              return data ?? read(path);
            },
            access: async (path) => {
              if (!(await own(path))) await sandbox.access(path);
            },
            detectImageMimeType: async (path) => {
              const data = await read(path);
              sniffed.set(path, data);
              return imageMime(data);
            },
          },
        }),
      ),
      "safe_to_retry",
    ],
    [
      anyTool(
        createWriteTool(workdir, {
          operations: {
            writeFile: (path, content) => sandbox.writeFile(path, content),
            mkdir: async () => {},
          },
        }),
      ),
      "safe_to_retry",
    ],
    [
      anyTool(
        createEditTool(workdir, {
          operations: {
            readFile: (path) => sandbox.readFile(path),
            writeFile: (path, content) => sandbox.writeFile(path, content),
            access: (path) => sandbox.access(path, true),
          },
        }),
      ),
      "safe_to_retry",
    ],
  ];
}
