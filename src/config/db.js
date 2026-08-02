const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
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
