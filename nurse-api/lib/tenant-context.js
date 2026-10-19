// Hospital (tenant) context for database access. Row-level security in
// migration 049 reads app.hospital_id / app.user_id from the connection, so
// every pooled connection is stamped with the caller's context on checkout.
// Code outside any context (login, password reset, platform tasks, psql) runs
// in platform scope ("*"), which sees every hospital.
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();
const PLATFORM = "*";

function currentContext() {
  return storage.getStore() ?? { hospitalId: PLATFORM, userId: "" };
}

function runInHospital(hospitalId, fn, userId = "") {
  if (!hospitalId) throw new Error("runInHospital requires a hospital id");
  return storage.run({ hospitalId, userId: userId ?? "" }, fn);
}

function runInPlatform(fn, userId = "") {
  return storage.run({ hospitalId: PLATFORM, userId: userId ?? "" }, fn);
}

// Patch pool.query/pool.connect so each checked-out client carries the context.
// The setting is cached per client and only re-sent when it changes.
function bindTenantPool(pool) {
  const connect = pool.connect.bind(pool);
  async function stamp(client) {
    const { hospitalId, userId } = currentContext();
    const key = `${hospitalId}|${userId}`;
    if (client.__tenantKey !== key) {
      await client.query(
        "SELECT set_config('app.hospital_id', $1, false), set_config('app.user_id', $2, false)",
        [hospitalId, userId],
      );
      client.__tenantKey = key;
    }
    return client;
  }
  pool.connect = async (callback) => {
    if (callback) throw new Error("pool.connect callbacks are not supported");
    const client = await connect();
    try {
      return await stamp(client);
    } catch (error) {
      client.release(error);
      throw error;
    }
  };
  pool.query = async (...args) => {
    const client = await pool.connect();
    try {
      return await client.query(...args);
    } finally {
      client.release();
    }
  };
  return pool;
}

// Run a background task once per hospital, each inside that hospital's context,
// so facility-name grouping and new rows stay within one hospital.
async function forEachHospital(pool, fn) {
  const { rows } = await runInPlatform(() =>
    pool.query("SELECT id, name FROM hospitals ORDER BY created_at, name"),
  );
  for (const hospital of rows) await runInHospital(hospital.id, () => fn(hospital));
}

module.exports = {
  PLATFORM,
  currentContext,
  runInHospital,
  runInPlatform,
  bindTenantPool,
  forEachHospital,
};
