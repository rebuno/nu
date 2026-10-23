import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const { args, stepId, config } = JSON.parse(Buffer.concat(chunks).toString());

try {
  const tool = await import(pathToFileURL(process.argv[2] ?? "").href);
  const result = await tool.default(args, { stepId, config });
  writeSync(3, JSON.stringify({ result: result ?? null }));
} catch (error) {
  writeSync(
    3,
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
