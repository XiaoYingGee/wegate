import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_OUTBOX_MESSAGES = 1_000;
export const MAX_OUTBOX_BYTES = 5 * 1024 * 1024;

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
  context_token_rejected_at?: string;
  context_token_last_error?: string;
}

export interface PendingOutboxMessage {
  id: string;
  peer_id: string;
  text: string;
  queued_at: string;
  attempts: number;
  last_attempt_at?: string;
  last_attempt_generation?: number;
  last_error?: string;
}

export type OutboundUnavailableReason =
  | "no_context_token"
  | "stale_context"
  | "context_rejected";

export interface PeerOutboundStatus {
  ready: boolean;
  reason?: OutboundUnavailableReason;
  contextToken?: string;
  tokenUpdatedAt?: string;
  expiresAt?: string;
  tokenGeneration: number;
  lastError?: string;
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

  upsertPeer(peerId: string, contextToken?: string) {
    const existing = this.data.peers[peerId] || { context_token: "" };
    const now = new Date().toISOString();
    if (contextToken) {
      existing.context_token = contextToken;
      existing.context_token_updated_at = now;
      // A new inbound message refreshes WeChat's reply window even if the
      // opaque token string happens to be unchanged.
      existing.context_token_generation = (existing.context_token_generation || 0) + 1;
      delete existing.context_token_rejected_at;
      delete existing.context_token_last_error;
    }
    existing.last_seen_at = now;
    this.data.peers[peerId] = existing;
    if (!this.data.current_peer) this.data.current_peer = peerId;
  }

  getPeerToken(peerId: string): string | undefined {
    return this.data.peers[peerId]?.context_token || undefined;
  }

  hasPeer(peerId: string): boolean {
    return Object.hasOwn(this.data.peers, peerId);
  }

  getPeerOutboundStatus(peerId: string, now = Date.now()): PeerOutboundStatus {
    const peer = this.data.peers[peerId];
    const generation = peer?.context_token_generation || 0;
    if (!peer?.context_token) {
      return { ready: false, reason: "no_context_token", tokenGeneration: generation };
    }

    const tokenUpdatedAt = peer.context_token_updated_at || peer.last_seen_at;
    const updatedAtMs = tokenUpdatedAt ? Date.parse(tokenUpdatedAt) : Number.NaN;
    const expiresAt = Number.isFinite(updatedAtMs)
      ? new Date(updatedAtMs + CONTEXT_TOKEN_TTL_MS).toISOString()
      : undefined;

    if (peer.context_token_rejected_at) {
      return {
        ready: false,
        reason: "context_rejected",
        contextToken: peer.context_token,
        tokenUpdatedAt,
        expiresAt,
        tokenGeneration: generation,
        lastError: peer.context_token_last_error,
      };
    }

    if (!Number.isFinite(updatedAtMs) || now >= updatedAtMs + CONTEXT_TOKEN_TTL_MS) {
      return {
        ready: false,
        reason: "stale_context",
        contextToken: peer.context_token,
        tokenUpdatedAt,
        expiresAt,
        tokenGeneration: generation,
      };
    }

    return {
      ready: true,
      contextToken: peer.context_token,
      tokenUpdatedAt,
      expiresAt,
      tokenGeneration: generation,
    };
  }

  markPeerContextRejected(peerId: string, error: string, expectedGeneration?: number): boolean {
    const peer = this.data.peers[peerId];
    if (!peer) return false;
    const currentGeneration = peer.context_token_generation || 0;
    if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) {
      return false;
    }
    peer.context_token_rejected_at = new Date().toISOString();
    peer.context_token_last_error = error;
    return true;
  }

  enqueueOutbox(peerId: string, text: string): PendingOutboxMessage {
    if (this.data.pending_outbox.length >= MAX_OUTBOX_MESSAGES) {
      throw new OutboxCapacityError(
        `pending outbox limit reached (${MAX_OUTBOX_MESSAGES} messages)`,
      );
    }
    const currentBytes = this.data.pending_outbox.reduce(
      (total, item) => total + Buffer.byteLength(item.text, "utf8"),
      0,
    );
    if (currentBytes + Buffer.byteLength(text, "utf8") > MAX_OUTBOX_BYTES) {
      throw new OutboxCapacityError(
        `pending outbox size limit reached (${MAX_OUTBOX_BYTES} bytes)`,
      );
    }
    const entry: PendingOutboxMessage = {
      id: randomUUID(),
      peer_id: peerId,
      text,
      queued_at: new Date().toISOString(),
      attempts: 0,
    };
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
    entry.last_error = error;
  }

  markOutboxFailure(id: string, error: string) {
    const entry = this.data.pending_outbox.find((item) => item.id === id);
    if (entry) entry.last_error = error;
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
}
