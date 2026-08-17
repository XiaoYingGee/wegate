import type { ILinkClient } from "./client/ilink.js";
import { isContextUnavailableError } from "./client/ilink.js";
import type { SessionStore } from "./store/session.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[wegate] ${msg}`, ...args);
const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

export interface OutboxFlushResult {
  attempted: number;
  delivered: number;
  remaining: number;
  error?: string;
}

/**
 * Retry queued messages only after a new inbound message has refreshed the
 * peer's reply window. Each queued item gets at most one attempt per inbound
 * token generation, preventing a tight retry loop against an unusable token.
 */
export async function flushPendingOutbox(
  client: ILinkClient,
  store: SessionStore,
  peerId: string,
): Promise<OutboxFlushResult> {
  const readiness = store.getPeerOutboundStatus(peerId);
  const pending = store.listPendingOutbox(peerId);
  if (!readiness.ready || !readiness.contextToken || pending.length === 0) {
    return { attempted: 0, delivered: 0, remaining: pending.length };
  }

  let attempted = 0;
  let delivered = 0;

  for (const entry of pending) {
    if (entry.last_attempt_generation === readiness.tokenGeneration) continue;

    attempted += 1;
    store.markOutboxAttempt(entry.id, readiness.tokenGeneration);
    // Persist the attempt before I/O. If the process crashes during delivery,
    // the item stays queued and is retried only after the next inbound refresh.
    await store.save();

    try {
      await client.sendText(peerId, entry.text, readiness.contextToken);
      store.removeOutbox(entry.id);
      await store.save();
      delivered += 1;
      log(`outbox 补发成功 → [${peerId}] queue_id=${entry.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markOutboxFailure(entry.id, message);
      if (isContextUnavailableError(err)) {
        // A newer inbound may have refreshed the peer while this request was
        // in flight. Never let an old response invalidate that new context.
        store.markPeerContextRejected(peerId, message, readiness.tokenGeneration);
      }
      await store.save();
      logError(`outbox 补发失败 → [${peerId}] queue_id=${entry.id} — ${message}`);
      return {
        attempted,
        delivered,
        remaining: store.listPendingOutbox(peerId).length,
        error: message,
      };
    }
  }

  return {
    attempted,
    delivered,
    remaining: store.listPendingOutbox(peerId).length,
  };
}
