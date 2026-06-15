import { getAdapter } from "./adapters/index.ts";
import type { Store } from "./db.ts";
import type { StoredMessage } from "./model.ts";
import { assignThread } from "./threading.ts";

/** providerId -> adapterId, built from config. */
export type AdapterMap = Map<string, string>;

/**
 * Normalize one exchange into the derived layer. Best-effort: parser failures
 * are logged and skipped, never propagated — raw capture stays intact.
 */
export function normalizeExchange(store: Store, adapters: AdapterMap, exchangeId: number): boolean {
  try {
    const raw = store.rawForNormalize(exchangeId);
    if (!raw) return false;

    const adapterId = adapters.get(raw.providerId);
    const adapter = adapterId ? getAdapter(adapterId) : undefined;
    if (!adapter) return false; // unknown provider/adapter -> leave raw only

    const msgs: StoredMessage[] = [];
    adapter.parseRequest(raw.reqBody).forEach((m, seq) =>
      msgs.push({ ...m, exchangeId, source: "request", seq }),
    );
    adapter.parseResponse(raw.respBody, raw.isStreaming).forEach((m, seq) =>
      msgs.push({ ...m, exchangeId, source: "response", seq }),
    );

    store.writeExchangeMessages(exchangeId, msgs);
    assignThread(store, exchangeId);
    return true;
  } catch (err) {
    console.warn(`luwak: normalize failed for exchange ${exchangeId}: ${String(err)}`);
    return false;
  }
}

/** Rebuild the entire derived layer from sacred raw (the `reparse` command). */
export function reparseAll(store: Store, adapters: AdapterMap): { total: number; ok: number } {
  store.clearAllNormalized();
  const ids = store.allExchangeIds();
  let ok = 0;
  for (const id of ids) if (normalizeExchange(store, adapters, id)) ok++;
  return { total: ids.length, ok };
}
