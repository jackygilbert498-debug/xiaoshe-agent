-- Plan04 verification schema snapshot.  Runtime migration currently advances through schema v9.
CREATE TABLE verification_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  source_hashes_json TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
