import { Request, Response, Router } from "express";
import { MIGRATION_TABLES, ensureDatabaseSchema } from "./dbSchema";
import { connectDatabase, executeRaw, getDatabaseKind, nowDate, queryRaw } from "./dbRuntime";
import { getAllSettings, setSetting } from "./repositories/settingsRepository";
import { getHosts, getUserByUsername, requestHostAgentUpgrade } from "./db";
import { verifyPassword } from "./password";
import { pushAgentUpgrade } from "./agentEvents";
import { AGENT_VERSION } from "./_core/systemRouter";
import { consumeMigrationCodeForTakeover, consumeTakeoverToken } from "./migrationCodes";

export type MigrationJobStatus = "pending" | "running" | "success" | "failed";

export interface MigrationSnapshot {
  version: 1;
  exportedAt: number;
  sourcePanelUrl?: string;
  takeoverToken?: string;
  tables: Record<string, Record<string, any>[]>;
}

export interface MigrationJob {
  id: string;
  status: MigrationJobStatus;
  progress: number;
  step: string;
  message?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, MigrationJob>();

function normalizePanelUrl(url: string) {
  const value = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return `http://${value}`;
  return value;
}

function setJob(job: MigrationJob, patch: Partial<MigrationJob>) {
  Object.assign(job, patch);
  jobs.set(job.id, job);
}

export function getMigrationJob(id: string) {
  return jobs.get(id) || null;
}

export async function exportMigrationSnapshot(sourcePanelUrl?: string): Promise<MigrationSnapshot> {
  await connectDatabase();
  await ensureDatabaseSchema();
  const tables: MigrationSnapshot["tables"] = {};
  for (const table of MIGRATION_TABLES) {
    tables[table] = await queryRaw(`SELECT * FROM ${quote(table)}`);
  }
  return { version: 1, exportedAt: Date.now(), sourcePanelUrl, tables };
}

function quote(name: string) {
  return getDatabaseKind() === "sqlite" ? `"${name}"` : `\`${name}\``;
}

function normalizeValue(value: any) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export async function importMigrationSnapshot(snapshot: MigrationSnapshot, onProgress?: (progress: number, step: string) => void) {
  await connectDatabase();
  await ensureDatabaseSchema();
  const tables = MIGRATION_TABLES.filter((table) => Array.isArray(snapshot.tables?.[table]));
  onProgress?.(45, "正在清空新面板数据表");
  for (const table of [...tables].reverse()) {
    await executeRaw(`DELETE FROM ${quote(table)}`);
  }

  let done = 0;
  const total = Math.max(1, tables.reduce((sum, table) => sum + snapshot.tables[table].length, 0));
  for (const table of tables) {
    const rows = snapshot.tables[table] || [];
    onProgress?.(50 + Math.floor((done / total) * 40), `正在写入 ${table}`);
    for (const row of rows) {
      const columns = Object.keys(row).filter((key) => row[key] !== undefined);
      if (columns.length === 0) continue;
      const placeholders = columns.map(() => "?").join(", ");
      const names = columns.map((key) => quote(key)).join(", ");
      await executeRaw(
        `INSERT INTO ${quote(table)} (${names}) VALUES (${placeholders})`,
        columns.map((key) => normalizeValue(row[key])),
      );
      done += 1;
    }
  }
  onProgress?.(92, "正在恢复系统设置");
  if (!snapshot.tables.system_settings?.some((row) => row.key === "storeEnabled")) {
    await setSetting("storeEnabled", "false");
  }
  await markImportedAgentsOffline();
}

export async function verifyAdminCredentials(username: string, password: string) {
  const user = await getUserByUsername(username);
  if (!user || user.role !== "admin") return false;
  return verifyPassword(password, user.password);
}

export async function announcePanelMigration(targetPanelUrl: string, options: { forceAgentSwitch?: boolean } = {}) {
  const normalized = normalizePanelUrl(targetPanelUrl);
  await setSetting("panelPublicUrl", normalized);
  const hosts = await getHosts();
  const targetVersion = options.forceAgentSwitch ? "9999.0.0" : AGENT_VERSION;
  for (const host of hosts as any[]) {
    await requestHostAgentUpgrade(Number(host.id), targetVersion);
    pushAgentUpgrade(Number(host.id), targetVersion, normalized);
  }
  return { hostCount: hosts.length, panelUrl: normalized };
}

async function markImportedAgentsOffline() {
  await executeRaw(`UPDATE ${quote("hosts")} SET ${quote("isOnline")} = ?, ${quote("lastHeartbeat")} = NULL`, [0]);
}

async function retainOnlyAdminAccountAndSettings(targetPanelUrl: string) {
  await connectDatabase();
  await ensureDatabaseSchema();
  const settings = await getAllSettings();
  for (const table of [...MIGRATION_TABLES].reverse()) {
    if (table === "users") continue;
    await executeRaw(`DELETE FROM ${quote(table)}`);
  }
  await executeRaw(`DELETE FROM ${quote("users")} WHERE ${quote("role")} <> ?`, ["admin"]);
  const normalized = normalizePanelUrl(targetPanelUrl);
  await setSetting("databaseConfigured", "true");
  await setSetting("databaseType", getDatabaseKind() || "");
  await setSetting("mysqlConfigured", getDatabaseKind() === "mysql" ? "true" : "false");
  await setSetting("mysqlHost", settings.mysqlHost ?? null);
  await setSetting("mysqlDatabase", settings.mysqlDatabase ?? null);
  await setSetting("sqlitePath", settings.sqlitePath ?? null);
  await setSetting("setupDataChoice", "new-panel");
  await setSetting("panelPublicUrl", normalized);
  await setSetting("migratedToPanelUrl", normalized);
  await setSetting("migratedAt", String(Math.floor(nowDate().getTime() / 1000)));
}

async function fetchSnapshotFromOldPanel(input: {
  oldPanelUrl: string;
  migrationCode: string;
  targetPanelUrl: string;
}) {
  const url = `${normalizePanelUrl(input.oldPanelUrl)}/api/migration/export`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      migrationCode: input.migrationCode,
      targetPanelUrl: input.targetPanelUrl,
    }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(body || `旧面板返回 ${resp.status}`);
  }
  return JSON.parse(body) as MigrationSnapshot;
}

async function finalizeOldPanelTakeover(input: {
  oldPanelUrl: string;
  targetPanelUrl: string;
  takeoverToken?: string;
}) {
  if (!input.takeoverToken) return null;
  const url = `${normalizePanelUrl(input.oldPanelUrl)}/api/migration/takeover-complete`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      takeoverToken: input.takeoverToken,
      targetPanelUrl: input.targetPanelUrl,
    }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(body || `旧面板接管确认返回 ${resp.status}`);
  }
  return body ? JSON.parse(body) : null;
}

export function startPanelMigration(input: {
  oldPanelUrl: string;
  migrationCode: string;
  targetPanelUrl: string;
}) {
  const job: MigrationJob = {
    id: crypto.randomUUID(),
    status: "pending",
    progress: 0,
    step: "等待迁移开始",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      setJob(job, { status: "running", progress: 10, step: "正在连接旧面板" });
      const snapshot = await fetchSnapshotFromOldPanel(input);
      setJob(job, { progress: 35, step: "已获取旧面板数据，正在准备新数据库" });
      await importMigrationSnapshot(snapshot, (progress, step) => setJob(job, { progress, step }));
      setJob(job, { progress: 94, step: "正在写入新面板地址" });
      await setSetting("panelPublicUrl", normalizePanelUrl(input.targetPanelUrl));
      await setSetting("setupDataChoice", "use-existing");
      setJob(job, { progress: 96, step: "正在通知旧面板切换 Agent" });
      await finalizeOldPanelTakeover({
        oldPanelUrl: input.oldPanelUrl,
        targetPanelUrl: input.targetPanelUrl,
        takeoverToken: snapshot.takeoverToken,
      });
      setJob(job, { status: "success", progress: 100, step: "迁移完成", finishedAt: Date.now() });
    } catch (error) {
      setJob(job, {
        status: "failed",
        progress: Math.max(job.progress, 1),
        step: "迁移失败",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    }
  })();

  return job;
}

export const migrationRouter = Router();

migrationRouter.post("/api/migration/export", async (req: Request, res: Response) => {
  try {
    const migrationCode = String(req.body?.migrationCode || "");
    const targetPanelUrl = String(req.body?.targetPanelUrl || "");
    if (!migrationCode) {
      res.status(400).json({ error: "migrationCode required" });
      return;
    }
    const takeover = consumeMigrationCodeForTakeover(migrationCode);
    if (!takeover) {
      res.status(401).json({ error: "迁移码无效、已过期或已使用" });
      return;
    }
    const settings = await getAllSettings();
    const snapshot = await exportMigrationSnapshot(settings.panelPublicUrl || undefined);
    snapshot.takeoverToken = takeover.takeoverToken;
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

migrationRouter.post("/api/migration/takeover-complete", async (req: Request, res: Response) => {
  try {
    const takeoverToken = String(req.body?.takeoverToken || "");
    const targetPanelUrl = String(req.body?.targetPanelUrl || "");
    if (!takeoverToken || !targetPanelUrl) {
      res.status(400).json({ error: "takeoverToken/targetPanelUrl required" });
      return;
    }
    if (!consumeTakeoverToken(takeoverToken)) {
      res.status(401).json({ error: "接管令牌无效、已过期或已使用" });
      return;
    }
    const takeover = await announcePanelMigration(targetPanelUrl, { forceAgentSwitch: true });
    await retainOnlyAdminAccountAndSettings(targetPanelUrl);
    res.json({ success: true, ...takeover });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
