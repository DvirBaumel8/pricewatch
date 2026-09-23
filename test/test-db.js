'use strict';

/**
 * Unit test: src/db.js fails closed when DATABASE_URL is missing.
 * Does NOT require a live Neon connection.
 */

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

console.log('\n=== db.js fail-closed tests ===\n');

const savedUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

try {
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');

  let threw = false;
  let errMsg = '';
  try {
    db.getPool();
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  assert('getPool() throws when DATABASE_URL is missing', threw);
  assert('Error message mentions DATABASE_URL', errMsg.includes('DATABASE_URL'));
  assert('Error message mentions neon-ops.md', errMsg.includes('neon-ops.md'));
} finally {
  if (savedUrl !== undefined) {
    process.env.DATABASE_URL = savedUrl;
  }
}

console.log(`\n=== db.js tests: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
