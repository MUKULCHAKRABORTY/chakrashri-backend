const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // rejectUnauthorized: true validates the server's TLS certificate against
  // Node's trusted CA store — Neon (and most managed Postgres providers) use
  // publicly-trusted CA-signed certificates, so this works out of the box
  // with no custom CA bundle needed. Setting this to false would disable
  // certificate validation entirely: the connection would still be
  // encrypted, but no longer authenticated, leaving it open to a
  // man-in-the-middle presenting any certificate at all. There's no
  // legitimate reason to weaken this for a managed provider like Neon.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  max: 20,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle Postgres client', err);
});

/**
 * Runs `fn` inside a BEGIN/COMMIT transaction on a single checked-out client.
 * Use this for any multi-statement write where partial failure or concurrent
 * requests could corrupt data (e.g. checking + decrementing stock, which
 * must not interleave between two simultaneous checkouts of the same item).
 * `fn` receives a client with the same `.query()` signature as the pool.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Defensive: explicitly pin the schema search path for this transaction.
    // db.query() (used by simple reads elsewhere in the app) has never shown
    // this problem, only writes routed through a transaction client — this
    // costs nothing and is a safe no-op if search_path was already correct,
    // but directly closes off one plausible explanation for a transaction
    // client resolving an unqualified table name differently than a plain
    // pool query would.
    await client.query('SET search_path TO public');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  pool
};
