import { describe, it, expect } from "vitest";
import {
  CONTEXT_TOKEN_TTL_MS,
  MAX_OUTBOX_BYTES,
  MAX_OUTBOX_MESSAGES,
  OutboxCapacityError,
  SessionStore,
} from "../src/store/session.js";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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

  it("reports a token stale after the official 24-hour reply window", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "ctx");
      const updatedAt = Date.parse(store.session.peers.peer1.context_token_updated_at!);

      expect(store.getPeerOutboundStatus("peer1", updatedAt + CONTEXT_TOKEN_TTL_MS - 1).ready).toBe(true);
      expect(store.getPeerOutboundStatus("peer1", updatedAt + CONTEXT_TOKEN_TTL_MS)).toMatchObject({
        ready: false,
        reason: "stale_context",
      });
    });
  });

  it("marks a rejected context unavailable until a new inbound message refreshes it", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "ctx");
      store.markPeerContextRejected("peer1", "ret=-2 prepare failed");
      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: false,
        reason: "context_rejected",
      });

      const generation = store.getPeerOutboundStatus("peer1").tokenGeneration;
      store.upsertPeer("peer1", "ctx");
      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: true,
        tokenGeneration: generation + 1,
      });
    });
  });

  it("does not let a stale request reject a newer inbound generation", async () => {
    await withTempStore(async (store) => {
      store.upsertPeer("peer1", "context-1");
      const oldGeneration = store.getPeerOutboundStatus("peer1").tokenGeneration;
      store.upsertPeer("peer1", "context-2");

      expect(
        store.markPeerContextRejected("peer1", "late ret=-2", oldGeneration),
      ).toBe(false);
      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: true,
        tokenGeneration: oldGeneration + 1,
        contextToken: "context-2",
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
