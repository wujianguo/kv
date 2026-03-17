/**
 * Cloudflare Worker – Key-Value Storage Service
 *
 * Endpoints (all require  Authorization: Bearer <API_TOKEN>):
 *   PUT    /v1/kv/{key}   – upsert a key/value pair (supports TTL)
 *   GET    /v1/kv/{key}   – retrieve a value (404 if missing / expired)
 *   DELETE /v1/kv/{key}   – delete a key (204, idempotent)
 *   HEAD   /v1/kv/{key}   – check existence (200 / 404, no body)
 *
 * A scheduled handler runs on the configured cron schedule and deletes
 * all rows whose expire_at has passed.
 */

export interface Env {
  DB: D1Database;
  API_TOKEN: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_KEY_BYTES = 256;
const MAX_VALUE_BYTES = 65536; // 64 KiB
const ROUTE_PREFIX = "/v1/kv/";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    // Still iterate to avoid short-circuit timing leak.
    let diff = 1;
    for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ (bBytes[i % bBytes.length] ?? 0);
    return diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

/** Verify the Authorization header and return false on failure. */
function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return safeEqual(match[1], env.API_TOKEN);
}

/** Parse and validate the key from a URL pathname like /v1/kv/{key}. */
function parseKey(pathname: string): { key: string } | { error: string; status: number } {
  const encoded = pathname.slice(ROUTE_PREFIX.length);
  if (!encoded) return { error: "key is required", status: 400 };

  let key: string;
  try {
    key = decodeURIComponent(encoded);
  } catch {
    return { error: "invalid key encoding", status: 400 };
  }

  const keyBytes = new TextEncoder().encode(key).length;
  if (keyBytes > MAX_KEY_BYTES) {
    return { error: `key exceeds maximum length of ${MAX_KEY_BYTES} bytes`, status: 400 };
  }
  return { key };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handlePut(request: Request, env: Env, key: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("request body must be valid JSON", 400);
  }

  if (!("value" in body)) {
    return errorResponse("missing required field: value", 400);
  }

  // Serialise value to a string for storage.
  const raw = body["value"];
  const storedValue = typeof raw === "string" ? raw : JSON.stringify(raw);

  // Check value size.
  const valueBytes = new TextEncoder().encode(storedValue).length;
  if (valueBytes > MAX_VALUE_BYTES) {
    return errorResponse(`value exceeds maximum size of ${MAX_VALUE_BYTES} bytes`, 413);
  }

  const now = Date.now();

  // Resolve expire_at.
  const hasTtl = "ttl_seconds" in body;
  const hasExpireAt = "expire_at" in body;

  if (hasTtl && hasExpireAt) {
    return errorResponse("provide either ttl_seconds or expire_at, not both", 400);
  }

  let expireAt: number | null = null;

  if (hasExpireAt) {
    const ea = body["expire_at"];
    if (typeof ea !== "number" || !Number.isInteger(ea) || ea <= 0) {
      return errorResponse("expire_at must be a positive integer (Unix milliseconds)", 400);
    }
    expireAt = ea;
  } else if (hasTtl) {
    const ttl = body["ttl_seconds"];
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) {
      return errorResponse("ttl_seconds must be a positive integer", 400);
    }
    expireAt = now + ttl * 1000;
  }

  await env.DB.prepare(
    `INSERT INTO kv_store (k, v, created_at, updated_at, expire_at)
     VALUES (?1, ?2, ?3, ?3, ?4)
     ON CONFLICT(k) DO UPDATE SET
       v          = excluded.v,
       updated_at = excluded.updated_at,
       expire_at  = excluded.expire_at`
  )
    .bind(key, storedValue, now, expireAt)
    .run();

  return jsonResponse({ key, expire_at: expireAt, updated_at: now });
}

async function handleGet(_request: Request, env: Env, key: string): Promise<Response> {
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT v, expire_at FROM kv_store WHERE k = ?1 LIMIT 1`
  )
    .bind(key)
    .first<{ v: string; expire_at: number | null }>();

  if (!row) {
    return errorResponse("not_found", 404);
  }

  // Treat expired rows as not found.
  if (row.expire_at !== null && row.expire_at <= now) {
    return errorResponse("not_found", 404);
  }

  const ttlSecondsRemaining =
    row.expire_at !== null ? Math.max(0, Math.ceil((row.expire_at - now) / 1000)) : null;

  return jsonResponse({
    key,
    value: row.v,
    expire_at: row.expire_at ?? null,
    ttl_seconds_remaining: ttlSecondsRemaining,
  });
}

async function handleDelete(_request: Request, env: Env, key: string): Promise<Response> {
  await env.DB.prepare(`DELETE FROM kv_store WHERE k = ?1`).bind(key).run();
  return new Response(null, { status: 204 });
}

async function handleHead(_request: Request, env: Env, key: string): Promise<Response> {
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT expire_at FROM kv_store WHERE k = ?1 LIMIT 1`
  )
    .bind(key)
    .first<{ expire_at: number | null }>();

  if (!row || (row.expire_at !== null && row.expire_at <= now)) {
    return new Response(null, { status: 404 });
  }

  return new Response(null, { status: 200 });
}

// ─── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Authentication
    if (!isAuthorized(request, env)) {
      return errorResponse("unauthorized", 401);
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // Route must start with /v1/kv/
    if (!pathname.startsWith(ROUTE_PREFIX) || pathname.length <= ROUTE_PREFIX.length) {
      return errorResponse("not_found", 404);
    }

    const parsed = parseKey(pathname);
    if ("error" in parsed) {
      return errorResponse(parsed.error, parsed.status);
    }
    const { key } = parsed;

    switch (request.method) {
      case "PUT":
        return handlePut(request, env, key);
      case "GET":
        return handleGet(request, env, key);
      case "DELETE":
        return handleDelete(request, env, key);
      case "HEAD":
        return handleHead(request, env, key);
      default:
        return errorResponse("method not allowed", 405);
    }
  },

  /** Scheduled handler: delete all expired rows. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    // Delete in batches to avoid overwhelming D1 on large datasets.
    const BATCH_SIZE = 1000;
    for (let i = 0; i < 20; i++) {
      const result = await env.DB.prepare(
        `DELETE FROM kv_store WHERE rowid IN (
           SELECT rowid FROM kv_store
           WHERE expire_at IS NOT NULL AND expire_at <= ?1
           LIMIT ?2
         )`
      )
        .bind(now, BATCH_SIZE)
        .run();

      if ((result.meta.changes ?? 0) < BATCH_SIZE) break;
    }
  },
} satisfies ExportedHandler<Env>;
