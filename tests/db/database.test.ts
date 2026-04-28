/**
 * AgentDatabase adapter contract + Skalex default adapter tests.
 *
 * These tests exercise the real SkalexAgentDatabase — no mocks — using
 * a throwaway temp directory per run. They verify:
 *   - fail-closed when no encryption key is supplied
 *   - round-trip CRUD on every collection
 *   - upsert semantics for config and plugin state
 *   - enum validation for tasks and notifications
 *   - on-disk ciphertext (no plaintext leakage)
 *   - custom adapter override works via adapterFactory
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentDatabase,
  createAgentDatabase,
  type AgentStorageAdapterFactory,
} from "@vibecontrols/vibe-plugin-storage";

// Side-effect: register the "skalex" adapter for this test process.
import "../../src/index.js";

const KEY = "f".repeat(64); // 32 bytes of 0xff

describe("AgentDatabase factory", () => {
  it("throws when no encryption key is provided", async () => {
    await expect(
      createAgentDatabase({ dbPath: tmpdir() } as Parameters<typeof createAgentDatabase>[0]),
    ).rejects.toThrow(/encryptionKey is required/);
  });

  it("throws when an unknown adapter name is requested", async () => {
    await expect(
      createAgentDatabase({
        dbPath: tmpdir(),
        encryptionKey: KEY,
        adapterName: "no-such-adapter",
      }),
    ).rejects.toThrow(/Unknown storage adapter/);
  });

  it("accepts an explicit adapterFactory override", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agentdb-override-"));
    try {
      let factoryCalledWith: { dataDir: string; encryptionKey: string } | null =
        null;
      const factory: AgentStorageAdapterFactory = async (opts) => {
        factoryCalledWith = opts;
        // Return a minimal fake that satisfies the abstract class shape.
        return new (class extends AgentDatabase {
          async close() {}
          getDbPath() {
            return opts.dataDir;
          }
          async createTask() {
            throw new Error("not implemented");
          }
          async getTask() {
            return undefined;
          }
          async getAllTasks() {
            return [];
          }
          async getPendingTasks() {
            return [];
          }
          async updateTask() {}
          async cancelTask() {
            return false;
          }
          async getConfig() {
            return undefined;
          }
          async setConfig() {}
          async deleteConfig() {
            return false;
          }
          async getAllConfig() {
            return {};
          }
          async bulkSetConfig() {}
          async getConfigStatus() {
            return { totalKeys: 0, lastUpdated: null };
          }
          async createGitRepository(
            repo: Parameters<AgentDatabase["createGitRepository"]>[0],
          ) {
            return {
              ...repo,
              createdAt: "",
              lastScanned: "",
            } as ReturnType<
              AgentDatabase["createGitRepository"]
            > extends Promise<infer R>
              ? R
              : never;
          }
          async getGitRepository() {
            return undefined;
          }
          async getGitRepositoryByPath() {
            return undefined;
          }
          async getAllGitRepositories() {
            return [];
          }
          async updateGitRepository() {}
          async deleteGitRepository() {
            return false;
          }
          async fixGitHierarchy() {
            return { fixed: 0 };
          }
          async createBookmarkedCommand(
            cmd: Parameters<AgentDatabase["createBookmarkedCommand"]>[0],
          ) {
            return { ...cmd, createdAt: "" };
          }
          async getBookmarkedCommand() {
            return undefined;
          }
          async getAllBookmarkedCommands() {
            return [];
          }
          async getBookmarkedCommandsByProject() {
            return [];
          }
          async getBookmarkedCommandsByCategory() {
            return [];
          }
          async updateBookmarkedCommand() {}
          async deleteBookmarkedCommand() {
            return false;
          }
          async executeBookmarkedCommand() {
            return undefined;
          }
          async createNotification(
            n: Parameters<AgentDatabase["createNotification"]>[0],
          ) {
            return { ...n, createdAt: "" };
          }
          async getNotification() {
            return undefined;
          }
          async getAllNotifications() {
            return [];
          }
          async getNotificationsByProject() {
            return [];
          }
          async getGlobalNotifications() {
            return [];
          }
          async getUnreadNotifications() {
            return [];
          }
          async updateNotificationStatus() {}
          async markAllNotificationsRead() {
            return 0;
          }
          async deleteNotification() {
            return false;
          }
          async clearOldNotifications() {
            return 0;
          }
          async getPluginState() {
            return undefined;
          }
          async setPluginState() {}
          async deletePluginState() {
            return false;
          }
          async getAllPluginState() {
            return [];
          }
          async deleteAllPluginState() {
            return 0;
          }
        })();
      };

      const db = await createAgentDatabase({
        dbPath: dataDir,
        encryptionKey: KEY,
        adapterFactory: factory,
      });
      expect(factoryCalledWith).not.toBeNull();
      expect(factoryCalledWith!.dataDir).toBe(dataDir);
      expect(factoryCalledWith!.encryptionKey).toBe(KEY);
      expect(db.getDbPath()).toBe(dataDir);
      await db.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("prevents two Skalex database handles from opening the same data directory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agentdb-lock-"));
    const db = await createAgentDatabase({
      dbPath: dataDir,
      encryptionKey: KEY,
    });

    try {
      await expect(
        createAgentDatabase({ dbPath: dataDir, encryptionKey: KEY }),
      ).rejects.toThrow(/already open/);
    } finally {
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("SkalexAgentDatabase (default adapter)", () => {
  let dataDir: string;
  let db: AgentDatabase;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "agentdb-skalex-"));
    db = await createAgentDatabase({
      dbPath: dataDir,
      encryptionKey: KEY,
    });
  });

  afterEach(async () => {
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a task", async () => {
    const created = await db.createTask({
      id: "task-1",
      type: "command",
      status: "pending",
      payload: JSON.stringify({ command: "ls" }),
    });
    expect(created.id).toBe("task-1");
    expect(created.createdAt).toBeDefined();

    const found = await db.getTask("task-1");
    expect(found?.payload).toBe(JSON.stringify({ command: "ls" }));

    await db.updateTask("task-1", { status: "completed", result: "ok" });
    const updated = await db.getTask("task-1");
    expect(updated?.status).toBe("completed");
    expect(updated?.result).toBe("ok");

    const all = await db.getAllTasks();
    expect(all.length).toBe(1);
    expect((await db.getPendingTasks()).length).toBe(0);
  });

  it("cancels only pending/running tasks", async () => {
    await db.createTask({
      id: "task-2",
      type: "script",
      status: "pending",
      payload: "x",
    });
    expect(await db.cancelTask("task-2")).toBe(true);
    const after = await db.getTask("task-2");
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("Cancelled");
    // Second cancel is a no-op
    expect(await db.cancelTask("task-2")).toBe(false);
  });

  it("rejects invalid task enum values", async () => {
    await expect(
      db.createTask({
        id: "task-3",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: "bogus" as any,
        status: "pending",
        payload: "x",
      }),
    ).rejects.toThrow();
  });

  it("upserts config without duplicates", async () => {
    await db.setConfig("theme", "dark");
    await db.setConfig("theme", "light");
    expect(await db.getConfig("theme")).toBe("light");
    const all = await db.getAllConfig();
    expect(Object.keys(all).length).toBe(1);
    expect(all.theme).toBe("light");

    const status = await db.getConfigStatus();
    expect(status.totalKeys).toBe(1);

    expect(await db.deleteConfig("theme")).toBe(true);
    expect(await db.getConfig("theme")).toBeUndefined();
  });

  it("bulk sets config", async () => {
    await db.bulkSetConfig({ a: "1", b: "2", c: "3" });
    const all = await db.getAllConfig();
    expect(all).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("round-trips a git repository with boolean isSubmodule", async () => {
    await db.createGitRepository({
      id: "r1",
      path: "/tmp/r1",
      name: "r1",
      isSubmodule: true,
    });
    const r = await db.getGitRepository("r1");
    expect(r?.isSubmodule).toBe(true);
    const r2 = await db.getGitRepositoryByPath("/tmp/r1");
    expect(r2?.id).toBe("r1");
  });

  it("round-trips notifications and marks all read", async () => {
    await db.createNotification({
      id: "n1",
      type: "info",
      title: "t1",
      message: "m1",
      status: "unread",
    });
    await db.createNotification({
      id: "n2",
      type: "error",
      title: "t2",
      message: "m2",
      status: "unread",
    });
    expect((await db.getUnreadNotifications()).length).toBe(2);
    expect(await db.markAllNotificationsRead()).toBe(2);
    expect((await db.getUnreadNotifications()).length).toBe(0);
  });

  it("scopes plugin state by plugin name", async () => {
    await db.setPluginState("plugin-a", "key1", "value-a1");
    await db.setPluginState("plugin-a", "key2", "value-a2");
    await db.setPluginState("plugin-b", "key1", "value-b1");

    expect(await db.getPluginState("plugin-a", "key1")).toBe("value-a1");
    expect(await db.getPluginState("plugin-b", "key1")).toBe("value-b1");

    const allA = await db.getAllPluginState("plugin-a");
    expect(allA.length).toBe(2);

    expect(await db.deleteAllPluginState("plugin-a")).toBe(2);
    expect((await db.getAllPluginState("plugin-a")).length).toBe(0);
    expect((await db.getAllPluginState("plugin-b")).length).toBe(1);
  });

  it("writes only ciphertext to disk (no plaintext leak)", async () => {
    const secret = "SKALEX-PLAINTEXT-CANARY-987654321";
    await db.setConfig("canary", secret);
    await db.createTask({
      id: "task-canary",
      type: "command",
      status: "pending",
      payload: secret,
    });
    // Force a save by closing and reopening via a fresh instance.
    await db.close();
    db = await createAgentDatabase({ dbPath: dataDir, encryptionKey: KEY });

    const files = readdirSync(dataDir, { recursive: true }) as string[];
    let sawPlaintext = false;
    for (const rel of files) {
      const full = join(dataDir, rel);
      try {
        if (statSync(full).isDirectory()) continue;
        const bytes = readFileSync(full);
        const sample = bytes
          .subarray(0, Math.min(bytes.length, 16384))
          .toString("utf8");
        if (sample.includes(secret)) {
          sawPlaintext = true;
          break;
        }
      } catch {
        /* skip */
      }
    }
    expect(sawPlaintext).toBe(false);
    // And the data is still readable via the API (sanity):
    expect(await db.getConfig("canary")).toBe(secret);
  });

  it("fails to reopen with the wrong encryption key", async () => {
    // Use a dedicated data dir so the wrong-key attempt can't corrupt the
    // main test db that afterEach() cleans up.
    const isolatedDir = mkdtempSync(join(tmpdir(), "agentdb-wrongkey-"));
    try {
      const primary = await createAgentDatabase({
        dbPath: isolatedDir,
        encryptionKey: KEY,
      });
      await primary.setConfig("k", "v");
      await primary.close();

      // Reopen with a different key. Skalex lenient-load may return an empty
      // store instead of throwing, but it must never expose plaintext.
      const wrongKey = "0".repeat(64);
      let leakedPlaintext = false;
      try {
        const wrong = await createAgentDatabase({
          dbPath: isolatedDir,
          encryptionKey: wrongKey,
        });
        const v = await wrong.getConfig("k");
        leakedPlaintext = v === "v";
        await wrong.close();
      } catch {
        // Throwing is also an acceptable fail-closed behavior.
      }
      expect(leakedPlaintext).toBe(false);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
