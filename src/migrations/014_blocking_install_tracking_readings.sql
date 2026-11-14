-- v4 migration (optional - the server applies all of this automatically at start-up through
-- config/schema.bootstrap.js). Run by hand only if you prefer; skip any line whose column already exists.

ALTER TABLE tenants ADD COLUMN is_blocked TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN block_reason VARCHAR(500) NULL;
ALTER TABLE tenants ADD COLUMN blocked_at DATETIME NULL;
ALTER TABLE tenants ADD COLUMN blocked_by INT NULL;

ALTER TABLE tenant_devices ADD COLUMN last_seen_at DATETIME NULL;
ALTER TABLE tenant_devices ADD COLUMN last_opened_at DATETIME NULL;
ALTER TABLE tenant_devices ADD COLUMN app_version VARCHAR(40) NULL;
ALTER TABLE tenant_devices ADD COLUMN logged_out_at DATETIME NULL;
ALTER TABLE tenant_devices ADD COLUMN uninstalled_at DATETIME NULL;
ALTER TABLE tenant_devices ADD COLUMN last_probe_at DATETIME NULL;
UPDATE tenant_devices SET last_seen_at = updated_at WHERE last_seen_at IS NULL AND is_active = 1;

CREATE TABLE IF NOT EXISTS electricity_meter_readings (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL, tenant_id INT NULL, pg_id INT NULL, room_id INT NULL,
  billing_month VARCHAR(7) NULL, meter_mode ENUM('single','dual') NOT NULL DEFAULT 'single',
  previous_reading DECIMAL(12,2) NULL, current_reading DECIMAL(12,2) NULL, units DECIMAL(12,2) NULL,
  inverter_previous_reading DECIMAL(12,2) NULL, inverter_current_reading DECIMAL(12,2) NULL, inverter_units DECIMAL(12,2) NULL,
  amount DECIMAL(10,2) NULL, recorded_by INT NULL, recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL, deleted_by INT NULL,
  UNIQUE KEY uq_emr_bill (bill_id), KEY idx_emr_tenant (tenant_id), KEY idx_emr_pg (pg_id), KEY idx_emr_room (room_id), KEY idx_emr_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
