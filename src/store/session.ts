import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_OUTBOX_MESSAGES = 1_000;
export const MAX_OUTBOX_BYTES = 5 * 1024 * 1024;
export const MAX_OUTBOX_ERROR_BYTES = 2 * 1024;

export class OutboxCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxCapacityError";
  }
}

export interface PeerInfo {
  context_token: string;
  last_seen_at?: string;
  context_token_updated_at?: string;
  context_token_generation?: number;
  context_token_refresh_generation?: number;
}

export interface PendingOutboxMessage {
  id: string;
  peer_id: string;
  text: string;
  client_id?: string;
  queued_at?: string;
  attempts: number;
  last_attempt_at?: string;
  last_attempt_generation?: number;
  last_error?: string;
}

export interface InitialOutboxAttempt {
  generation: number;
  error: string;
  clientId: string;
}

export type OutboundUnavailableReason = "no_known_peer";

export interface PeerOutboundStatus {
  ready: boolean;
  reason?: OutboundUnavailableReason;
  contextToken?: string;
  contextTokenAvailable: boolean;
  tokenUpdatedAt?: string;
  tokenGeneration: number;
  tokenRefreshGeneration: number;
}

export interface SessionData {
  bot_token: string;
  bot_id: string;
  user_id: string;
  base_url: string;
  get_updates_buf: string;
  current_peer?: string;
  peers: Record<string, PeerInfo>;
  pending_outbox: PendingOutboxMessage[];
  saved_at: string;
}

const EMPTY_SESSION: SessionData = {
  bot_token: "",
  bot_id: "",
  user_id: "",
  base_url: "",
  get_updates_buf: "",
  peers: {},
  pending_outbox: [],
  saved_at: "",
};

export class SessionStore {
  private path: string;
  private data: SessionData;

  constructor(path: string) {
    this.path = path;
    this.data = { ...EMPTY_SESSION, peers: {}, pending_outbox: [] };
  }

  get session(): SessionData {
    return this.data;
  }

  get isLoggedIn(): boolean {
    return !!this.data.bot_token;
  }

  async load(): Promise<boolean> {
    try {
      const raw = await readFile(this.path, "utf-8");
      this.data = { ...EMPTY_SESSION, ...JSON.parse(raw) };
      if (!this.data.peers) this.data.peers = {};
      if (!Array.isArray(this.data.pending_outbox)) this.data.pending_outbox = [];
      for (const entry of this.data.pending_outbox) {
        if (entry.last_error) {
          entry.last_error = sanitizeOutboxError(entry.last_error);
        }
      }
      return this.isLoggedIn;
    } catch {
      return false;
    }
  }

  private saving: Promise<void> | null = null;

  async save(): Promise<void> {
    while (this.saving) await this.saving;
    this.saving = this.doSave();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  private async doSave(): Promise<void> {
    this.compactPendingOutboxToCapacity();
    this.data.saved_at = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.path);
  }

  setLogin(botToken: string, botId: string, userId: string, baseUrl: string) {
    this.data.bot_token = botToken;
    this.data.bot_id = botId;
    this.data.user_id = userId;
    this.data.base_url = baseUrl;
  }

  setUpdatesBuf(buf: string) {
    this.data.get_updates_buf = buf;
  }

  upsertPeer(peerId: string, contextToken?: string): number {
    const existing = this.data.peers[peerId] || { context_token: "" };
    const now = new Date().toISOString();
    const generation = (existing.context_token_generation || 0) + 1;
    existing.context_token_generation = generation;
    if (contextToken) {
      existing.context_token = contextToken;
      existing.context_token_updated_at = now;
      existing.context_token_refresh_generation = generation;
    }
    // This persisted field predates tokenless sends, but its retry-gate
    // semantics are the inbound-message generation: every observed inbound
    // advances it, whether or not iLink supplied a context token.
    existing.last_seen_at = now;
    this.data.peers[peerId] = existing;
    if (!this.data.current_peer) this.data.current_peer = peerId;
    return generation;
  }

  getPeerToken(peerId: string): string | undefined {
    return this.data.peers[peerId]?.context_token || undefined;
  }

  hasPeer(peerId: string): boolean {
    return Object.hasOwn(this.data.peers, peerId);
  }

  getPeerOutboundStatus(peerId: string): PeerOutboundStatus {
    const peer = this.data.peers[peerId];
    const generation = peer?.context_token_generation || 0;
    if (!peer) {
      return {
        ready: false,
        reason: "no_known_peer",
        contextTokenAvailable: false,
        tokenGeneration: generation,
        tokenRefreshGeneration: 0,
      };
    }

    const contextToken = peer.context_token || undefined;
    const tokenUpdatedAt = contextToken
      ? peer.context_token_updated_at || peer.last_seen_at
      : undefined;

    return {
      ready: true,
      contextToken,
      contextTokenAvailable: !!contextToken,
      ...(tokenUpdatedAt ? { tokenUpdatedAt } : {}),
      tokenGeneration: generation,
      tokenRefreshGeneration: peer.context_token_refresh_generation || 0,
    };
  }

  enqueueOutbox(
    peerId: string,
    text: string,
    initialAttempt?: InitialOutboxAttempt,
  ): PendingOutboxMessage {
    if (this.data.pending_outbox.length >= MAX_OUTBOX_MESSAGES) {
      throw new OutboxCapacityError(
        `pending outbox limit reached (${MAX_OUTBOX_MESSAGES} messages)`,
      );
    }
    const now = new Date().toISOString();
    const safeError = initialAttempt
      ? sanitizeOutboxError(initialAttempt.error)
      : undefined;
    const id = randomUUID();
    const entry: PendingOutboxMessage = {
      id,
      peer_id: peerId,
      text,
      client_id: initialAttempt?.clientId || `wegate-${id}`,
      queued_at: now,
      attempts: initialAttempt ? 1 : 0,
      ...(initialAttempt
        ? {
            last_attempt_at: now,
            last_attempt_generation: initialAttempt.generation,
            last_error: safeError,
          }
        : {}),
    };
    const candidateBytes = pendingOutboxBytes([
      ...this.data.pending_outbox,
      entry,
    ].map(projectOutboxCapacity));
    if (candidateBytes > MAX_OUTBOX_BYTES) {
      throw new OutboxCapacityError(
        `pending outbox size limit reached (${MAX_OUTBOX_BYTES} bytes)`,
      );
    }
    this.data.pending_outbox.push(entry);
    return entry;
  }

  listPendingOutbox(peerId?: string): PendingOutboxMessage[] {
    return this.data.pending_outbox.filter((entry) => !peerId || entry.peer_id === peerId);
  }

  markOutboxAttempt(id: string, generation: number, error?: string) {
    const entry = this.data.pending_outbox.find((item) => item.id === id);
    if (!entry) return;
    entry.attempts += 1;
    entry.last_attempt_at = new Date().toISOString();
    entry.last_attempt_generation = generation;
    entry.last_error = error === undefined
      ? undefined
      : sanitizeOutboxError(error);
    this.compactPendingOutboxToCapacity();
  }

  ensureOutboxClientID(id: string): string {
    const entry = this.data.pending_outbox.find((item) => item.id === id);
    if (!entry) throw new Error(`pending outbox entry not found: ${id}`);
    if (!entry.client_id) entry.client_id = `wegate-${entry.id}`;
    this.compactPendingOutboxToCapacity();
    return entry.client_id;
  }

  markOutboxFailure(id: string, error: string) {
    const entry = this.data.pending_outbox.find((item) => item.id === id);
    if (entry) {
      entry.last_error = sanitizeOutboxError(error);
      this.compactPendingOutboxToCapacity();
    }
  }

  removeOutbox(id: string) {
    this.data.pending_outbox = this.data.pending_outbox.filter((entry) => entry.id !== id);
  }

  get currentPeer(): string | undefined {
    return this.data.current_peer;
  }

  set currentPeer(peerId: string | undefined) {
    this.data.current_peer = peerId;
  }

  listPeers(): string[] {
    return Object.entries(this.data.peers)
      .sort(([, a], [, b]) => (b.last_seen_at || "").localeCompare(a.last_seen_at || ""))
      .map(([id]) => id);
  }

  private compactPendingOutboxToCapacity(): void {
    if (pendingOutboxBytes(this.data.pending_outbox) <= MAX_OUTBOX_BYTES) return;

    for (const field of ["last_error", "last_attempt_at", "queued_at"] as const) {
      for (let index = this.data.pending_outbox.length - 1; index >= 0; index -= 1) {
        delete this.data.pending_outbox[index]?.[field];
        if (pendingOutboxBytes(this.data.pending_outbox) <= MAX_OUTBOX_BYTES) {
          return;
        }
      }
    }

    throw new OutboxCapacityError(
      `pending outbox size limit reached (${MAX_OUTBOX_BYTES} bytes)`,
    );
  }
}

function pendingOutboxBytes(entries: PendingOutboxMessage[]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

function projectOutboxCapacity(
  entry: PendingOutboxMessage,
): PendingOutboxMessage {
  return {
    ...entry,
    last_attempt_at: entry.last_attempt_at || entry.queued_at || "9999-12-31T23:59:59.999Z",
    last_attempt_generation:
      entry.last_attempt_generation ?? Number.MAX_SAFE_INTEGER,
    last_error: entry.last_error || "x".repeat(MAX_OUTBOX_ERROR_BYTES),
  };
}

export function sanitizeOutboxError(error: string): string {
  const source = truncateUtf8(String(error), MAX_OUTBOX_ERROR_BYTES * 4);
  const redacted = source
    .replace(
      /((?:authorization|api[_-]?key|context_token|bot_token|token|password|secret)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^"'\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{4,}/gi, "Bearer [REDACTED]");
  return truncateUtf8(redacted, MAX_OUTBOX_ERROR_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}
