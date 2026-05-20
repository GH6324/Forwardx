const migrationCodes = new Map<string, { expiresAt: number; createdAt: number }>();
const takeoverTokens = new Map<string, { expiresAt: number; createdAt: number }>();
const MIGRATION_CODE_TTL_MS = 5 * 60 * 1000;
const TAKEOVER_TOKEN_TTL_MS = 5 * 60 * 1000;

function cleanupMigrationCodes() {
  const now = Date.now();
  for (const [code, entry] of migrationCodes) {
    if (entry.expiresAt <= now) migrationCodes.delete(code);
  }
  for (const [token, entry] of takeoverTokens) {
    if (entry.expiresAt <= now) takeoverTokens.delete(token);
  }
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function randomToken(length = 48) {
  let token = "";
  while (token.length < length) {
    token += crypto.randomUUID().replace(/-/g, "");
  }
  return token.slice(0, length).toUpperCase();
}

function takeMigrationCodeEntry(code: string) {
  cleanupMigrationCodes();
  const normalized = normalizeCode(code);
  const entry = migrationCodes.get(normalized);
  migrationCodes.delete(normalized);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

export function createMigrationCode() {
  cleanupMigrationCodes();
  const code = randomToken(12);
  const now = Date.now();
  const entry = { createdAt: now, expiresAt: now + MIGRATION_CODE_TTL_MS };
  migrationCodes.set(code, entry);
  return { code, expiresAt: entry.expiresAt, expiresInSeconds: MIGRATION_CODE_TTL_MS / 1000 };
}

export function consumeMigrationCode(code: string) {
  return !!takeMigrationCodeEntry(code);
}

export function consumeMigrationCodeForTakeover(code: string) {
  const entry = takeMigrationCodeEntry(code);
  if (!entry) return null;
  const now = Date.now();
  const takeoverToken = randomToken(48);
  const takeoverEntry = { createdAt: now, expiresAt: now + TAKEOVER_TOKEN_TTL_MS };
  takeoverTokens.set(takeoverToken, takeoverEntry);
  return {
    takeoverToken,
    expiresAt: takeoverEntry.expiresAt,
    expiresInSeconds: TAKEOVER_TOKEN_TTL_MS / 1000,
  };
}

export function consumeTakeoverToken(token: string) {
  cleanupMigrationCodes();
  const normalized = normalizeCode(token);
  const entry = takeoverTokens.get(normalized);
  takeoverTokens.delete(normalized);
  return !!entry && entry.expiresAt > Date.now();
}
