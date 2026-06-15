import type { Adapter } from "./types.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { openaiAdapter } from "./openai.ts";

/** Registry of parser adapters, keyed by the `adapter` field in provider config. */
export const ADAPTERS: Record<string, Adapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
};

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS[id];
}
