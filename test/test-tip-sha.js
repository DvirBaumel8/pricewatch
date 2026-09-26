#!/usr/bin/env node
"use strict";

/**
 * Shame-tests for tip-SHA deploy verify (Wave 11 ops polish).
 *
 * (a) /health includes git_sha field (non-empty string)
 * (b) verify script exits 0 when STUB_TIP_SHA matches main HEAD
 * (c) verify script exits 1 when STUB_TIP_SHA mismatches main HEAD
 * (d) GIT_SHA env var overrides git rev-parse in service-a
 *
 * No network, no secrets, no Neon.
 */

const http = require("http");
const { execSync } = require("child_process");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log("=== tip-sha-verify tests ===\n");

test("(a) service-a exports GIT_SHA as a non-empty string", () => {
  const { GIT_SHA } = require("../src/service-a");
  assert(typeof GIT_SHA === "string", "GIT_SHA should be a string");
  assert(GIT_SHA.length > 0, "GIT_SHA should not be empty");
  assert(GIT_SHA !== "unknown", "GIT_SHA should resolve in a git repo");
});

test("(b) /health response includes git_sha field", async () => {
  const { handleRequest } = require("../src/service-a");

  const body = await new Promise((resolve, reject) => {
    const req = new http.IncomingMessage();
    req.method = "GET";
    req.url = "/health";
    req.headers = {};

    let chunks = "";
    const res = {
      writeHead() {},
      end(data) {
        chunks = data;
        try {
          resolve(JSON.parse(chunks));
        } catch (e) {
          reject(e);
        }
      },
    };
    handleRequest(req, res);
  });

  assert(body.git_sha, "/health should have git_sha");
  assert(typeof body.git_sha === "string", "git_sha should be a string");
  assert(body.git_sha.length >= 7, "git_sha should be at least 7 chars");
  assert(body.status === "ok", "status should be ok");
});

test("(c) verify script exits 0 on matching STUB_TIP_SHA", () => {
  const mainHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  try {
    execSync(`STUB_TIP_SHA=${mainHead} node scripts/verify-tip-sha.js`, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(`Expected exit 0, got exit ${e.status}: ${e.stderr}`);
  }
});

test("(d) verify script exits 1 on mismatched STUB_TIP_SHA", () => {
  const fakeHash = "0000000000000000000000000000000000000000";
  try {
    execSync(`STUB_TIP_SHA=${fakeHash} node scripts/verify-tip-sha.js`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    throw new Error("Expected non-zero exit");
  } catch (e) {
    if (!e.status) throw e;
    assert(e.status === 1, `Expected exit 1, got ${e.status}`);
  }
});

test("(e) GIT_SHA env var overrides git rev-parse", () => {
  const out = execSync(
    'GIT_SHA=test-sha-override node -e "delete require.cache[require.resolve(\'../src/service-a\')]; const m = require(\'../src/service-a\'); console.log(m.GIT_SHA);"',
    { encoding: "utf8", cwd: __dirname, stdio: "pipe" }
  ).trim();
  assert(out === "test-sha-override", `Expected 'test-sha-override', got '${out}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
