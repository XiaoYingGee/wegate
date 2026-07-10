import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PeerInfo {
  context_token: string;
  last_seen_at?: string;
}

export interface SessionData {
  bot_token: string;
  bot_id: string;
  user_id: string;
  base_url: string;
  get_updates_buf: string;
  current_peer?: string;
  peers: Record<string, PeerInfo>;
  saved_at: string;
}

const EMPTY_SESSION: SessionData = {
  bot_token: "",
  bot_id: "",
  user_id: "",
  base_url: "",
  get_updates_buf: "",
  peers: {},
  saved_at: "",
};

export class SessionStore {
  private path: string;
  private data: SessionData;

  constructor(path: string) {
    this.path = path;
    this.data = { ...EMPTY_SESSION, peers: {} };
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
      return this.isLoggedIn;
    } catch {
      return false;
    }
  }

  async save(): Promise<void> {
    this.data.saved_at = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
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
    if (contextToken) existing.context_token = contextToken;
    existing.last_seen_at = new Date().toISOString();
    this.data.peers[peerId] = existing;
    if (!this.data.current_peer) this.data.current_peer = peerId;
  }

  getPeerToken(peerId: string): string | undefined {
    return this.data.peers[peerId]?.context_token || undefined;
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
