import type { ILinkClient } from "./client/ilink.js";
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

export type OutboxFlushOptions =
  | {
      mode: "inbound";
      /** Generation captured from the inbound message that triggered this flush. */
      attemptGeneration: number;
    }
  | {
      /** One forced attempt for outbox entries persisted by older releases. */
      mode: "startup";
    };

/**
 * Recover messages persisted by older Wegate versions. New API sends are never
 * queued before contacting iLink. A normal inbound-triggered flush attempts an
 * item at most once per inbound generation; startup migration can force one
 * attempt so legacy messages no longer depend on another inbound message.
 */
export async function flushPendingOutbox(
  client: ILinkClient,
  store: SessionStore,
  peerId: string,
  options: OutboxFlushOptions,
): Promise<OutboxFlushResult> {
  const currentStatus = store.getPeerOutboundStatus(peerId);
  const attemptGeneration =
    options.mode === "inbound"
      ? options.attemptGeneration
      : currentStatus.tokenGeneration;
  const pending = store.listPendingOutbox(peerId);
  if (pending.length === 0) {
    return { attempted: 0, delivered: 0, remaining: pending.length };
  }

  let attempted = 0;
  let delivered = 0;

  for (const entry of pending) {
    if (
      options.mode === "inbound" &&
      entry.last_attempt_generation === attemptGeneration
    ) {
      break;
    }

    attempted += 1;
    store.markOutboxAttempt(entry.id, attemptGeneration);
    // Persist the attempt before I/O. If the process crashes during delivery,
    // the item stays queued and is retried only after the next inbound refresh.
    await store.save();

    try {
      await client.sendText(peerId, entry.text, currentStatus.contextToken);
      store.removeOutbox(entry.id);
      await store.save();
      delivered += 1;
      log(`outbox 补发成功 → [${peerId}] queue_id=${entry.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markOutboxFailure(entry.id, message);
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
