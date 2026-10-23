import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  Blocked,
  execution,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
  Terminated,
} from "rebuno";

import { AUTH_PATH, MODELS_PATH } from "../config.js";
import { deltaLine } from "../gateway/events.js";
import { readSettings } from "../settings.js";

const REFUSALS = [
  Blocked,
  Terminated,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
];
// Set per run, so a resumed turn would otherwise submit different step args.
const UNRECORDED_FIELDS = new Set([
  "timestamp",
  "durationMs",
  "usage",
  "cost",
  "diagnostics",
  "details",
]);
const DELTA_FLUSH_MS = 50;
const DELTA_MAX_CHARS = 1750;

export const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

const failedMessage = (
  model: Model<Api>,
  error: unknown,
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: error instanceof Error ? error.message : String(error),
  timestamp: Date.now(),
});

export async function createModels() {
  const runtime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
  });
  const available = () => runtime.getAvailable();
  const find = async (key: string | undefined) =>
    (await available()).find((model) => modelKey(model) === key);
  const current = () => {
    const { defaultProvider, defaultModel } = readSettings();
    return find(
      defaultProvider && defaultModel
        ? `${defaultProvider}/${defaultModel}`
        : undefined,
    );
  };
  const streamFn =
    (onRefusal: (error: unknown) => void): StreamFn =>
    (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const finish = (message: AssistantMessage) => {
        stream.push(
          message.stopReason === "error" || message.stopReason === "aborted"
            ? { type: "error", reason: message.stopReason, error: message }
            : {
                type: "done",
                reason: message.stopReason as "stop",
                message,
              },
        );
        stream.end();
      };
      void (async () => {
        try {
          const ctx = execution();
          const { stepId, dec } = await ctx.beginLlm(model.id, {
            model: modelKey(model),
            messages: context.messages.map((message) =>
              Object.fromEntries(
                Object.entries(message).filter(
                  ([key]) => !UNRECORDED_FIELDS.has(key),
                ),
              ),
            ),
          });
          if (dec.decision === "replay")
            return finish(
              (dec.result as { message: AssistantMessage }).message,
            );
          const live = runtime.streamSimple(model, context, {
            ...options,
            maxRetries: 2,
          });
          let pending = "";
          let seq = 0;
          let flushed = Date.now();
          const flush = async () => {
            for (let i = 0; i < pending.length; i += DELTA_MAX_CHARS)
              await ctx.publishLlmDelta(
                stepId,
                seq++,
                pending.slice(i, i + DELTA_MAX_CHARS),
              );
            pending = "";
            flushed = Date.now();
          };
          for await (const event of live) {
            if (event.type === "done" || event.type === "error") continue;
            if (
              event.type === "text_delta" ||
              event.type === "thinking_delta"
            ) {
              pending += deltaLine(
                event.type === "text_delta" ? "text" : "thinking",
                event.delta,
              );
              if (Date.now() - flushed >= DELTA_FLUSH_MS) await flush();
            }
            stream.push(event);
          }
          await flush();
          const message = await live.result();
          if (
            message.stopReason === "error" ||
            message.stopReason === "aborted"
          )
            await ctx.failStepQuietly(
              stepId,
              message.errorMessage ?? message.stopReason,
            );
          else
            await ctx.recordLlm(stepId, {
              message,
              usage: {
                input_tokens: message.usage.input,
                output_tokens: message.usage.output,
              },
            });
          finish(message);
        } catch (error) {
          if (REFUSALS.some((refusal) => error instanceof refusal))
            onRefusal(error);
          finish(failedMessage(model, error));
        }
      })();
      return stream;
    };
  // For model calls inside one step, such as a browser task's, which are not
  // recorded on their own.
  const streamUnrecorded: StreamFn = (model, context, options) =>
    runtime.streamSimple(model, context, { ...options, maxRetries: 2 });
  return { runtime, current, find, available, streamFn, streamUnrecorded };
}
