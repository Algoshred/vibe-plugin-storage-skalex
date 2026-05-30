/**
 * Skalex Storage Adapter (default)
 *
 * Document-oriented, file-backed, encrypted at rest via Skalex's built-in
 * AES-256-GCM `encrypt` option. Zero native dependencies — runs natively
 * on Bun without N-API / V8-ABI concerns.
 *
 * Side-effect: this module registers itself as the "skalex" adapter on
 * first import.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import Skalex from "skalex";
import type { Collection } from "skalex";

import {
  AgentDatabase,
  registerAdapter,
  type AgentStorageAdapterFactory,
  type AgentStorageAdapterOptions,
  type Task,
  type GitRepository,
  type BookmarkedCommand,
  type Notification,
  type StorageEntry,
} from "@vibecontrols/vibe-plugin-storage";

// ── Collection document shapes ──────────────────────────────────────────
// Skalex documents carry a `_id`, `createdAt`, `updatedAt` alongside our
// domain fields. We keep the domain fields flat so the types in
// src/core/types.ts stay authoritative.

// Document shapes we pass to Skalex. We intentionally OMIT `createdAt` /
// `updatedAt` — Skalex auto-populates those as Date-typed fields on every
// document, and cleanDoc() converts them to ISO strings when we read
// documents back out.
type TaskDoc = Omit<Task, "createdAt" | "updatedAt"> & Record<string, unknown>;
type ConfigDoc = { key: string; value: string } & Record<string, unknown>;
type GitDoc = Omit<GitRepository, "createdAt" | "lastScanned"> & {
  lastScanned?: string;
} & Record<string, unknown>;
type BookmarkDoc = Omit<BookmarkedCommand, "createdAt"> &
  Record<string, unknown>;
type NotificationDoc = Omit<Notification, "createdAt"> &
  Record<string, unknown>;
type PluginStateDoc = {
  pluginName: string;
  key: string;
  value: string;
} & Record<string, unknown>;

// ── Helpers ─────────────────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString();

const pluginStateId = (pluginName: string, key: string): string =>
  `${pluginName}::${key}`;

/**
 * Strip the Skalex-added internal fields from a domain document. Callers
 * and type checking expect clean `Task`, `GitRepository`, etc., not docs
 * decorated with `_id`, `createdAt: Date`, `updatedAt: Date`, etc.
 */
function cleanDoc<T>(doc: Record<string, unknown> | null | undefined): T {
  if (!doc) return doc as T;
  const {
    _id: _ignoredId,
    createdAt: rawCreatedAt,
    updatedAt: rawUpdatedAt,
    _version: _ignoredVersion,
    _expiresAt: _ignoredExpires,
    ...rest
  } = doc as Record<string, unknown>;
  // Skalex stores createdAt/updatedAt as Date; our Task/Notification etc.
  // expose them as ISO strings. Prefer the doc's own field if it already
  // carries a string (e.g. when we explicitly wrote one), else format the
  // Date-typed value from Skalex.
  const out = { ...rest } as Record<string, unknown>;
  if (out.createdAt == null && rawCreatedAt != null) {
    out.createdAt =
      rawCreatedAt instanceof Date
        ? rawCreatedAt.toISOString()
        : String(rawCreatedAt);
  }
  if (out.updatedAt == null && rawUpdatedAt != null) {
    out.updatedAt =
      rawUpdatedAt instanceof Date
        ? rawUpdatedAt.toISOString()
        : String(rawUpdatedAt);
  }
  return out as T;
}

// ── Adapter ─────────────────────────────────────────────────────────────

export class SkalexAgentDatabase extends AgentDatabase {
  private readonly dataDir: string;

  private readonly encryptionKey: string;

  private readonly lockPath: string;

  private lockFd: number | null = null;

  private db!: Skalex;

  private tasks!: Collection<TaskDoc>;

  private config!: Collection<ConfigDoc>;

  private gitRepos!: Collection<GitDoc>;

  private bookmarks!: Collection<BookmarkDoc>;

  private notifications!: Collection<NotificationDoc>;

  private pluginState!: Collection<PluginStateDoc>;

  private constructor(opts: AgentStorageAdapterOptions) {
    super();
    this.dataDir = opts.dataDir;
    this.encryptionKey = opts.encryptionKey;
    this.lockPath = join(opts.dataDir, ".agent-db.lock");
  }

  /**
   * Factory. Creates the directory, connects Skalex with the encrypted
   * adapter, and declares all collections with schema + indexes.
   */
  static async create(
    opts: AgentStorageAdapterOptions,
  ): Promise<SkalexAgentDatabase> {
    if (!existsSync(opts.dataDir)) {
      mkdirSync(opts.dataDir, { recursive: true });
    }
    const instance = new SkalexAgentDatabase(opts);
    instance.acquireLock();
    try {
      await instance.init();
    } catch (err) {
      instance.releaseLock();
      throw err;
    }
    return instance;
  }

  private acquireLock(): void {
    try {
      this.lockFd = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(
        this.lockFd,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    let stale = false;
    try {
      const raw = JSON.parse(readFileSync(this.lockPath, "utf8")) as {
        pid?: number;
      };
      if (!raw.pid) stale = true;
      else {
        try {
          process.kill(raw.pid, 0);
        } catch {
          stale = true;
        }
      }
    } catch {
      stale = true;
    }

    if (stale) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* ignore */
      }
      this.acquireLock();
      return;
    }

    throw new Error(
      `Agent database is already open by another process (${this.lockPath})`,
    );
  }

  private releaseLock(): void {
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
      } catch {
        /* ignore */
      }
      this.lockFd = null;
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }

  private async init(): Promise<void> {
    this.db = new Skalex({
      path: this.dataDir,
      encrypt: { key: this.encryptionKey },
      autoSave: true,
      format: "gz",
      // On first boot the collection files don't exist yet; Skalex's default
      // strict load treats transient decrypt/read failures as fatal
      // corruption. `lenientLoad` downgrades those to warnings so the agent
      // can proceed with an empty collection and persist it on the first
      // write. The option isn't in the Skalex type definition yet but the
      // runtime accepts it (see `_lenientLoad` in skalex.esm.js).
      lenientLoad: true,
    } as ConstructorParameters<typeof Skalex>[0] & { lenientLoad?: boolean });

    // Skalex requires collection declarations BEFORE connect() so the
    // schemas are registered when loadData() hydrates from disk. Calling
    // createCollection here is non-destructive: on first run it defines
    // an empty collection; on subsequent connects the data is loaded
    // into the declared schema.
    //
    // NOTE: we do NOT declare `createdAt` / `updatedAt` in any schema —
    // Skalex auto-manages those as Date-typed internal fields on every
    // document. Declaring them as `string` would cause a validation
    // failure on every update. cleanDoc() below translates the Date
    // fields to ISO strings for our domain types.

    this.tasks = this.db.createCollection<TaskDoc>("tasks", {
      schema: {
        id: { type: "string", required: true, unique: true },
        type: {
          type: "string",
          required: true,
          enum: ["command", "script", "file_operation"],
        },
        status: {
          type: "string",
          required: true,
          enum: ["pending", "running", "completed", "failed"],
        },
        payload: { type: "string", required: true },
        result: { type: "string" },
        error: { type: "string" },
        calendarTaskId: { type: "string" },
        exitCode: { type: "number" },
        timeout: { type: "number" },
      },
      indexes: ["status", "type"],
    });

    this.config = this.db.createCollection<ConfigDoc>("agent_config", {
      schema: {
        key: { type: "string", required: true, unique: true },
        value: { type: "string", required: true },
      },
    });

    this.gitRepos = this.db.createCollection<GitDoc>("git_repositories", {
      schema: {
        id: { type: "string", required: true, unique: true },
        path: { type: "string", required: true, unique: true },
        name: { type: "string", required: true },
        parentPath: { type: "string" },
        isSubmodule: { type: "boolean" },
        projectType: { type: "string" },
        vitePort: { type: "number" },
        lastScanned: { type: "string" },
      },
      indexes: ["parentPath"],
    });

    this.bookmarks = this.db.createCollection<BookmarkDoc>(
      "bookmarked_commands",
      {
        schema: {
          id: { type: "string", required: true, unique: true },
          projectId: { type: "string" },
          command: { type: "string", required: true },
          description: { type: "string" },
          category: { type: "string" },
        },
        indexes: ["projectId", "category"],
      },
    );

    this.notifications = this.db.createCollection<NotificationDoc>(
      "notifications",
      {
        schema: {
          id: { type: "string", required: true, unique: true },
          sessionName: { type: "string" },
          projectId: { type: "string" },
          type: {
            type: "string",
            required: true,
            enum: ["info", "success", "warning", "error"],
          },
          title: { type: "string", required: true },
          message: { type: "string", required: true },
          status: {
            type: "string",
            required: true,
            enum: ["unread", "read"],
          },
        },
        indexes: ["status", "projectId"],
      },
    );

    this.pluginState = this.db.createCollection<PluginStateDoc>(
      "plugin_state",
      {
        schema: {
          pluginName: { type: "string", required: true },
          key: { type: "string", required: true },
          value: { type: "string", required: true },
        },
        indexes: ["pluginName"],
      },
    );

    await this.db.connect();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.db?.isConnected) {
      await this.db.disconnect();
    }
    this.releaseLock();
  }

  getDbPath(): string {
    return this.dataDir;
  }

  // ── Backup ──────────────────────────────────────────────────────────

  /**
   * Skalex persists each collection as one ciphertext+gzip file under
   * `dataDir`. Snapshot = tar of the entire directory. We shell out to
   * `tar` because Bun ships it via the OS and a single binary stream
   * keeps the result deterministic + hashable. The caller is responsible
   * for unlinking the result.
   */
  async backup(targetPath: string): Promise<void> {
    // Skalex collections are written-through on every mutation, so a
    // straight tar is safe — there is no separate in-memory journal to
    // flush. We exclude the lockfile so two consecutive backups produce
    // byte-identical archives for the unchanged case.
    //
    // `tar` ships natively on POSIX and on Windows 10 1803+ (as tar.exe).
    // Resolve it on PATH first so we fail with a clear error instead of
    // spawning a missing binary on stripped-down hosts.
    const tarPath = Bun.which("tar", { PATH: process.env.PATH });
    if (tarPath == null) {
      throw new Error("tar not found on PATH - required for backup/export");
    }
    const proc = Bun.spawn(
      [
        tarPath,
        "-czf",
        targetPath,
        "--exclude=.agent-db.lock",
        "-C",
        this.dataDir,
        ".",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Skalex backup failed (exit ${exitCode}): ${err}`);
    }
  }

  // ── Task Methods ────────────────────────────────────────────────────

  async createTask(task: Omit<Task, "createdAt" | "updatedAt">): Promise<Task> {
    const doc: TaskDoc = {
      id: task.id,
      type: task.type,
      status: task.status,
      payload: task.payload,
    };
    if (task.result != null) doc.result = task.result;
    if (task.error != null) doc.error = task.error;
    if (task.calendarTaskId != null) doc.calendarTaskId = task.calendarTaskId;
    if (task.exitCode != null) doc.exitCode = task.exitCode;
    if (task.timeout != null) doc.timeout = task.timeout;
    const inserted = await this.tasks.insertOne(doc);
    return cleanDoc<Task>(inserted);
  }

  async getTask(id: string): Promise<Task | undefined> {
    const doc = await this.tasks.findOne({ id });
    return doc ? cleanDoc<Task>(doc) : undefined;
  }

  async getAllTasks(): Promise<Task[]> {
    const res = await this.tasks.find(undefined, {
      sort: { createdAt: -1 },
    });
    return res.docs.map((d) => cleanDoc<Task>(d));
  }

  async getPendingTasks(): Promise<Task[]> {
    const res = await this.tasks.find(
      { status: "pending" },
      { sort: { createdAt: 1 } },
    );
    return res.docs.map((d) => cleanDoc<Task>(d));
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<void> {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === "id" || k === "createdAt" || k === "updatedAt") continue;
      patch[k] = v ?? null;
    }
    if (Object.keys(patch).length === 0) return;
    await this.tasks.updateOne({ id }, patch);
  }

  async cancelTask(id: string): Promise<boolean> {
    const existing = await this.tasks.findOne({ id });
    if (
      !existing ||
      (existing.status !== "pending" && existing.status !== "running")
    ) {
      return false;
    }
    await this.tasks.updateOne(
      { id },
      { status: "failed", error: "Cancelled" },
    );
    return true;
  }

  // ── Config Methods ──────────────────────────────────────────────────

  async getConfig(key: string): Promise<string | undefined> {
    const doc = await this.config.findOne({ key });
    return doc?.value;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.config.upsert({ key }, { key, value });
  }

  async deleteConfig(key: string): Promise<boolean> {
    const deleted = await this.config.deleteOne({ key });
    return deleted !== null;
  }

  async getAllConfig(): Promise<Record<string, string>> {
    const res = await this.config.find();
    const out: Record<string, string> = {};
    for (const doc of res.docs) {
      out[doc.key] = doc.value;
    }
    return out;
  }

  async bulkSetConfig(entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.config.upsert({ key }, { key, value });
    }
  }

  async getConfigStatus(): Promise<{
    totalKeys: number;
    lastUpdated: string | null;
  }> {
    const res = await this.config.find();
    let latest: string | null = null;
    for (const doc of res.docs) {
      const raw = (doc as unknown as { updatedAt?: unknown }).updatedAt;
      const iso =
        raw instanceof Date
          ? raw.toISOString()
          : typeof raw === "string"
            ? raw
            : null;
      if (iso && (!latest || iso > latest)) latest = iso;
    }
    return { totalKeys: res.docs.length, lastUpdated: latest };
  }

  // ── Git Repository Methods ──────────────────────────────────────────

  async createGitRepository(
    repo: Omit<GitRepository, "createdAt" | "lastScanned">,
  ): Promise<GitRepository> {
    const doc: GitDoc = {
      id: repo.id,
      path: repo.path,
      name: repo.name,
      isSubmodule: Boolean(repo.isSubmodule),
      lastScanned: nowIso(),
    };
    if (repo.parentPath != null) doc.parentPath = repo.parentPath;
    if (repo.projectType != null) doc.projectType = repo.projectType;
    if (repo.vitePort != null) doc.vitePort = repo.vitePort;
    const inserted = await this.gitRepos.insertOne(doc);
    return cleanDoc<GitRepository>(inserted);
  }

  async getGitRepository(id: string): Promise<GitRepository | undefined> {
    const doc = await this.gitRepos.findOne({ id });
    return doc ? cleanDoc<GitRepository>(doc) : undefined;
  }

  async getGitRepositoryByPath(
    path: string,
  ): Promise<GitRepository | undefined> {
    const doc = await this.gitRepos.findOne({ path });
    return doc ? cleanDoc<GitRepository>(doc) : undefined;
  }

  async getAllGitRepositories(): Promise<GitRepository[]> {
    const res = await this.gitRepos.find(undefined, { sort: { path: 1 } });
    return res.docs.map((d) => cleanDoc<GitRepository>(d));
  }

  async updateGitRepository(
    id: string,
    updates: Partial<GitRepository>,
  ): Promise<void> {
    const patch: Record<string, unknown> = { lastScanned: nowIso() };
    for (const [k, v] of Object.entries(updates)) {
      if (k === "id" || k === "createdAt" || k === "updatedAt") continue;
      if (k === "isSubmodule") {
        patch[k] = Boolean(v);
        continue;
      }
      patch[k] = v ?? null;
    }
    await this.gitRepos.updateOne({ id }, patch);
  }

  async deleteGitRepository(id: string): Promise<boolean> {
    const deleted = await this.gitRepos.deleteOne({ id });
    return deleted !== null;
  }

  async fixGitHierarchy(): Promise<{ fixed: number }> {
    const repos = await this.getAllGitRepositories();
    let fixed = 0;
    for (const repo of repos) {
      if (repo.isSubmodule) continue;
      const parent = repos.find((r) => {
        if (r.id === repo.id || r.isSubmodule) return false;
        // `repo.path` / `r.path` are real OS filesystem paths (resolved by
        // the agent's git scanner), so use node:path to test strict nesting.
        // This matches the old `repo.path.startsWith(`${r.path}/`)` for the
        // normalized paths the scanner produces, while also handling Windows
        // backslash separators. A child path yields a relative path that is
        // neither empty, "..", absolute, nor "../"-prefixed.
        const rel = relative(r.path, repo.path);
        return (
          rel !== "" &&
          rel !== ".." &&
          !rel.startsWith(`..${sep}`) &&
          !isAbsolute(rel)
        );
      });
      if (parent && repo.parentPath !== parent.path) {
        await this.updateGitRepository(repo.id, { parentPath: parent.path });
        fixed++;
      }
    }
    return { fixed };
  }

  // ── Bookmarked Command Methods ──────────────────────────────────────

  async createBookmarkedCommand(
    cmd: Omit<BookmarkedCommand, "createdAt">,
  ): Promise<BookmarkedCommand> {
    const doc: BookmarkDoc = {
      id: cmd.id,
      command: cmd.command,
    };
    if (cmd.projectId != null) doc.projectId = cmd.projectId;
    if (cmd.description != null) doc.description = cmd.description;
    if (cmd.category != null) doc.category = cmd.category;
    const inserted = await this.bookmarks.insertOne(doc);
    return cleanDoc<BookmarkedCommand>(inserted);
  }

  async getBookmarkedCommand(
    id: string,
  ): Promise<BookmarkedCommand | undefined> {
    const doc = await this.bookmarks.findOne({ id });
    return doc ? cleanDoc<BookmarkedCommand>(doc) : undefined;
  }

  async getAllBookmarkedCommands(): Promise<BookmarkedCommand[]> {
    const res = await this.bookmarks.find(undefined, {
      sort: { createdAt: -1 },
    });
    return res.docs.map((d) => cleanDoc<BookmarkedCommand>(d));
  }

  async getBookmarkedCommandsByProject(
    projectId: string | null,
  ): Promise<BookmarkedCommand[]> {
    const filter =
      projectId === null
        ? { projectId: { $fn: (v: unknown) => v == null } }
        : { projectId };
    const res = await this.bookmarks.find(filter, { sort: { createdAt: -1 } });
    return res.docs.map((d) => cleanDoc<BookmarkedCommand>(d));
  }

  async getBookmarkedCommandsByCategory(
    category: string,
  ): Promise<BookmarkedCommand[]> {
    const res = await this.bookmarks.find(
      { category },
      { sort: { createdAt: -1 } },
    );
    return res.docs.map((d) => cleanDoc<BookmarkedCommand>(d));
  }

  async updateBookmarkedCommand(
    id: string,
    updates: Partial<BookmarkedCommand>,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === "id" || k === "createdAt" || k === "updatedAt") continue;
      patch[k] = v ?? null;
    }
    if (Object.keys(patch).length === 0) return;
    await this.bookmarks.updateOne({ id }, patch);
  }

  async deleteBookmarkedCommand(id: string): Promise<boolean> {
    const deleted = await this.bookmarks.deleteOne({ id });
    return deleted !== null;
  }

  async executeBookmarkedCommand(
    id: string,
  ): Promise<BookmarkedCommand | undefined> {
    return this.getBookmarkedCommand(id);
  }

  // ── Notification Methods ────────────────────────────────────────────

  async createNotification(
    notification: Omit<Notification, "createdAt">,
  ): Promise<Notification> {
    const doc: NotificationDoc = {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      status: notification.status,
    };
    if (notification.sessionName != null)
      doc.sessionName = notification.sessionName;
    if (notification.projectId != null) doc.projectId = notification.projectId;
    const inserted = await this.notifications.insertOne(doc);
    return cleanDoc<Notification>(inserted);
  }

  async getNotification(id: string): Promise<Notification | undefined> {
    const doc = await this.notifications.findOne({ id });
    return doc ? cleanDoc<Notification>(doc) : undefined;
  }

  async getAllNotifications(): Promise<Notification[]> {
    const res = await this.notifications.find(undefined, {
      sort: { createdAt: -1 },
    });
    return res.docs.map((d) => cleanDoc<Notification>(d));
  }

  async getNotificationsByProject(
    projectId: string | null,
  ): Promise<Notification[]> {
    const filter =
      projectId === null
        ? { projectId: { $fn: (v: unknown) => v == null } }
        : { projectId };
    const res = await this.notifications.find(filter, {
      sort: { createdAt: -1 },
    });
    return res.docs.map((d) => cleanDoc<Notification>(d));
  }

  async getGlobalNotifications(): Promise<Notification[]> {
    return this.getNotificationsByProject(null);
  }

  async getUnreadNotifications(): Promise<Notification[]> {
    const res = await this.notifications.find(
      { status: "unread" },
      { sort: { createdAt: -1 } },
    );
    return res.docs.map((d) => cleanDoc<Notification>(d));
  }

  async updateNotificationStatus(
    id: string,
    status: "unread" | "read",
  ): Promise<void> {
    await this.notifications.updateOne({ id }, { status });
  }

  async markAllNotificationsRead(): Promise<number> {
    const updated = await this.notifications.updateMany(
      { status: "unread" },
      { status: "read" },
    );
    return updated.length;
  }

  async deleteNotification(id: string): Promise<boolean> {
    const deleted = await this.notifications.deleteOne({ id });
    return deleted !== null;
  }

  async clearOldNotifications(olderThanDays: number = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    // Skalex stores the auto-managed createdAt as a Date; use $fn for a
    // type-safe comparison instead of a string-level comparison that would
    // break on Date values.
    const deleted = await this.notifications.deleteMany({
      createdAt: {
        $fn: (v: unknown) => v instanceof Date && v < cutoff,
      },
    });
    return deleted.length;
  }

  // ── Plugin State Methods ────────────────────────────────────────────

  async getPluginState(
    pluginName: string,
    key: string,
  ): Promise<string | undefined> {
    const doc = await this.pluginState.findOne({
      $and: [{ pluginName }, { key }],
    });
    return doc?.value;
  }

  async setPluginState(
    pluginName: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.pluginState.upsert(
      { $and: [{ pluginName }, { key }] },
      {
        pluginName,
        key,
        value,
      },
    );
    void pluginStateId; // suppress unused-helper warning in strict lint
  }

  async deletePluginState(pluginName: string, key: string): Promise<boolean> {
    const deleted = await this.pluginState.deleteOne({
      $and: [{ pluginName }, { key }],
    });
    return deleted !== null;
  }

  async getAllPluginState(pluginName: string): Promise<StorageEntry[]> {
    const res = await this.pluginState.find(
      { pluginName },
      { sort: { key: 1 } },
    );
    return res.docs.map((doc) => {
      const raw = (doc as unknown as { updatedAt?: unknown }).updatedAt;
      const updatedAt =
        raw instanceof Date
          ? raw.toISOString()
          : typeof raw === "string"
            ? raw
            : undefined;
      return { key: doc.key, value: doc.value, updatedAt };
    });
  }

  async deleteAllPluginState(pluginName: string): Promise<number> {
    const deleted = await this.pluginState.deleteMany({ pluginName });
    return deleted.length;
  }
}

// ── Factory + registration ──────────────────────────────────────────────

export const createSkalexAgentDatabase: AgentStorageAdapterFactory = (opts) =>
  SkalexAgentDatabase.create(opts);

registerAdapter("skalex", createSkalexAgentDatabase);
