# TWINS Gate R0B Plan & Preparation Guide

**Scope (from 11_ROADMAP_AND_BACKLOG.md):**
- Reproducible local/staging service topology (compose/CI)
- Runtime/service integration verification (real PostgreSQL/Redis)
- CI/build checks
- Staging smoke-test preparation
- Backup/restore evidence where authorized

---

## 1. Analysis of Existing Integration Configuration

1. **Database Requirements:**
   - Image: `postgres:16-alpine`
   - Port: `15432` mapped to container `5432`
   - Credentials:
     - User: `twins`
     - Password: `twins_dev_password`
     - Database: `twins_dev`
   - URL: `postgresql://twins:twins_dev_password@127.0.0.1:15432/twins_dev`
   - Pre-condition: Phase 2 migrations applied via `npm run db:push` or `npm run db:generate`.
2. **Queue Requirements (BullMQ):**
   - Image: `redis:7-alpine`
   - Port: `6379` mapped to container `6379`
   - URL: `redis://127.0.0.1:6379`
3. **Environment & Sandbox Analysis:**
   - In sandboxed shell mode, `connect EPERM ::1:15432` and `permission denied unix:///Users/sara/.docker/run/docker.sock` occur because standard sandbox isolation forbids host socket access and arbitrary loopback binding without authorization.
   - When running on macOS, `localhost` resolves to IPv6 `::1` before IPv4 `127.0.0.1`. Using `127.0.0.1` explicitly avoids dual-stack resolution ambiguities, but the underlying docker container must be running and network access authorized.

---

## 2. Proposed Local Test Topology (Docker Compose)

The proposed configuration specifies isolated, disposable test services without altering any existing production or shared configurations:

```yaml
version: "3.8"

services:
  twins-postgres-test:
    image: postgres:16-alpine
    container_name: twins-postgres-test
    environment:
      POSTGRES_USER: twins
      POSTGRES_PASSWORD: twins_dev_password
      POSTGRES_DB: twins_dev
    ports:
      - "127.0.0.1:15432:5432"
    volumes:
      - twins_postgres_test_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U twins -d twins_dev"]
      interval: 2s
      timeout: 3s
      retries: 15

  twins-redis-test:
    image: redis:7-alpine
    container_name: twins-redis-test
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - twins_redis_test_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 15

volumes:
  twins_postgres_test_data:
  twins_redis_test_data:
```

---

## 3. Real-Service Runtime Tests Planned for R0B

In addition to running the existing 19 database integration test files (`tests/integration/**/*.test.ts`), R0B will introduce true end-to-end runtime integration tests (`tests/integration/runtime/e2ePipeline.test.ts`):

1. **Synthetic Webhook Acceptance & Verification:**
   - POST to `/webhooks/telegram` with valid secret header.
   - Verify `202 Accepted` response.
2. **Queue Dispatch & Worker Consumption:**
   - Verify job enqueued in BullMQ `signal_queue`.
   - Worker picks up job and runs `processTelegramJob`.
3. **PostgreSQL Persistence:**
   - Verify `telegram_messages` row inserted.
   - Verify `signals` row created.
   - Verify `signal_validations` row created with deterministic outcome (`APPROVE`, `REJECT`, or `INSUFFICIENT_EVIDENCE`).
4. **Idempotency & Deduplication:**
   - Deliver duplicate webhook payload with identical `update_id` / message ID.
   - Verify rejected or deduplicated without duplicate validation rows.
5. **Worker Shutdown & Pool Drain:**
   - Execute graceful shutdown and verify pool drained cleanly.

---

## 4. Execution Commands Requiring Operator Authorization

To execute real-service verification in Gate R0B:

1. **Start Disposable Test Topology:**
   ```bash
   docker compose -f infrastructure/docker/docker-compose.test.yml up -d
   ```
2. **Apply Migrations to Test DB:**
   ```bash
   DATABASE_URL=postgresql://twins:twins_dev_password@127.0.0.1:15432/twins_dev npm run --workspace=@twins/database db:push
   ```
3. **Execute Integration Suite:**
   ```bash
   DATABASE_URL=postgresql://twins:twins_dev_password@127.0.0.1:15432/twins_dev REDIS_URL=redis://127.0.0.1:6379 npm run test:integration
   ```
4. **Tear Down Test Topology:**
   ```bash
   docker compose -f infrastructure/docker/docker-compose.test.yml down -v
   ```

