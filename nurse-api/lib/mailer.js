// Sends transactional email via Microsoft Graph (app-only OAuth2 client-credentials
// flow) so people get an email, not just the in-app bell, when a request needs
// their action or gets decided. Configured via env vars:
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_SENDER_EMAIL
// If any are missing, sendMail() logs instead of sending — never throws, since
// email is a side effect that must never block the underlying action (approve,
// decline, submit, etc.) from succeeding. Every call site in the app already
// wraps its own notification_state writes the same way (fire-and-forget,
// .catch(() => {})) — this follows that same convention.
const TENANT_ID = process.env.MS_GRAPH_TENANT_ID;
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET;
const SENDER_EMAIL = process.env.MS_GRAPH_SENDER_EMAIL;
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || "https://nrota.iwosanhealth.com";

const configured = !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && SENDER_EMAIL);
if (!configured) {
  console.warn(
    "[mailer] MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET / MS_GRAPH_SENDER_EMAIL " +
      "not fully set — emails will be logged instead of sent.",
  );
}

// Cached until shortly before expiry so we're not requesting a fresh token on
// every single email — client-credentials tokens are valid ~60-90 minutes.
let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`token request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

// Brand palette, sourced from the Iwosan Lagoon Hospitals logo.
const NAVY = "#1b2559";
const NAVY_SOFT = "#3d4457";
const PAGE_BG = "#edeff3";
const MUTED = "#8b90a0";

// Minimal, consistent branded shell — callers only ever supply the
// event-specific title/body/call-to-action, not raw HTML layout.
function wrapHtml({ title, bodyHtml, ctaText, ctaUrl }) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${PAGE_BG};font-family:'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:36px 16px;">
      <tr><td align="center">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 6px rgba(27,37,89,0.06),0 10px 28px -14px rgba(27,37,89,0.20);">
          <tr><td style="background:${NAVY};font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="height:5px;line-height:5px;font-size:0;">&nbsp;</td></tr>
          <tr><td style="padding:8px 34px 6px;">
            <h1 style="margin:0 0 14px;font-size:19px;line-height:1.35;color:${NAVY};font-weight:700;letter-spacing:-0.01em;">${title}</h1>
            <div style="font-size:14.5px;line-height:1.65;color:${NAVY_SOFT};">${bodyHtml}</div>
            ${
              ctaUrl
                ? `<div style="margin-top:26px;">
                     <a href="${ctaUrl}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">${ctaText ?? "Open Portal"}</a>
                   </div>`
                : ""
            }
          </td></tr>
          <tr><td style="padding:24px 34px 28px;"></td></tr>
          <tr><td style="padding:16px 34px;background:#f6f7fa;border-top:1px solid #e7e9f0;">
            <p style="margin:0;font-size:11px;color:${MUTED};">Nurse Rota system — this is an automated message, please do not reply.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ── Concurrency + retry guard for Microsoft Graph's per-mailbox throttling ──
// Graph enforces a small concurrent-request limit per sending mailbox (the
// "ApplicationThrottled" / MailboxConcurrency 429). Bulk notifications — a
// rota published to a whole facility, a leave-credit run, a shift-switch
// blast — fire many sendMail() calls back-to-back from unrelated call sites
// across the app, all sharing this one sender mailbox. This queue caps how
// many are actually in flight against Graph at once, and retries a 429 with
// backoff (honouring Retry-After when Graph sends one) instead of silently
// dropping the email, which is what was happening before.
const MAX_CONCURRENT_SENDS = 2;
const MAX_RETRIES = 4;
let activeSends = 0;
const sendQueue = [];

function runNextQueued() {
  if (activeSends >= MAX_CONCURRENT_SENDS || sendQueue.length === 0) return;
  activeSends++;
  const { task, resolve } = sendQueue.shift();
  task().finally(() => {
    activeSends--;
    resolve();
    runNextQueued();
  });
}

function enqueueSend(task) {
  return new Promise((resolve) => {
    sendQueue.push({ task, resolve });
    runNextQueued();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retries a 429 up to MAX_RETRIES times, honouring the Retry-After header
// when Graph provides one, otherwise falling back to exponential backoff.
async function fetchWithRetry(url, options, to) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt === MAX_RETRIES) return res;
    const retryAfterHeader = res.headers.get("retry-after");
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
    console.warn(
      `[mailer] 429 to ${to} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(waitMs);
  }
  return undefined; // unreachable — loop always returns
}

// Low-level send — deliberately never throws or rejects with an error the
// caller has to handle; logs and returns instead, so nothing in the app's
// real approve/decline/submit flow can ever fail because email did.
function recipientList(value) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const email = String(item ?? "").trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

async function sendMail({ to, cc, subject, title, bodyHtml, ctaText, ctaUrl }) {
  const toList = recipientList(to);
  if (!toList.length) return;
  const toKeys = new Set(toList.map((email) => email.toLowerCase()));
  const ccList = recipientList(cc).filter((email) => !toKeys.has(email.toLowerCase()));
  const toLabel = toList.join(", ");
  const ccLabel = ccList.length ? ` cc ${ccList.join(", ")}` : "";
  if (!configured) {
    console.log(`[mailer] (not configured) would send "${subject}" to ${toLabel}${ccLabel}`);
    return;
  }
  await enqueueSend(async () => {
    try {
      const token = await getAccessToken();
      const html = wrapHtml({
        title: title ?? subject,
        bodyHtml,
        ctaText,
        ctaUrl: ctaUrl ?? PORTAL_BASE_URL,
      });
      const res = await fetchWithRetry(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_EMAIL)}/sendMail`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: "HTML", content: html },
              toRecipients: toList.map((address) => ({ emailAddress: { address } })),
              ...(ccList.length
                ? { ccRecipients: ccList.map((address) => ({ emailAddress: { address } })) }
                : {}),
            },
            saveToSentItems: false,
          }),
        },
        toLabel,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[mailer] send failed (${res.status}) to ${toLabel}${ccLabel}: ${body}`);
      } else {
        console.log(`[mailer] sent "${subject}" to ${toLabel}${ccLabel}`);
      }
    } catch (err) {
      console.error(`[mailer] send error to ${toLabel}${ccLabel}:`, err.message);
    }
  });
}

// Builds a full portal link from a path, e.g. portalUrl("/approvals").
function portalUrl(path = "/") {
  return `${PORTAL_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

// Exported alongside sendMail so a preview/admin tool can render exactly what
// a recipient would see without actually sending anything.
module.exports = { sendMail, portalUrl, wrapHtml };
