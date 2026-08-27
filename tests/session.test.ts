import { describe, it, expect } from "vitest";
import {
  MAX_OUTBOX_BYTES,
  MAX_OUTBOX_MESSAGES,
  OutboxCapacityError,
  SessionStore,
} from "../src/store/session.js";
import { resolve } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

async function withTempStore(
  fn: (store: SessionStore, path: string) => Promise<void>,
) {
  const dir = await mkdtemp(resolve(tmpdir(), "wegate-test-"));
  const path = resolve(dir, "session.json");
  try {
    await fn(new SessionStore(path), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("SessionStore", () => {
  it("starts empty and not logged in", async () => {
    await withTempStore(async (store) => {
      const loaded = await store.load();
      expect(loaded).toBe(false);
      expect(store.isLoggedIn).toBe(false);
    });
  });

  it("saves and loads login data", async () => {
    await withTempStore(async (store, path) => {
      store.setLogin("token123", "bot1", "user1", "https://example.com");
      await store.save();

      const store2 = new SessionStore(path);
      const loaded = await store2.load();
      expect(loaded).toBe(true);
      expect(store2.session.bot_token).toBe("token123");
      expect(store2.session.bot_id).toBe("bot1");
      expect(store2.session.base_url).toBe("https://example.com");
    });
  });

  it("persists peers and context tokens", async () => {
    await withTempStore(async (store, path) => {
      store.setLogin("tok", "bot", "user", "https://example.com");
      store.upsertPeer("peer1", "ctx_token_1");
      store.upsertPeer("peer2", "ctx_token_2");
      await store.save();

      const store2 = new SessionStore(path);
      await store2.load();
      expect(store2.getPeerToken("peer1")).toBe("ctx_token_1");
      expect(store2.getPeerToken("peer2")).toBe("ctx_token_2");
    });
  });

  it("sets first peer as current automatically", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "tok1");
      expect(store.currentPeer).toBe("peer1");
    });
  });

  it("updates existing peer token", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "old_token");
      store.upsertPeer("peer1", "new_token");
      expect(store.getPeerToken("peer1")).toBe("new_token");
    });
  });

  it("advances the inbound generation without clearing a stored token", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "stored-token");
      const before = store.getPeerOutboundStatus("peer1");

      store.upsertPeer("peer1");

      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        contextToken: "stored-token",
        contextTokenAvailable: true,
        tokenUpdatedAt: before.tokenUpdatedAt,
        tokenGeneration: before.tokenGeneration + 1,
      });
    });
  });

  it("returns undefined for unknown peer", async () => {
    await withTempStore(async (store) => {
      expect(store.getPeerToken("unknown")).toBeUndefined();
    });
  });

  it("lists peers sorted by last seen", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("old", "tok1");
      await new Promise((r) => setTimeout(r, 10));
      store.upsertPeer("new", "tok2");
      const list = store.listPeers();
      expect(list[0]).toBe("new");
      expect(list[1]).toBe("old");
    });
  });

  it("updates_buf persists across saves", async () => {
    await withTempStore(async (store, path) => {
      store.setLogin("tok", "bot", "user", "https://example.com");
      store.setUpdatesBuf("cursor_abc");
      await store.save();

      const store2 = new SessionStore(path);
      await store2.load();
      expect(store2.session.get_updates_buf).toBe("cursor_abc");
    });
  });

  it("keeps persisted context tokens ready regardless of age", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "ctx");
      store.session.peers.peer1.context_token_updated_at = "2020-01-01T00:00:00.000Z";

      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: true,
        contextToken: "ctx",
        contextTokenAvailable: true,
        tokenUpdatedAt: "2020-01-01T00:00:00.000Z",
      });
    });
  });

  it("loads and re-saves a legacy session file without reviving rejection heuristics", async () => {
    await withTempStore(async (store, path) => {
      await writeFile(
        path,
        JSON.stringify({
          bot_token: "legacy-token",
          bot_id: "legacy-bot",
          user_id: "legacy-user",
          base_url: "https://example.com",
          get_updates_buf: "legacy-cursor",
          current_peer: "peer1",
          peers: {
            peer1: {
              context_token: "ctx",
              last_seen_at: "2026-08-20T00:00:00.000Z",
              context_token_updated_at: "2026-08-20T00:00:00.000Z",
              context_token_generation: 4,
              context_token_rejected_at: "2026-08-20T00:01:00.000Z",
              context_token_last_error: "ret=-2 prepare failed",
            },
          },
          saved_at: "2026-08-20T00:02:00.000Z",
        }),
      );

      expect(await store.load()).toBe(true);
      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: true,
        contextToken: "ctx",
        tokenGeneration: 4,
      });
      expect(store.listPendingOutbox()).toEqual([]);

      await store.save();
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        pending_outbox?: unknown[];
        peers: Record<string, Record<string, unknown>>;
      };
      expect(saved.pending_outbox).toEqual([]);
      expect(saved.peers.peer1).toMatchObject({
        context_token: "ctx",
        context_token_rejected_at: "2026-08-20T00:01:00.000Z",
        context_token_last_error: "ret=-2 prepare failed",
      });

      const reloaded = new SessionStore(path);
      expect(await reloaded.load()).toBe(true);
      expect(reloaded.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: true,
        contextToken: "ctx",
        tokenGeneration: 4,
      });
    });
  });

  it("keeps a known peer outbound-ready even without a context token", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1");
      const status = store.getPeerOutboundStatus("peer1");
      expect(status).toMatchObject({
        ready: true,
        contextTokenAvailable: false,
      });
      expect(status).not.toHaveProperty("tokenUpdatedAt");
    });
  });

  it("reports an unknown peer as unavailable", async () => {
    await withTempStore(async (store) => {
      expect(store.getPeerOutboundStatus("unknown")).toMatchObject({
        ready: false,
        reason: "no_known_peer",
        contextTokenAvailable: false,
      });
    });
  });

  it("persists pending outbox messages", async () => {
    await withTempStore(async (store, path) => {
      store.setLogin("tok", "bot", "user", "https://example.com");
      const entry = store.enqueueOutbox("peer1", "queued reminder");
      await store.save();

      const reloaded = new SessionStore(path);
      await reloaded.load();
      expect(reloaded.listPendingOutbox()).toEqual([
        expect.objectContaining({
          id: entry.id,
          peer_id: "peer1",
          text: "queued reminder",
          attempts: 0,
        }),
      ]);
    });
  });

  it("caps the durable outbox instead of growing the session file forever", async () => {
    await withTempStore(async (store) => {
      for (let i = 0; i < MAX_OUTBOX_MESSAGES; i += 1) {
        store.enqueueOutbox("peer1", `message-${i}`);
      }
      expect(() => store.enqueueOutbox("peer1", "one too many")).toThrow(
        OutboxCapacityError,
      );
    });
  });

  it("accepts exactly 5 MiB of UTF-8 message text and rejects one byte more", async () => {
    await withTempStore(async (store) => {
      const threeByteChars = Math.floor(MAX_OUTBOX_BYTES / 3);
      const remainder = MAX_OUTBOX_BYTES % 3;
      const exactLimit = "你".repeat(threeByteChars) + "a".repeat(remainder);
      expect(Buffer.byteLength(exactLimit, "utf8")).toBe(MAX_OUTBOX_BYTES);

      expect(() => store.enqueueOutbox("peer1", exactLimit)).not.toThrow();
      expect(() => store.enqueueOutbox("peer1", "b")).toThrow(OutboxCapacityError);
    });
  });
});
