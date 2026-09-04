import type { ILinkClient } from "./client/ilink.js";
import {
  sanitizeOutboxError,
  type SessionStore,
} from "./store/session.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[wegate] ${msg}`, ...args);
const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

const pendingFlushes = new WeakMap<SessionStore, Map<string, Promise<void>>>();

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
 * Recover persisted messages in FIFO order. A normal inbound-triggered flush
 * attempts an item at most once per token generation. Startup migration only
 * forces entries from older releases that have no recorded attempt generation;
 * new fallback failures must wait for a later inbound token refresh.
 */
export async function flushPendingOutbox(
  client: ILinkClient,
  store: SessionStore,
  peerId: string,
  options: OutboxFlushOptions,
): Promise<OutboxFlushResult> {
  let peerFlushes = pendingFlushes.get(store);
  if (!peerFlushes) {
    peerFlushes = new Map();
    pendingFlushes.set(store, peerFlushes);
  }

  const previous = peerFlushes.get(peerId) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() => flushPendingOutboxUnlocked(client, store, peerId, options));
  const tail = task.then(() => undefined, () => undefined);
  peerFlushes.set(peerId, tail);

  try {
    return await task;
  } finally {
    if (peerFlushes.get(peerId) === tail) peerFlushes.delete(peerId);
  }
}

async function flushPendingOutboxUnlocked(
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
      options.mode === "startup" &&
      entry.last_attempt_generation !== undefined
    ) {
      break;
    }
    if (
      options.mode === "inbound" &&
      entry.last_attempt_generation === attemptGeneration
    ) {
      break;
    }

    attempted += 1;
    const clientID = store.ensureOutboxClientID(entry.id);
    store.markOutboxAttempt(entry.id, attemptGeneration);
    // Persist the stable id and attempt before I/O. If delivery succeeds but
    // the process crashes before removal, replay keeps the same client_id.
    await store.save();

    try {
      await client.sendText(
        peerId,
        entry.text,
        currentStatus.contextToken,
        clientID,
      );
      store.removeOutbox(entry.id);
      await store.save();
      delivered += 1;
      log(`outbox 补发成功 → [${peerId}] queue_id=${entry.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safeMessage = sanitizeOutboxError(message);
      store.markOutboxFailure(entry.id, safeMessage);
      await store.save();
      logError(`outbox 补发失败 → [${peerId}] queue_id=${entry.id} — ${safeMessage}`);
      return {
        attempted,
        delivered,
        remaining: store.listPendingOutbox(peerId).length,
        error: safeMessage,
      };
    }
  }

  return {
    attempted,
    delivered,
    remaining: store.listPendingOutbox(peerId).length,
  };
}
