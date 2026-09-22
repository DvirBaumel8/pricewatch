#!/usr/bin/env node
"use strict";

/**
 * §7.7 Queue unit tests — enqueue/dequeue, durability, idempotency.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const QUEUE_FILE = path.join(__dirname, "..", "data", "queue.json");
const BACKUP = QUEUE_FILE + ".bak";

function backup() {
  if (fs.existsSync(QUEUE_FILE)) {
    fs.copyFileSync(QUEUE_FILE, BACKUP);
  }
}

function restore() {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, QUEUE_FILE);
    fs.unlinkSync(BACKUP);
  } else if (fs.existsSync(QUEUE_FILE)) {
    fs.unlinkSync(QUEUE_FILE);
  }
}

function freshQueue() {
  if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
  delete require.cache[require.resolve("../src/queue")];
  return require("../src/queue");
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log("\n=== Queue unit tests (§7.7) ===\n");
backup();

try {
  test("enqueue creates a job with correct fields", () => {
    const q = freshQueue();
    const { job, created } = q.enqueue({
      customerId: "cust1",
      competitorId: "comp1",
      competitorName: "Acme Lab",
      pricingUrl: "http://127.0.0.1:3847/",
      targetPriceDescription: "main monthly price",
    });
    assert.strictEqual(created, true);
    assert.strictEqual(job.status, "pending");
    assert.strictEqual(job.customerId, "cust1");
    assert.strictEqual(job.competitorId, "comp1");
    assert.strictEqual(job.pricingUrl, "http://127.0.0.1:3847/");
    assert.strictEqual(job.targetPriceDescription, "main monthly price");
    assert.ok(job.id, "job should have an id");
    assert.ok(job.createdAt, "job should have createdAt");
  });

  test("idempotency: same customer+competitor+target does not create duplicate pending job", () => {
    const q = freshQueue();
    const first = q.enqueue({
      customerId: "cust1",
      competitorId: "comp1",
      competitorName: "Acme Lab",
      pricingUrl: "http://127.0.0.1:3847/",
      targetPriceDescription: "main monthly price",
    });
    assert.strictEqual(first.created, true);

    const second = q.enqueue({
      customerId: "cust1",
      competitorId: "comp1",
      competitorName: "Acme Lab",
      pricingUrl: "http://127.0.0.1:3847/",
      targetPriceDescription: "main monthly price",
    });
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.job.id, first.job.id);

    const jobs = q.listJobs();
    assert.strictEqual(jobs.length, 1, "should have exactly 1 job, not 2");
  });

  test("dequeue returns next pending job and marks it running", () => {
    const q = freshQueue();
    q.enqueue({
      customerId: "cust1",
      competitorId: "comp1",
      competitorName: "Acme",
      pricingUrl: "http://example.com",
      targetPriceDescription: "price",
    });
    const job = q.dequeue();
    assert.ok(job);
    assert.strictEqual(job.status, "running");
    const afterDequeue = q.dequeue();
    assert.strictEqual(afterDequeue, null, "no more pending jobs");
  });

  test("complete marks job done with reason and skillPath", () => {
    const q = freshQueue();
    q.enqueue({
      customerId: "cust2",
      competitorId: "comp2",
      competitorName: "Test",
      pricingUrl: "http://test.com",
      targetPriceDescription: "test price",
    });
    const job = q.dequeue();
    q.complete(job.id, {
      status: "done",
      result: "skill_ready",
      reason: "step_1_api",
      skillPath: "data/skills/test.json",
    });
    const updated = q.getJob(job.id);
    assert.strictEqual(updated.status, "done");
    assert.strictEqual(updated.result, "skill_ready");
    assert.strictEqual(updated.skillPath, "data/skills/test.json");
  });

  test("complete marks job failed with reason", () => {
    const q = freshQueue();
    q.enqueue({
      customerId: "cust3",
      competitorId: "comp3",
      competitorName: "Fail",
      pricingUrl: "http://bad.com",
      targetPriceDescription: "bad price",
    });
    const job = q.dequeue();
    q.complete(job.id, {
      status: "failed",
      result: "unsupported",
      reason: "blocked",
    });
    const updated = q.getJob(job.id);
    assert.strictEqual(updated.status, "failed");
    assert.strictEqual(updated.result, "unsupported");
    assert.strictEqual(updated.reason, "blocked");
  });

  test("queue survives process reload (durability)", () => {
    const q1 = freshQueue();
    q1.enqueue({
      customerId: "durable-cust",
      competitorId: "durable-comp",
      competitorName: "Durable",
      pricingUrl: "http://durable.com",
      targetPriceDescription: "durable price",
    });

    // Simulate process restart by clearing require cache
    delete require.cache[require.resolve("../src/queue")];
    const q2 = require("../src/queue");

    const jobs = q2.listJobs();
    assert.ok(jobs.length >= 1, "job should survive reload");
    const found = jobs.find((j) => j.customerId === "durable-cust");
    assert.ok(found, "durable job should be found after reload");
    assert.strictEqual(found.status, "pending");
  });

  test("enqueue allows new job after previous completed (same key)", () => {
    const q = freshQueue();
    const { job: j1 } = q.enqueue({
      customerId: "cust-repeat",
      competitorId: "comp-repeat",
      competitorName: "Repeat",
      pricingUrl: "http://repeat.com",
      targetPriceDescription: "repeat price",
    });
    q.dequeue();
    q.complete(j1.id, { status: "done", result: "skill_ready", reason: "done" });

    const { job: j2, created } = q.enqueue({
      customerId: "cust-repeat",
      competitorId: "comp-repeat",
      competitorName: "Repeat",
      pricingUrl: "http://repeat.com",
      targetPriceDescription: "repeat price",
    });
    assert.strictEqual(created, true, "should allow new job after completion");
    assert.notStrictEqual(j2.id, j1.id, "should have new id");
  });
} finally {
  restore();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
