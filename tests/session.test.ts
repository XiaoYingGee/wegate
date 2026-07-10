import { describe, it, expect } from "vitest";
import { SessionStore } from "../src/store/session.js";
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
});
