/**
 * Static file server for the Elevated Identities website.
 *
 * Zero dependencies on purpose: there is no third-party code in the request
 * path to audit or patch, which matters for a financial services site.
 *
 * Only files under ./public are reachable. README.md and TODO-CLIENT.md sit
 * outside that directory and therefore cannot be requested at all.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createHash } = require("crypto");

const ROOT = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;   // Railway injects PORT
const HOST = "0.0.0.0";                          // must not be 127.0.0.1 on Railway

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".pdf": "application/pdf",
};

const COMPRESSIBLE = new Set([
  ".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".svg", ".xml", ".txt",
]);

// form-action must include Formspree: without JavaScript the enquiry form
// performs a real cross-origin POST there, and a stricter policy would block it.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://formspree.io",
  "form-action 'self' https://formspree.io",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

// The onboarding page embeds a GoHighLevel form, which needs its hosts allowed
// for the iframe and for the script that sizes the iframe to its content.
// Scoped to that one page so every other page keeps the stricter policy above.
const GHL = "https://api.leadconnectorhq.com https://link.msgsndr.com";

const ONBOARDING_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline' " + GHL,
  "connect-src 'self' https://formspree.io " + GHL,
  "frame-src " + GHL,
  "form-action 'self' https://formspree.io",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

function isOnboarding(urlPath) {
  return urlPath === "/onboarding" || urlPath === "/onboarding.html";
}

function securityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  var path = (req.url || "/").split("?")[0].split("#")[0];
  res.setHeader("Content-Security-Policy", isOnboarding(path) ? ONBOARDING_CSP : CSP);
  // Only once TLS is actually terminating in front of us, which Railway does.
  if ((req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

function etagFor(stat) {
  return createHash("sha1")
    .update(String(stat.size) + "-" + String(stat.mtimeMs))
    .digest("base64")
    .slice(0, 27);
}

/**
 * Map a request path to a file inside ROOT, or null if it escapes.
 * Returns the resolved absolute path only when it is genuinely within ROOT.
 */
function resolveWithin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;                                  // malformed percent-encoding
  }
  if (decoded.indexOf("\0") !== -1) return null;  // null byte

  const resolved = path.resolve(root, "." + path.posix.normalize(decoded));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function statFile(p) {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** Try the exact path, then `.html`, then a directory index. */
function locate(filePath) {
  let s = statFile(filePath);
  if (s) return { filePath, stat: s };

  if (!path.extname(filePath)) {
    const asHtml = filePath.replace(/\/+$/, "") + ".html";
    s = statFile(asHtml);
    if (s) return { filePath: asHtml, stat: s };

    const asIndex = path.join(filePath, "index.html");
    s = statFile(asIndex);
    if (s) return { filePath: asIndex, stat: s };
  }
  return null;
}

function send(req, res, filePath, stat, statusCode) {
  const ext = path.extname(filePath).toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";
  const etag = '"' + etagFor(stat) + '"';

  res.setHeader("Content-Type", type);
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", stat.mtime.toUTCString());
  // Filenames are not content-hashed, so always revalidate. A 304 costs almost
  // nothing and guarantees an edit is never masked by a stale cache.
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    return res.end();
  }

  const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const compress = acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024;

  if (compress) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
  } else {
    res.setHeader("Content-Length", stat.size);
  }

  res.writeHead(statusCode);
  if (req.method === "HEAD") return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  if (compress) {
    const gzip = zlib.createGzip();
    gzip.on("error", () => res.destroy());
    stream.pipe(gzip).pipe(res);
  } else {
    stream.pipe(res);
  }
}

function sendNotFound(req, res) {
  const page = path.join(ROOT, "404.html");
  const stat = statFile(page);
  if (stat) return send(req, res, page, stat, 404);
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
}

const server = http.createServer((req, res) => {
  securityHeaders(req, res);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method Not Allowed");
  }

  const urlPath = (req.url || "/").split("?")[0].split("#")[0];
  const target = resolveWithin(ROOT, urlPath === "/" ? "/index.html" : urlPath);
  if (!target) return sendNotFound(req, res);

  const found = locate(target);
  if (!found) return sendNotFound(req, res);

  send(req, res, found.filePath, found.stat, 200);
});

server.listen(PORT, HOST, () => {
  console.log(`Elevated Identities site serving ${ROOT} on http://${HOST}:${PORT}`);
});

// Railway sends SIGTERM on redeploy; finish in-flight requests rather than cut them.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
