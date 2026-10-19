-- Replit diffs the live development catalog. Every epoch FK must reference a
-- primary key, even if it emits FKs before new UNIQUE constraints/indexes.
-- One statement/transaction locks writers through validation and replacement.
DO $migration$
DECLARE item record;
BEGIN
  LOCK TABLE grid_bots,grid_epochs,grid_levels,grid_operations,grid_exact_fills,grid_control_requests,grid_auto_resume IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM grid_epochs e JOIN grid_control_requests r ON r.id=e.creating_control_request_id WHERE e.bot_id<>r.bot_id)
    OR EXISTS (SELECT 1 FROM grid_epochs e JOIN grid_epochs p ON p.id=e.predecessor_id WHERE e.bot_id<>p.bot_id)
    OR EXISTS (SELECT 1 FROM grid_bots b JOIN grid_epochs e ON e.id=b.active_epoch_id WHERE b.id<>e.bot_id)
    OR EXISTS (SELECT 1 FROM grid_levels l JOIN grid_epochs e ON e.id=l.epoch_id WHERE l.bot_id<>e.bot_id)
    OR EXISTS (SELECT 1 FROM grid_operations o JOIN grid_epochs e ON e.id=o.epoch_id WHERE o.bot_id<>e.bot_id)
    OR EXISTS (SELECT 1 FROM grid_operations o JOIN grid_levels l ON l.id=o.level_id WHERE o.epoch_id IS NOT NULL AND (o.bot_id<>l.bot_id OR o.epoch_id IS DISTINCT FROM l.epoch_id))
    OR EXISTS (SELECT 1 FROM grid_exact_fills f JOIN grid_operations o ON o.id=f.operation_id WHERE f.epoch_id IS NOT NULL AND (f.bot_id<>o.bot_id OR f.epoch_id IS DISTINCT FROM o.epoch_id))
    OR EXISTS (SELECT 1 FROM grid_control_requests r JOIN grid_epochs e ON e.id=r.origin_epoch_id WHERE r.bot_id<>e.bot_id)
    OR EXISTS (SELECT 1 FROM grid_auto_resume a JOIN grid_epochs e ON e.id=a.armed_epoch_id WHERE a.bot_id<>e.bot_id)
  THEN RAISE EXCEPTION 'Grid epoch scope mismatch during publish migration'; END IF;
  FOR item IN SELECT * FROM (VALUES
    ('grid_epochs','grid_epochs_control_request_fk','creating_control_request_id','grid_control_requests'),
    ('grid_epochs','grid_epochs_predecessor_fk','predecessor_id','grid_epochs'),
    ('grid_bots','grid_bots_active_epoch_fk','active_epoch_id','grid_epochs'),
    ('grid_levels','grid_levels_epoch_fk','epoch_id','grid_epochs'),
    ('grid_operations','grid_operations_epoch_fk','epoch_id','grid_epochs'),
    ('grid_operations','grid_operations_level_epoch_fk','level_id','grid_levels'),
    ('grid_exact_fills','grid_exact_fills_operation_epoch_fk','operation_id','grid_operations'),
    ('grid_control_requests','grid_control_origin_epoch_fk','origin_epoch_id','grid_epochs'),
    ('grid_auto_resume','grid_auto_resume_epoch_fk','armed_epoch_id','grid_epochs')
  ) AS f(table_name,constraint_name,column_name,parent_table)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=item.table_name::regclass AND conname=item.constraint_name
      AND (contype<>'f' OR cardinality(conkey)<>1 OR confrelid<>item.parent_table::regclass
        OR conkey<>ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=item.table_name::regclass AND attname=item.column_name)]::smallint[]
        OR confkey<>ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=item.parent_table::regclass AND attname='id')]::smallint[])) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',item.table_name,item.constraint_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=item.table_name::regclass AND conname=item.constraint_name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id)',item.table_name,item.constraint_name,item.column_name,item.parent_table);
    END IF;
  END LOOP;

  -- Parents cannot be reassigned to another bot after a child was checked.
  -- SHARE locks also serialize validation against legacy NULL-epoch backfills.
  CREATE OR REPLACE FUNCTION grid_validate_epoch_scope() RETURNS trigger LANGUAGE plpgsql AS $scope$
  DECLARE owner_id uuid; scoped_epoch uuid;
  BEGIN
    IF TG_TABLE_NAME='grid_bots' THEN
      IF TG_OP='UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Grid scope identity is immutable'; END IF;
      END IF;
      owner_id:=NEW.id; scoped_epoch:=NEW.active_epoch_id;
    ELSE
      owner_id:=NEW.bot_id;
      IF TG_OP='UPDATE' THEN
        IF NEW.bot_id IS DISTINCT FROM OLD.bot_id THEN RAISE EXCEPTION 'Grid scope identity is immutable'; END IF;
        IF TG_TABLE_NAME='grid_control_requests' THEN
          IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Grid scope identity is immutable'; END IF;
        END IF;
      END IF;
      IF TG_TABLE_NAME='grid_epochs' THEN
        scoped_epoch:=NEW.predecessor_id;
        IF NEW.creating_control_request_id IS NOT NULL THEN
          PERFORM 1 FROM grid_control_requests WHERE id=NEW.creating_control_request_id AND bot_id=owner_id FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
        END IF;
      ELSIF TG_TABLE_NAME='grid_control_requests' THEN scoped_epoch:=NEW.origin_epoch_id;
      ELSE scoped_epoch:=NEW.armed_epoch_id;
      END IF;
    END IF;
    IF scoped_epoch IS NOT NULL THEN
      PERFORM 1 FROM grid_epochs WHERE id=scoped_epoch AND bot_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
    END IF;
    RETURN NEW;
  END $scope$;

  CREATE OR REPLACE FUNCTION grid_assign_epoch() RETURNS trigger LANGUAGE plpgsql AS $assign$
  DECLARE expected uuid;
  BEGIN
    IF TG_OP='UPDATE' THEN
      IF NEW.bot_id IS DISTINCT FROM OLD.bot_id THEN RAISE EXCEPTION 'Grid scope identity is immutable'; END IF;
      IF TG_TABLE_NAME<>'grid_exact_fills' THEN
        IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Grid scope identity is immutable'; END IF;
      END IF;
      IF OLD.epoch_id IS NOT NULL AND NEW.epoch_id IS DISTINCT FROM OLD.epoch_id THEN RAISE EXCEPTION 'Grid epoch identity is immutable'; END IF;
      expected:=OLD.epoch_id;
    END IF;
    IF TG_TABLE_NAME='grid_exact_fills' THEN
      SELECT epoch_id INTO expected FROM grid_operations WHERE id=NEW.operation_id AND bot_id=NEW.bot_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
    ELSIF TG_TABLE_NAME='grid_operations' THEN
      IF NEW.level_id IS NOT NULL THEN
        SELECT epoch_id INTO expected FROM grid_levels WHERE id=NEW.level_id AND bot_id=NEW.bot_id FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
      ELSIF expected IS NULL THEN
        SELECT active_epoch_id INTO expected FROM grid_bots WHERE id=NEW.bot_id FOR SHARE;
      END IF;
    ELSIF expected IS NULL THEN
      SELECT active_epoch_id INTO expected FROM grid_bots WHERE id=NEW.bot_id FOR SHARE;
    END IF;
    IF NEW.epoch_id IS NULL THEN NEW.epoch_id:=expected;
    ELSIF NEW.epoch_id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
    IF NEW.epoch_id IS NOT NULL THEN
      PERFORM 1 FROM grid_epochs WHERE id=NEW.epoch_id AND bot_id=NEW.bot_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Grid epoch scope mismatch'; END IF;
    END IF;
    RETURN NEW;
  END $assign$;

  -- Replace individually so a partial installation is repaired on the next boot.
  DROP TRIGGER IF EXISTS grid_epochs_validate_scope ON grid_epochs;
  CREATE TRIGGER grid_epochs_validate_scope BEFORE INSERT ON grid_epochs FOR EACH ROW EXECUTE FUNCTION grid_validate_epoch_scope();
  DROP TRIGGER IF EXISTS grid_bots_validate_scope ON grid_bots;
  CREATE TRIGGER grid_bots_validate_scope BEFORE INSERT OR UPDATE ON grid_bots FOR EACH ROW EXECUTE FUNCTION grid_validate_epoch_scope();
  DROP TRIGGER IF EXISTS grid_control_validate_scope ON grid_control_requests;
  CREATE TRIGGER grid_control_validate_scope BEFORE INSERT OR UPDATE ON grid_control_requests FOR EACH ROW EXECUTE FUNCTION grid_validate_epoch_scope();
  DROP TRIGGER IF EXISTS grid_auto_resume_validate_scope ON grid_auto_resume;
  CREATE TRIGGER grid_auto_resume_validate_scope BEFORE INSERT OR UPDATE ON grid_auto_resume FOR EACH ROW EXECUTE FUNCTION grid_validate_epoch_scope();
  DROP TRIGGER IF EXISTS grid_levels_assign_epoch ON grid_levels;
  CREATE TRIGGER grid_levels_assign_epoch BEFORE INSERT OR UPDATE ON grid_levels FOR EACH ROW EXECUTE FUNCTION grid_assign_epoch();
  DROP TRIGGER IF EXISTS grid_operations_assign_epoch ON grid_operations;
  CREATE TRIGGER grid_operations_assign_epoch BEFORE INSERT OR UPDATE ON grid_operations FOR EACH ROW EXECUTE FUNCTION grid_assign_epoch();
  DROP TRIGGER IF EXISTS grid_fills_assign_epoch ON grid_exact_fills;
  CREATE TRIGGER grid_fills_assign_epoch BEFORE INSERT OR UPDATE ON grid_exact_fills FOR EACH ROW EXECUTE FUNCTION grid_assign_epoch();
END $migration$;
