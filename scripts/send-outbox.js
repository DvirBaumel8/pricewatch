#!/usr/bin/env node
"use strict";

/**
 * Mailer — drain outbox/ → send real email.
 *
 * Reads PRICEWATCH_SMTP_* or RESEND_API_KEY from env (Boris sources .env
 * in cron-daily-monitor.sh before calling this script).
 *
 * Idempotent: each outbox file gets a sidecar ".sent" after successful send.
 * Re-runs skip already-sent files. Outbox JSON is kept for audit trail.
 *
 * Kill switch: data/KILL or PRICEWATCH_KILL=1 → no-op (exit 0, nothing sent).
 *
 * Exit codes:
 *   0 — success (includes "nothing to send" and "no credentials" no-op)
 *   1 — unexpected error
 *   7 — no mail credentials configured (distinct, documented for Boris)
 *
 * Env vars (see .env.example):
 *   PRICEWATCH_MAIL_TRANSPORT  "resend" or "smtp" — explicit override; when
 *                               unset, Resend is preferred if RESEND_API_KEY
 *                               is set, else SMTP if SMTP_PASS is set.
 *   RESEND_API_KEY              Resend API key (preferred transport for §8.1)
 *   PRICEWATCH_SMTP_HOST        (default smtp.gmail.com)
 *   PRICEWATCH_SMTP_PORT        (default 587 — STARTTLS)
 *   PRICEWATCH_SMTP_SECURE      (1 = implicit TLS on 465; unset = STARTTLS)
 *   PRICEWATCH_SMTP_USER        (default price.watcher.service@gmail.com)
 *   PRICEWATCH_SMTP_PASS        (Gmail app password — never commit)
 *   PRICEWATCH_MAIL_FROM        From: header; for Resend use a verified sender
 *                               e.g. "PriceWatch <onboarding@resend.dev>"
 *   PRICEWATCH_MAIL_REPLY_TO / PRICEWATCH_REPLY_TO  (default = MAIL_FROM)
 */

const fs = require("fs");
const path = require("path");
const tls = require("tls");
const net = require("net");
const https = require("https");
const crypto = require("crypto");

const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");
const SENT_DIR = path.join(OUTBOX_DIR, "sent");
const KILL_FILE = path.resolve(__dirname, "..", "data", "KILL");

function isKilled() {
  if (process.env.PRICEWATCH_KILL === "1") return true;
  if (fs.existsSync(KILL_FILE)) return true;
  return false;
}

const SMTP_HOST = process.env.PRICEWATCH_SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.PRICEWATCH_SMTP_PORT || "587", 10);
const SMTP_SECURE = process.env.PRICEWATCH_SMTP_SECURE;
const SMTP_USER =
  process.env.PRICEWATCH_SMTP_USER || "price.watcher.service@gmail.com";
const SMTP_PASS = process.env.PRICEWATCH_SMTP_PASS || "";
const MAIL_FROM = process.env.PRICEWATCH_MAIL_FROM || SMTP_USER;
const REPLY_TO =
  process.env.PRICEWATCH_MAIL_REPLY_TO ||
  process.env.PRICEWATCH_REPLY_TO ||
  MAIL_FROM;

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_TRANSPORT = (process.env.PRICEWATCH_MAIL_TRANSPORT || "").toLowerCase();

// ── transport detection ───────────────────────────────────────────

function hasSmtp() {
  return !!SMTP_PASS;
}

function hasResend() {
  return !!RESEND_API_KEY;
}

function preferResend() {
  if (MAIL_TRANSPORT === "resend") return true;
  if (MAIL_TRANSPORT === "smtp") return false;
  return hasResend();
}

function useImplicitTls() {
  if (SMTP_SECURE === "1" || SMTP_SECURE === "true") return true;
  if (SMTP_SECURE === "0" || SMTP_SECURE === "false") return false;
  return SMTP_PORT === 465;
}

// ── Minimal RFC-5321 SMTP client (Node built-ins only) ────────────

function smtpCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\r\n");
      for (const line of lines) {
        if (/^\d{3} /.test(line)) {
          socket.removeListener("data", onData);
          const code = parseInt(line.slice(0, 3), 10);
          resolve({ code, text: line });
          return;
        }
      }
    };
    socket.on("data", onData);
    if (cmd !== null) {
      socket.write(cmd + "\r\n");
    }
  });
}

function smtpReadGreeting(socket) {
  return smtpCommand(socket, null);
}

async function sendViaSmtp(to, subject, textBody) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SMTP timeout")), 30_000);

    function done(err) {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    }

    const implicitTls = useImplicitTls();

    function runSmtp(socket) {
      (async () => {
        try {
          const greeting = await smtpReadGreeting(socket);
          if (greeting.code !== 220) throw new Error(`SMTP greeting: ${greeting.text}`);

          let ehlo = await smtpCommand(socket, `EHLO pricewatch`);
          if (ehlo.code !== 250) throw new Error(`EHLO: ${ehlo.text}`);

          const authPlain = Buffer.from(
            `\0${SMTP_USER}\0${SMTP_PASS}`
          ).toString("base64");
          const auth = await smtpCommand(socket, `AUTH PLAIN ${authPlain}`);
          if (auth.code !== 235) throw new Error(`AUTH: ${auth.text}`);

          const from = await smtpCommand(socket, `MAIL FROM:<${MAIL_FROM}>`);
          if (from.code !== 250) throw new Error(`MAIL FROM: ${from.text}`);

          const rcpt = await smtpCommand(socket, `RCPT TO:<${to}>`);
          if (rcpt.code !== 250) throw new Error(`RCPT TO: ${rcpt.text}`);

          const data = await smtpCommand(socket, "DATA");
          if (data.code !== 354) throw new Error(`DATA: ${data.text}`);

          const msgId = `<${crypto.randomBytes(16).toString("hex")}@pricewatch>`;
          const dateStr = new Date().toUTCString();
          const mime = [
            `From: PriceWatch <${MAIL_FROM}>`,
            `To: ${to}`,
            `Reply-To: ${REPLY_TO}`,
            `Subject: ${subject}`,
            `Message-ID: ${msgId}`,
            `Date: ${dateStr}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset=utf-8`,
            ``,
            textBody.replace(/^\./gm, ".."),
            ``,
          ].join("\r\n");

          const end = await smtpCommand(socket, mime + "\r\n.");
          if (end.code !== 250) throw new Error(`Send: ${end.text}`);

          smtpCommand(socket, "QUIT").catch(() => {});
          socket.end();
          done(null);
        } catch (e) {
          socket.destroy();
          done(e);
        }
      })();
    }

    if (implicitTls) {
      const socket = tls.connect(SMTP_PORT, SMTP_HOST, { servername: SMTP_HOST }, () => {
        runSmtp(socket);
      });
      socket.on("error", (e) => done(e));
    } else {
      const raw = net.createConnection(SMTP_PORT, SMTP_HOST, () => {
        (async () => {
          try {
            const greeting = await smtpReadGreeting(raw);
            if (greeting.code !== 220) throw new Error(`SMTP greeting: ${greeting.text}`);

            let ehlo = await smtpCommand(raw, `EHLO pricewatch`);
            if (ehlo.code !== 250) throw new Error(`EHLO: ${ehlo.text}`);

            const starttls = await smtpCommand(raw, "STARTTLS");
            if (starttls.code !== 220) throw new Error(`STARTTLS: ${starttls.text}`);

            const tlsSock = tls.connect({ socket: raw, servername: SMTP_HOST }, () => {
              runSmtp(tlsSock);
            });
            tlsSock.on("error", (e) => done(e));
          } catch (e) {
            raw.destroy();
            done(e);
          }
        })();
      });
      raw.on("error", (e) => done(e));
    }
  });
}

// ── Resend HTTP API transport ─────────────────────────────────────

function formatFrom(addr) {
  if (/<.*>/.test(addr)) return addr;
  return `PriceWatch <${addr}>`;
}

function sendViaResend(to, subject, textBody) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: formatFrom(MAIL_FROM),
      to: [to],
      reply_to: REPLY_TO,
      subject,
      text: textBody,
    });

    const req = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 15_000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Resend HTTP ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Resend timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── generic send ──────────────────────────────────────────────────

async function sendEmail(to, subject, textBody) {
  if (preferResend() && hasResend()) {
    await sendViaResend(to, subject, textBody);
    return "resend";
  }
  if (hasSmtp()) {
    await sendViaSmtp(to, subject, textBody);
    return "smtp";
  }
  if (hasResend()) {
    await sendViaResend(to, subject, textBody);
    return "resend";
  }
  throw new Error("no_credentials");
}

// ── outbox drain ──────────────────────────────────────────────────

function isSent(filePath) {
  return fs.existsSync(filePath + ".sent");
}

function markSent(filePath, transport) {
  const marker = {
    sent_at: new Date().toISOString(),
    transport,
    file: path.basename(filePath),
  };
  fs.writeFileSync(filePath + ".sent", JSON.stringify(marker, null, 2) + "\n");
}

function resolveRecipient(email) {
  if (email.type === "ops_alert") {
    return process.env.PRICEWATCH_OPS_EMAIL || MAIL_FROM;
  }
  return email.customer_email || null;
}

function resolveSubject(email) {
  if (email.type === "ops_alert") {
    if (email.subject && /^\[ops\]/i.test(email.subject)) return email.subject;
    return `[ops] ${email.subject || "PriceWatch ops alert"}`;
  }
  return email.subject || "PriceWatch notification";
}

async function drainOutbox() {
  if (isKilled()) {
    console.log("[mailer] Kill switch active — drain no-op.");
    return { sent: 0, skipped: 0, errors: 0, killed: true };
  }

  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.mkdirSync(SENT_DIR, { recursive: true });

  const files = fs.readdirSync(OUTBOX_DIR).filter((f) => {
    if (!f.endsWith(".json")) return false;
    if (f.endsWith(".sent")) return false;
    return true;
  });

  if (files.length === 0) {
    console.log("[mailer] No outbox files to process.");
    return { sent: 0, skipped: 0, errors: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = path.join(OUTBOX_DIR, file);

    if (isSent(filePath)) {
      console.log(`[mailer] skip (already sent): ${file}`);
      skipped++;
      continue;
    }

    let email;
    try {
      email = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      console.error(`[mailer] skip (bad JSON): ${file} — ${e.message}`);
      errors++;
      continue;
    }

    const to = resolveRecipient(email);
    if (!to) {
      console.log(`[mailer] skip (no recipient): ${file}`);
      skipped++;
      continue;
    }

    const subject = resolveSubject(email);
    const body = email.body || JSON.stringify(email, null, 2);

    try {
      const transport = await sendEmail(to, subject, body);
      markSent(filePath, transport);
      console.log(`[mailer] sent (${transport}): ${file} → ${to}`);
      sent++;
    } catch (e) {
      console.error(`[mailer] error: ${file} — ${e.message}`);
      errors++;
    }
  }

  return { sent, skipped, errors };
}

// ── main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`[mailer] ${new Date().toISOString()}`);

  if (isKilled()) {
    console.log("[mailer] Kill switch active — no-op (nothing sent).");
    return;
  }

  if (!hasSmtp() && !hasResend()) {
    console.log("[mailer] No mail credentials configured.");
    console.log("[mailer]   Set RESEND_API_KEY (preferred for §8.1)");
    console.log("[mailer]   or  PRICEWATCH_SMTP_PASS (Gmail app password)");
    console.log("[mailer] Exiting with code 7 (no credentials).");
    process.exit(7);
  }

  const transport = (preferResend() && hasResend()) ? "resend" : hasSmtp() ? "smtp" : "resend";
  console.log(`[mailer] Transport: ${transport}${MAIL_TRANSPORT ? ` (forced via PRICEWATCH_MAIL_TRANSPORT=${MAIL_TRANSPORT})` : ""}`);
  console.log(`[mailer] From: ${MAIL_FROM}`);
  console.log(`[mailer] Reply-To: ${REPLY_TO}`);

  const result = await drainOutbox();
  console.log(
    `[mailer] Done: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors`
  );

  if (result.errors > 0) {
    process.exit(1);
  }
}

module.exports = { drainOutbox, sendEmail, markSent, isSent, isKilled, OUTBOX_DIR, SENT_DIR, KILL_FILE };

if (require.main === module) {
  main().catch((err) => {
    console.error("[mailer] Fatal:", err.message);
    process.exit(1);
  });
}
