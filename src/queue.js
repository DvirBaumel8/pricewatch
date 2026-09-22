/**
 * Durable file-based job queue for pendingCustomerOnboardingRequests.
 *
 * Stores jobs as JSON in data/queue.json — survives process restart.
 * No Redis or paid infrastructure required.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const QUEUE_FILE = path.join(__dirname, "..", "data", "queue.json");

function ensureDir() {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
}

function loadQueue() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(jobs) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(jobs, null, 2) + "\n");
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Enqueue a new onboarding job. Idempotency: if a pending/running job
 * already exists for the same customer+competitor+target, skip.
 * Returns { job, created } — created=false means duplicate was skipped.
 */
function enqueue({ customerId, competitorId, competitorName, pricingUrl, targetPriceDescription }) {
  const jobs = loadQueue();

  const duplicate = jobs.find(
    (j) =>
      j.customerId === customerId &&
      j.pricingUrl === pricingUrl &&
      j.targetPriceDescription === targetPriceDescription &&
      (j.status === "pending" || j.status === "running")
  );
  if (duplicate) {
    return { job: duplicate, created: false };
  }

  const job = {
    id: generateId(),
    customerId,
    competitorId,
    competitorName,
    pricingUrl,
    targetPriceDescription,
    status: "pending",
    result: null,
    reason: null,
    skillPath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  jobs.push(job);
  saveQueue(jobs);
  return { job, created: true };
}

/**
 * Claim the next pending job (mark it running). Returns null if empty.
 */
function dequeue() {
  const jobs = loadQueue();
  const next = jobs.find((j) => j.status === "pending");
  if (!next) return null;
  next.status = "running";
  next.updatedAt = new Date().toISOString();
  saveQueue(jobs);
  return next;
}

/**
 * Mark a job as done/failed with a result and reason.
 */
function complete(jobId, { status, result, reason, skillPath }) {
  const jobs = loadQueue();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  job.status = status;
  job.result = result || null;
  job.reason = reason || null;
  job.skillPath = skillPath || null;
  job.updatedAt = new Date().toISOString();
  saveQueue(jobs);
  return job;
}

function listJobs(filter) {
  const jobs = loadQueue();
  if (!filter) return jobs;
  return jobs.filter((j) => {
    if (filter.status && j.status !== filter.status) return false;
    if (filter.customerId && j.customerId !== filter.customerId) return false;
    return true;
  });
}

function getJob(jobId) {
  return loadQueue().find((j) => j.id === jobId) || null;
}

function pendingCount() {
  return loadQueue().filter((j) => j.status === "pending").length;
}

module.exports = { enqueue, dequeue, complete, listJobs, getJob, pendingCount, loadQueue, QUEUE_FILE };
