CREATE UNIQUE INDEX IF NOT EXISTS grid_control_requests_bot_identity_unique ON grid_control_requests(bot_id,id);
CREATE TABLE IF NOT EXISTS grid_epochs (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES grid_bots(id),
  ordinal integer NOT NULL,
  predecessor_id uuid,
  creating_control_request_id uuid,
  policy_version text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  policy_hmac text NOT NULL,
  carry_snapshot jsonb NOT NULL,
  carry_digest text,
  confirmation jsonb NOT NULL,
  reason text NOT NULL,
  activated_at timestamptz NOT NULL,
  direction text NOT NULL,
  lower_price numeric(30,8) NOT NULL,
  upper_price numeric(30,8) NOT NULL,
  stop_loss_price numeric(30,8) NOT NULL,
  grid_count integer NOT NULL,
  CONSTRAINT grid_epochs_bot_id_unique UNIQUE (bot_id,id),
  CONSTRAINT grid_epochs_ordinal_unique UNIQUE (bot_id,ordinal),
  CONSTRAINT grid_epochs_successor_unique UNIQUE (predecessor_id),
  CONSTRAINT grid_epochs_request_unique UNIQUE (creating_control_request_id),
  CONSTRAINT grid_epochs_control_request_fk FOREIGN KEY (bot_id,creating_control_request_id) REFERENCES grid_control_requests(bot_id,id),
  CONSTRAINT grid_epochs_predecessor_fk FOREIGN KEY (bot_id,predecessor_id) REFERENCES grid_epochs(bot_id,id),
  CONSTRAINT grid_epochs_origin_check CHECK ((ordinal=1 AND predecessor_id IS NULL AND creating_control_request_id IS NULL AND carry_digest IS NULL) OR (ordinal>1 AND predecessor_id IS NOT NULL AND creating_control_request_id IS NOT NULL AND carry_digest IS NOT NULL)),
  CONSTRAINT grid_epochs_geometry_check CHECK (lower_price>0 AND upper_price>lower_price AND stop_loss_price>0 AND grid_count BETWEEN 1 AND 100),
  CONSTRAINT grid_epochs_stop_check CHECK ((direction='long' AND stop_loss_price<lower_price) OR (direction='short' AND stop_loss_price>upper_price)),
  CONSTRAINT grid_epochs_authority_check CHECK (jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(carry_snapshot)='object' AND jsonb_typeof(confirmation)='object' AND policy_hmac ~ '^[0-9a-f]{64}$' AND (carry_digest IS NULL OR carry_digest ~ '^[0-9a-f]{64}$'))
);
CREATE TABLE IF NOT EXISTS grid_trailing (
  bot_id uuid PRIMARY KEY REFERENCES grid_bots(id),
  mode text NOT NULL DEFAULT 'off',
  generation bigint NOT NULL DEFAULT 0,
  policy_revision text NOT NULL DEFAULT 'manual-dow-1',
  cooldown_ms bigint NOT NULL DEFAULT 3600000,
  daily_limit integer NOT NULL DEFAULT 3,
  lifetime_limit integer NOT NULL DEFAULT 10,
  max_widths integer NOT NULL DEFAULT 1,
  last_closed_candle bigint,
  last_source text,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT grid_trailing_mode_check CHECK (mode IN ('off','ask','automatic') AND generation>=0),
  CONSTRAINT grid_trailing_limits_check CHECK (cooldown_ms>=3600000 AND daily_limit BETWEEN 1 AND 3 AND lifetime_limit BETWEEN 1 AND 10 AND max_widths=1 AND attempts BETWEEN 0 AND 3),
  CONSTRAINT grid_trailing_watermark_check CHECK ((last_closed_candle IS NULL AND last_source IS NULL) OR (last_closed_candle IS NOT NULL AND last_closed_candle>=0 AND last_source IS NOT NULL))
);
ALTER TABLE grid_bots ADD COLUMN IF NOT EXISTS active_epoch_id uuid;
ALTER TABLE grid_levels ADD COLUMN IF NOT EXISTS epoch_id uuid;
ALTER TABLE grid_operations ADD COLUMN IF NOT EXISTS epoch_id uuid;
ALTER TABLE grid_exact_fills ADD COLUMN IF NOT EXISTS epoch_id uuid;
ALTER TABLE grid_control_requests ADD COLUMN IF NOT EXISTS origin_epoch_id uuid;
ALTER TABLE grid_auto_resume ADD COLUMN IF NOT EXISTS armed_epoch_id uuid;
-- Deterministic legacy identity. Never mint a signature or guess missing geometry.
INSERT INTO grid_epochs(id,bot_id,ordinal,policy_version,policy_snapshot,policy_hmac,carry_snapshot,confirmation,reason,activated_at,direction,lower_price,upper_price,stop_loss_price,grid_count)
SELECT md5('grid-epoch-1:'||b.id::text)::uuid,b.id,1,b.policy_version,
  jsonb_build_object('legacyBot',to_jsonb(b)||jsonb_build_object('lower_price',b.lower_price::numeric(30,8)::text,'upper_price',b.upper_price::numeric(30,8)::text,'start_price',b.start_price::numeric(30,8)::text,'total_investment',b.total_investment::numeric(30,2)::text,'stop_loss_percent',b.stop_loss_percent::numeric(20,4)::text,'stop_loss_price',b.stop_loss_price::numeric(30,8)::text),
    'legacyLevels',(SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('price',l.price::numeric(30,8)::text,'size',l.size::numeric(30,8)::text) ORDER BY ordinal) FROM grid_levels l WHERE l.bot_id=b.id)),
  b.policy_hmac,'{}'::jsonb,'{}'::jsonb,'original',b.created_at,b.direction,b.lower_price,b.upper_price,b.stop_loss_price,b.grid_count
FROM grid_bots b WHERE b.active_epoch_id IS NULL AND b.policy_hmac ~ '^[0-9a-f]{64}$'
  AND b.policy_version IN ('1.0.0','2.0.0','2.2.0') AND b.runtime_policy_version=b.policy_version
  AND b.lower_price>0 AND b.start_price>b.lower_price AND b.start_price<b.upper_price AND b.grid_count BETWEEN 1 AND 100
  AND ((b.direction='long' AND b.stop_loss_price>0 AND b.stop_loss_price<b.lower_price) OR (b.direction='short' AND b.stop_loss_price>b.upper_price))
  AND (SELECT count(*) FROM grid_levels l WHERE l.bot_id=b.id)=b.grid_count+1
  AND (SELECT min(ordinal)=1 AND max(ordinal)=b.grid_count+1 AND min(price)=b.lower_price AND max(price)=b.upper_price FROM grid_levels l WHERE l.bot_id=b.id)
ON CONFLICT DO NOTHING;
UPDATE grid_bots b SET active_epoch_id=e.id FROM grid_epochs e WHERE e.bot_id=b.id AND e.ordinal=1 AND b.active_epoch_id IS NULL;
UPDATE grid_levels l SET epoch_id=b.active_epoch_id FROM grid_bots b WHERE l.bot_id=b.id AND l.epoch_id IS NULL AND b.active_epoch_id IS NOT NULL;
UPDATE grid_operations o SET epoch_id=b.active_epoch_id FROM grid_bots b WHERE o.bot_id=b.id AND o.epoch_id IS NULL AND b.active_epoch_id IS NOT NULL;
UPDATE grid_exact_fills f SET epoch_id=o.epoch_id FROM grid_operations o WHERE f.operation_id=o.id AND f.bot_id=o.bot_id AND f.epoch_id IS NULL AND o.epoch_id IS NOT NULL;
UPDATE grid_control_requests r SET origin_epoch_id=b.active_epoch_id FROM grid_bots b WHERE r.bot_id=b.id AND r.origin_epoch_id IS NULL AND b.active_epoch_id IS NOT NULL;
UPDATE grid_auto_resume a SET armed_epoch_id=b.active_epoch_id FROM grid_bots b WHERE a.bot_id=b.id AND a.armed_cycle IS NOT NULL AND a.armed_epoch_id IS NULL;
INSERT INTO grid_trailing(bot_id) SELECT id FROM grid_bots ON CONFLICT DO NOTHING;
-- Keep this name: the original startup guard checks it before replaying legacy DDL.
DROP INDEX IF EXISTS grid_levels_bot_ordinal_unique;
CREATE UNIQUE INDEX grid_levels_bot_ordinal_unique ON grid_levels(bot_id,epoch_id,ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS grid_levels_legacy_ordinal_unique ON grid_levels(bot_id,ordinal) WHERE epoch_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS grid_levels_epoch_identity_unique ON grid_levels(bot_id,epoch_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS grid_operations_epoch_identity_unique ON grid_operations(bot_id,epoch_id,id);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_bots'::regclass AND conname='grid_bots_active_epoch_fk') THEN
    ALTER TABLE grid_bots ADD CONSTRAINT grid_bots_active_epoch_fk FOREIGN KEY (id,active_epoch_id) REFERENCES grid_epochs(bot_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_levels'::regclass AND conname='grid_levels_epoch_fk') THEN
    ALTER TABLE grid_levels ADD CONSTRAINT grid_levels_epoch_fk FOREIGN KEY (bot_id,epoch_id) REFERENCES grid_epochs(bot_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_operations'::regclass AND conname='grid_operations_epoch_fk') THEN
    ALTER TABLE grid_operations ADD CONSTRAINT grid_operations_epoch_fk FOREIGN KEY (bot_id,epoch_id) REFERENCES grid_epochs(bot_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_operations'::regclass AND conname='grid_operations_level_epoch_fk') THEN
    ALTER TABLE grid_operations ADD CONSTRAINT grid_operations_level_epoch_fk FOREIGN KEY (bot_id,epoch_id,level_id) REFERENCES grid_levels(bot_id,epoch_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_exact_fills'::regclass AND conname='grid_exact_fills_operation_epoch_fk') THEN
    ALTER TABLE grid_exact_fills ADD CONSTRAINT grid_exact_fills_operation_epoch_fk FOREIGN KEY (bot_id,epoch_id,operation_id) REFERENCES grid_operations(bot_id,epoch_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_control_requests'::regclass AND conname='grid_control_origin_epoch_fk') THEN
    ALTER TABLE grid_control_requests ADD CONSTRAINT grid_control_origin_epoch_fk FOREIGN KEY (bot_id,origin_epoch_id) REFERENCES grid_epochs(bot_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='grid_auto_resume'::regclass AND conname='grid_auto_resume_epoch_fk') THEN
    ALTER TABLE grid_auto_resume ADD CONSTRAINT grid_auto_resume_epoch_fk FOREIGN KEY (bot_id,armed_epoch_id) REFERENCES grid_epochs(bot_id,id);
  END IF;
END $$;
ALTER TABLE grid_control_requests DROP CONSTRAINT IF EXISTS grid_control_action;
ALTER TABLE grid_control_requests ADD CONSTRAINT grid_control_action CHECK (action IN ('pause','resume','resync','stop','band','regrid') AND source IN ('owner','risk','auto') AND state IN ('pending','complete','superseded') AND (source<>'auto' OR action IN ('resume','regrid')) AND (action<>'regrid' OR origin_epoch_id IS NOT NULL));
CREATE OR REPLACE FUNCTION grid_epoch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Grid epochs are immutable'; END $$;
DROP TRIGGER IF EXISTS grid_epoch_immutable ON grid_epochs;
CREATE TRIGGER grid_epoch_immutable BEFORE UPDATE OR DELETE ON grid_epochs FOR EACH ROW EXECUTE FUNCTION grid_epoch_immutable();
CREATE OR REPLACE FUNCTION grid_assign_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.epoch_id IS NOT NULL AND NEW.epoch_id IS DISTINCT FROM OLD.epoch_id THEN RAISE EXCEPTION 'Grid epoch identity is immutable'; END IF;
    IF OLD.epoch_id IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='grid_exact_fills' THEN SELECT epoch_id INTO expected FROM grid_operations WHERE id=NEW.operation_id AND bot_id=NEW.bot_id;
  ELSIF TG_TABLE_NAME='grid_operations' THEN
    IF NEW.level_id IS NOT NULL THEN SELECT epoch_id INTO expected FROM grid_levels WHERE id=NEW.level_id AND bot_id=NEW.bot_id;
    ELSE SELECT active_epoch_id INTO expected FROM grid_bots WHERE id=NEW.bot_id; END IF;
  ELSE SELECT active_epoch_id INTO expected FROM grid_bots WHERE id=NEW.bot_id; END IF;
  IF NEW.epoch_id IS NULL THEN NEW.epoch_id:=expected;
  ELSIF NEW.epoch_id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grid_levels_assign_epoch ON grid_levels;
CREATE TRIGGER grid_levels_assign_epoch BEFORE INSERT OR UPDATE OF epoch_id ON grid_levels FOR EACH ROW EXECUTE FUNCTION grid_assign_epoch();
DROP TRIGGER IF EXISTS grid_operations_assign_epoch ON grid_operations;
CREATE TRIGGER grid_operations_assign_epoch BEFORE INSERT OR UPDATE OF epoch_id ON grid_operations FOR EACH ROW EXECUTE FUNCTION grid_assign_epoch();
DROP TRIGGER IF EXISTS grid_fills_assign_epoch ON grid_exact_fills;
CREATE TRIGGER grid_fills_assign_epoch BEFORE INSERT OR UPDATE OF epoch_id ON grid_exact_fills FOR EACH ROW EXECUTE FUNCTION grid_assign_epoch();
