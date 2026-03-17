# kv

A Key-Value storage service built on **Cloudflare Workers** + **Cloudflare D1**.

## Features

- **PUT / GET / DELETE / HEAD** endpoints under `/v1/kv/{key}`
- Single global token authentication (`API_TOKEN` environment variable)
- Optional TTL per key (`ttl_seconds` or absolute `expire_at`)
- Automatic expiry cleanup via a Workers Cron trigger (every 10 days by default)
- Key ≤ 256 bytes, value ≤ 64 KiB (UTF-8)

---

## Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18 and [npm](https://www.npmjs.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3
- A Cloudflare account with Workers and D1 enabled

### 2. Install dependencies

```bash
npm install
```

### 3. Create the D1 database

```bash
wrangler d1 create kv-store
```

Copy the `database_id` printed to the console and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding      = "DB"
database_name = "kv-store"
database_id  = "<paste-your-id-here>"
```

### 4. Run the migration

```bash
# Against local dev database
wrangler d1 execute kv-store --local --file migrations/0001_init.sql

# Against production D1
wrangler d1 execute kv-store --remote --file migrations/0001_init.sql
```

### 5. Set the API token secret

```bash
wrangler secret put API_TOKEN
# Enter your secret token at the prompt.
```

### 6. Run locally

```bash
npm run dev
```

### 7. Deploy

```bash
npm run deploy
```

---

## Authentication

Every request must include:

```
Authorization: Bearer <your-token>
```

An invalid or missing token returns **401 Unauthorized**:

```json
{ "error": "unauthorized" }
```

---

## API Reference

Base URL: `https://<your-worker>.workers.dev`  
All endpoints require the `Authorization` header above.

### PUT `/v1/kv/{key}` – Upsert a key

| Field | Type | Required | Description |
|---|---|---|---|
| `value` | string \| any JSON | ✅ | The value to store. Strings are stored as-is; other JSON values are `JSON.stringify`'d. |
| `ttl_seconds` | integer > 0 | ❌ | Expire after N seconds from now. |
| `expire_at` | integer > 0 | ❌ | Absolute expiry as Unix milliseconds. |

> Provide **at most one** of `ttl_seconds` / `expire_at`. Sending both returns 400.

**Request**

```bash
curl -X PUT https://<worker>/v1/kv/hello \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "world", "ttl_seconds": 3600}'
```

**Response 200**

```json
{
  "key": "hello",
  "expire_at": 1770003600000,
  "updated_at": 1770000000000
}
```

---

### GET `/v1/kv/{key}` – Retrieve a value

**Request**

```bash
curl https://<worker>/v1/kv/hello \
  -H "Authorization: Bearer $TOKEN"
```

**Response 200**

```json
{
  "key": "hello",
  "value": "world",
  "expire_at": 1770003600000,
  "ttl_seconds_remaining": 3598
}
```

- `expire_at` and `ttl_seconds_remaining` are `null` for keys with no expiry.
- Returns **404** if the key does not exist or has expired.

---

### DELETE `/v1/kv/{key}` – Delete a key

```bash
curl -X DELETE https://<worker>/v1/kv/hello \
  -H "Authorization: Bearer $TOKEN"
```

Returns **204 No Content** (idempotent – also 204 if the key did not exist).

---

### HEAD `/v1/kv/{key}` – Check existence

```bash
curl -I https://<worker>/v1/kv/hello \
  -H "Authorization: Bearer $TOKEN"
```

- **200** – key exists and has not expired  
- **404** – key does not exist or has expired  
- No response body.

---

## TTL / Expiry Examples

```bash
# Expire in 60 seconds
curl -X PUT .../v1/kv/temp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "short-lived", "ttl_seconds": 60}'

# Expire at an absolute Unix-ms timestamp
curl -X PUT .../v1/kv/temp2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "also short-lived", "expire_at": 1800000000000}'

# No expiry (permanent)
curl -X PUT .../v1/kv/perm \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "lives forever"}'
```

---

## Error Codes

| HTTP Status | `error` field | Meaning |
|---|---|---|
| 400 | `bad_request` / message | Invalid request (key too long, value too large, bad TTL, …) |
| 401 | `unauthorized` | Missing or invalid `Authorization` header |
| 404 | `not_found` | Key does not exist or has expired |
| 405 | `method not allowed` | Unsupported HTTP method |
| 413 | (message) | Value exceeds 64 KiB |

---

## Cron / Scheduled Cleanup

Expired rows are deleted by a scheduled Workers handler. The default cron is
`0 0 */10 * *` (every 10 days). Change it in `wrangler.toml`:

```toml
[triggers]
crons = ["0 0 */10 * *"]
```

The cleanup runs in batches of 1000 rows (up to 20 batches per invocation) to
avoid D1 timeout on large datasets.

---

## Local Development

```bash
npm run dev           # starts a local dev server with hot-reload
```

The dev server uses a local SQLite file for D1. Run the migration first:

```bash
wrangler d1 execute kv-store --local --file migrations/0001_init.sql
```

You can pass `API_TOKEN` for local testing via a `.dev.vars` file (never commit this):

```
# .dev.vars
API_TOKEN=my-local-secret
```
