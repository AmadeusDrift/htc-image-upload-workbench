CREATE TABLE IF NOT EXISTS upload_pool_members (
  userId TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  pool TEXT NOT NULL CHECK(pool IN ('external'))
);
