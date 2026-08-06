/**
 * One-time CLI script to create the first admin user.
 * Run: node scripts/create-admin.js "Admin Name" admin@chakrashri.com "StrongPassword123!"
 *
 * This replaces the old client-side hardcoded password entirely — after this,
 * admin login goes through POST /api/auth/admin/login with a real hashed
 * password check (see src/routes/auth.routes.js).
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/config/db');

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Usage: node scripts/create-admin.js "Name" email@example.com "Password123!"');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Use a stronger password (10+ characters) for the admin account.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10));
  let exitCode = 0;
  try {
    const result = await db.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified, is_active)
       VALUES ($1, $2, $3, 'admin', true, true)
       RETURNING id, name, email, role`,
      [name, email, hash]
    );
    console.log('Admin user created:', result.rows[0]);
  } catch (err) {
    console.error('Failed to create admin:', err.message);
    exitCode = 1;
  } finally {
    process.exit(exitCode);
  }
}

main();
