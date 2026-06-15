import type { NormMessage } from "../model.ts";

/**
 * Maps one provider's raw wire bytes into the canonical conversation model.
 * Adapters are pure: (text in) -> (messages out), no I/O, no storage knowledge.
 */
export interface Adapter {
  id: string;
  /** Parse a request body into the conversation history sent to the model. */
  parseRequest(body: string): NormMessage[];
  /** Parse a response body (SSE text or JSON) into the model's reply message(s). */
  parseResponse(body: string, isStreaming: boolean): NormMessage[];
}
