BEGIN;
-- Story 20.1 (AD-99, FR-136..138): the immutable audit log of the app.
--
-- The whole file is ONE transaction (`BEGIN;` on the first line, Prisma does not
-- wrap migration.sql, docs/deployment.md 12.3): if any statement fails nothing is
-- left behind. It only creates NEW tables, so it takes no lock on a hot table and
-- needs no lock_timeout; the next migration, which does touch existing tables,
-- sets one.
--
-- Written so it can also run inside a sandbox schema (the e2e apply it with
-- `search_path = audit_t_<rand>, public`): no object is schema-qualified.

CREATE TABLE "Audit_Events" (
    -- Gapless sequence assigned by AuditService under the chain-head lock (NOT a
    -- Postgres sequence, which can leave holes on rollback).
    "seq"         BIGINT        NOT NULL,
    "occurredAt"  TIMESTAMPTZ(3) NOT NULL,
    "actorType"   VARCHAR(16)   NOT NULL,
    "actorId"     UUID,
    "action"      VARCHAR(64)   NOT NULL,
    "entityType"  VARCHAR(64)   NOT NULL,
    "entityId"    VARCHAR(128)  NOT NULL,
    "before"      JSONB,
    "after"       JSONB,
    "reason"      VARCHAR(500),
    "requestId"   UUID,
    "ip"          INET,
    "hashVersion" SMALLINT      NOT NULL DEFAULT 1,
    "prevHash"    CHAR(64)      NOT NULL,
    "hash"        CHAR(64)      NOT NULL,

    CONSTRAINT "Audit_Events_pkey" PRIMARY KEY ("seq"),
    CONSTRAINT "Audit_Events_seq_chk" CHECK ("seq" >= 1),
    CONSTRAINT "Audit_Events_actorType_chk" CHECK ("actorType" IN ('ADMIN', 'SYSTEM', 'CUSTOMER', 'ANON')),
    CONSTRAINT "Audit_Events_action_chk" CHECK ("action" ~ '^[A-Z0-9_]+$'),
    CONSTRAINT "Audit_Events_hashVersion_chk" CHECK ("hashVersion" = 1),
    CONSTRAINT "Audit_Events_prevHash_chk" CHECK ("prevHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "Audit_Events_hash_chk" CHECK ("hash" ~ '^[0-9a-f]{64}$')
    -- No foreign key to any business table: deleting or anonymizing an account
    -- must never delete an event.
);

CREATE UNIQUE INDEX "Audit_Events_hash_key" ON "Audit_Events"("hash");
CREATE INDEX "Audit_Events_occurredAt_idx" ON "Audit_Events"("occurredAt");
CREATE INDEX "Audit_Events_action_seq_idx" ON "Audit_Events"("action", "seq");
CREATE INDEX "Audit_Events_actorId_seq_idx" ON "Audit_Events"("actorId", "seq");
CREATE INDEX "Audit_Events_entityType_entityId_seq_idx" ON "Audit_Events"("entityType", "entityId", "seq");

-- Operational record of each chain verification (A105). Unlike "Audit_Events" it
-- admits UPDATE (a verification is written when it finishes); it is not evidence.
CREATE TABLE "Audit_Verifications" (
    "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
    "startedAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"   TIMESTAMPTZ(3),
    "mode"         VARCHAR(16)   NOT NULL,
    "source"       VARCHAR(16)   NOT NULL DEFAULT 'MANUAL',
    "fromSeq"      BIGINT        NOT NULL,
    -- Last row examined. headSeq/headHash = that same row (seq and hash found
    -- when it was verified): the next incremental run starts right after it and
    -- demands its hash is still the same.
    "toSeq"        BIGINT        NOT NULL,
    "rows"         INTEGER       NOT NULL DEFAULT 0,
    "result"       VARCHAR(8)    NOT NULL,
    "brokenSeq"    BIGINT,
    "expectedHash" CHAR(64),
    "foundHash"    CHAR(64),
    "headSeq"      BIGINT        NOT NULL,
    "headHash"     CHAR(64)      NOT NULL,

    CONSTRAINT "Audit_Verifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Audit_Verifications_mode_chk" CHECK ("mode" IN ('incremental', 'full')),
    CONSTRAINT "Audit_Verifications_result_chk" CHECK ("result" IN ('OK', 'BROKEN'))
);

CREATE INDEX "Audit_Verifications_startedAt_idx" ON "Audit_Verifications"("startedAt");

-- ─── Immutability in the database (NFR-20.2) ──────────────────────────────
-- Same style as the legal triggers (AD-88): SQLSTATE 23000.
CREATE FUNCTION "audit_events_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit_Events is immutable: % rejected', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "audit_events_no_update_delete" BEFORE UPDATE OR DELETE ON "Audit_Events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_immutable"();
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "Audit_Events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_immutable"();

-- Linearity of the chain, also enforced by the database: an insert must be the
-- next seq and carry the previous row's hash as prevHash (the genesis row: seq 1
-- and 64 zeros). AuditService already holds the chain-head lock when it inserts,
-- so this is the safety net against a fork written by a bug or a bypass.
CREATE FUNCTION "audit_events_chain_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash char(64);
BEGIN
  SELECT "seq", "hash" INTO last_seq, last_hash FROM "Audit_Events" ORDER BY "seq" DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW."seq" <> 1 OR NEW."prevHash" <> repeat('0', 64) THEN
      RAISE EXCEPTION 'Audit_Events chain must start at seq 1 with the genesis prevHash'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."seq" <> last_seq + 1 OR NEW."prevHash" <> last_hash THEN
    RAISE EXCEPTION 'Audit_Events chain fork or gap rejected (expected seq % after %)', last_seq + 1, last_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_events_chain_guard" BEFORE INSERT ON "Audit_Events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_chain_guard"();

-- ─── Privileges ───────────────────────────────────────────────────────────
-- Every non-superuser role that is not the owner loses UPDATE/DELETE/TRUNCATE on
-- the events (it does not need to know the name of the app role), and PUBLIC loses
-- everything. A role created LATER (scripts/db-roles.sql) is handled there.
-- Without DDL privileges nobody can drop the triggers (DISABLE TRIGGER needs ownership).
DO $$
DECLARE
  owner_name text;
  r record;
BEGIN
  SELECT pg_get_userbyid("relowner") INTO owner_name FROM pg_class WHERE "oid" = '"Audit_Events"'::regclass;
  FOR r IN
    SELECT "rolname" FROM pg_roles
     WHERE NOT "rolsuper" AND "rolname" <> owner_name AND "rolname" !~ '^pg_'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "Audit_Events" FROM %I', r."rolname");
  END LOOP;
  REVOKE ALL ON "Audit_Events" FROM PUBLIC;
END
$$;

COMMIT;
