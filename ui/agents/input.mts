import { createHash } from "node:crypto";
import { LIMITS, type DraftImage } from "../shared/api.ts";
import { normalizeDraftImages } from "../server/validate.mts";

export class AgentError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  readonly retryable: boolean;
  constructor(code: string, message: string, uncertain = false, retryable = false) {
    super(message); this.name = "AgentError"; this.code = code; this.uncertain = uncertain; this.retryable = retryable;
  }
}
export interface SubmitInput {
  operationId: string; message: string; mode: "steer" | "followUp"; targetKey: string; images: DraftImage[];
}
export type NativeInputPart = {type: "text"; text: string} | {type: "image"; data: string; mimeType: "image/png" | "image/jpeg"};
export type NativeInputMessage = string | NativeInputPart[];
export interface NativeSubmitInput { operationId: string; message: NativeInputMessage; mode: "steer" | "followUp" }

function plain(value: unknown, keys: readonly string[]): void {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable))
    throw new AgentError("invalid_request", "Invalid agent input fields.");
}
export function validateSubmitInput(input: SubmitInput): void {
  plain(input, ["operationId", "message", "mode", "targetKey", "images"]);
  if (typeof input.operationId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.operationId)
    || typeof input.targetKey !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.targetKey)
    || typeof input.message !== "string" || Buffer.byteLength(input.message) > LIMITS.textBytes
    || !["steer", "followUp"].includes(input.mode) || !Array.isArray(input.images)
    || input.images.length > LIMITS.imagesPerDraft || Object.keys(input.images).length !== input.images.length)
    throw new AgentError("invalid_request", "Invalid agent input.");
  for (const image of input.images) plain(image, ["digest", "mimeType", "bytes", "width", "height", "name"]);
  try { normalizeDraftImages(input.images); }
  catch { throw new AgentError("invalid_request", "Invalid agent image metadata."); }
  if (!input.message.trim() && !input.images.length) throw new AgentError("invalid_request", "Agent input is empty.");
}
export function captureSubmitInput(input: SubmitInput): SubmitInput {
  validateSubmitInput(input);
  return {operationId: input.operationId, message: input.message, mode: input.mode, targetKey: input.targetKey,
    images: normalizeDraftImages(input.images)};
}
export function submitInputDigest(identity: string, input: SubmitInput): string {
  return createHash("sha256").update(JSON.stringify({identity, ...input})).digest("hex");
}
/** Hash native content without retaining an encoded image copy in receipt caches. */
export function nativeInputDigest(identity: string, input: NativeSubmitInput, installationId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([identity, input.operationId, input.mode, installationId]));
  if (typeof input.message === "string") hash.update(JSON.stringify(input.message));
  else for (const part of input.message) {
    if (part.type === "text") hash.update(JSON.stringify([part.type, part.text]));
    else hash.update(JSON.stringify([part.type, part.mimeType, part.data.length])).update(part.data);
  }
  return hash.digest("hex");
}
