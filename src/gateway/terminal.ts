import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { TurnEvent, TurnHandler } from "./channel.js";
import {
  APPROVAL_DECISIONS,
  type ApprovalDecision,
  type ChannelAdapter,
  type ListView,
  type MessageRef,
} from "./channel.js";
import type { HistoryEntry } from "./events.js";

type Frame = { turn?: string; event: TurnEvent };

import { HttpError } from "./gateway.js";
import { TerminalManagement } from "./terminal-management.js";

const terminalTokenPath = (dataDir: string) =>
  join(dataDir, "secrets", "terminal_token");

export class TerminalChannel implements ChannelAdapter {
  readonly name = "terminal";
  readonly userId = "user";
  readonly limits = { maxMessageLength: 100_000, minEditIntervalMs: 100 };
  readonly supportsEdits = false;
  readonly #token: string;
  readonly #management = new TerminalManagement();
  readonly #clients = new Set<ServerResponse>();
  readonly #turns = new Map<string, Frame[]>();
  #handlers?: Parameters<ChannelAdapter["start"]>[0];

  constructor(
    dataDir: string,
    private readonly history: () => Promise<HistoryEntry[]>,
  ) {
    mkdirSync(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
    const path = terminalTokenPath(dataDir);
    try {
      writeFileSync(path, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.#token = readFileSync(path, "utf8").trim();
  }

  reachable() {
    return this.#clients.size > 0;
  }

  async start(handlers: Parameters<ChannelAdapter["start"]>[0]) {
    this.#handlers = handlers;
  }

  #send(client: ServerResponse, frame: Frame) {
    if (client.destroyed || client.writableLength > 1_000_000) {
      client.destroy();
      this.#clients.delete(client);
      return;
    }
    client.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  #broadcast(frame: Frame) {
    for (const client of this.#clients) this.#send(client, frame);
  }

  turn(): TurnHandler {
    const id = randomUUID();
    const frames: Frame[] = [];
    this.#turns.set(id, frames);
    return {
      event: async (event) => {
        const frame = { turn: id, event };
        // Cumulative text snapshots need only their latest consecutive value.
        if (
          (event.type === "text" || event.type === "thinking") &&
          frames.at(-1)?.event.type === event.type
        )
          frames[frames.length - 1] = frame;
        else frames.push(frame);
        this.#broadcast(frame);
        if (event.type === "finished") this.#turns.delete(id);
      },
    };
  }

  async reply(_target: unknown, text: string): Promise<MessageRef> {
    this.#broadcast({ event: { type: "message", text } });
    return { channelId: this.name, messageId: randomUUID() };
  }

  async edit(_ref: MessageRef, text: string) {
    await this.reply(undefined, text);
  }
  async postApproval(
    _target: unknown,
    approval: Parameters<ChannelAdapter["postApproval"]>[1],
  ) {
    this.#broadcast({ event: { type: "approval", approval } });
    return { channelId: this.name, messageId: approval.id };
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.#token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, "unauthorized");
    if (await this.#management.handle(req, res)) return;
    if (!this.#handlers) throw new HttpError(503, "terminal is starting");
    if (req.url === "/terminal/history" && req.method === "GET") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(await this.history()));
      return;
    }
    if (req.url === "/terminal/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      this.#clients.add(res);
      for (const frames of this.#turns.values())
        for (const frame of frames) this.#send(res, frame);
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      res.on("close", () => {
        clearInterval(heartbeat);
        this.#clients.delete(res);
      });
      return;
    }
    if (req.method !== "POST") throw new HttpError(405, "use POST");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 1_000_000)
        throw new HttpError(413, "message too large");
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(400, "expected an object");
    const location = {
      conversationId: "terminal",
      direct: true,
      senderId: this.userId,
    };
    let result = "";
    let view: ListView | undefined;
    switch (req.url) {
      case "/terminal/message":
        if (typeof body.text !== "string" || !body.text.trim())
          throw new HttpError(400, "text is required");
        await this.#handlers.onMessage({
          ...location,
          messageId: randomUUID(),
          text: body.text,
        });
        break;
      case "/terminal/approval": {
        if (
          typeof body.approvalId !== "string" ||
          !APPROVAL_DECISIONS.includes(body.decision as ApprovalDecision) ||
          (body.text !== undefined && typeof body.text !== "string")
        )
          throw new HttpError(400, "invalid approval decision");
        result = await this.#handlers.onApprovalAction({
          senderId: this.userId,
          approvalId: body.approvalId,
          decision: body.decision as ApprovalDecision,
          text: body.text as string | undefined,
        });
        if (body.decision === "rule") break;
        for (const frames of this.#turns.values()) {
          for (let i = frames.length - 1; i >= 0; i--) {
            const { event } = frames[i];
            if (
              event.type === "approval" &&
              event.approval.id === body.approvalId
            )
              frames.splice(i, 1);
          }
        }
        break;
      }
      case "/terminal/command":
        if (
          typeof body.name !== "string" ||
          (body.args !== undefined && typeof body.args !== "string")
        )
          throw new HttpError(400, "invalid command");
        await this.#handlers.onCommand({
          ...location,
          name: body.name,
          args: String(body.args ?? ""),
          respond: async (text, list) => {
            result = text;
            view = list;
          },
        });
        break;
      default:
        throw new HttpError(404, "no terminal route");
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ message: result, view }));
  }
}
