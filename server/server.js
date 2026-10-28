"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const net = require("net");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { createServer } = require("http");
const { Server } = require("socket.io");

const DEFAULTS = Object.freeze({
  maxUploadBytes: 50 * 1024 * 1024,
  maxClients: 20,
  maxSessions: 100,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxConcurrentUploads: 2,
  maxPages: 2000,
  maxStrokes: 2000,
  maxClientStrokes: 500,
  maxStrokePoints: 4000,
  maxPoints: 100000,
  maxClientPoints: 25000,
  maxStateBytes: 8 * 1024 * 1024,
  maxSocketBytes: 64 * 1024,
  drawRate: 120,
  joinIpRate: 30,
  joinSessionRate: 10,
  rateWindowMs: 60 * 1000,
  accessTokenTtlMs: 60 * 60 * 1000,
  adminSessionTtlMs: 8 * 60 * 60 * 1000,
  unjoinedTtlMs: 5 * 60 * 1000,
  emptyTtlMs: 60 * 1000,
  inactiveTtlMs: 2 * 60 * 60 * 1000,
  cleanupIntervalMs: 30 * 1000,
  orphanGraceMs: 24 * 60 * 60 * 1000,
});

class HttpError extends Error {
  constructor(status, publicMessage, code = "REQUEST_ERROR") {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
    this.code = code;
  }
}

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} no es válido`);
  return value;
}

function normalizeIp(value) {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function getClientIp(request, trustedHops) {
  const remote = normalizeIp(request.socket?.remoteAddress) || "0.0.0.0";
  if (!trustedHops) return remote;
  const forwarded = String(request.headers?.["x-forwarded-for"] || "")
    .split(",").map(normalizeIp).filter(Boolean).reverse();
  return [remote, ...forwarded][Math.min(trustedHops, forwarded.length)] || remote;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

const isUuid = (value) => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isSessionId = (value) => typeof value === "string" && /^[A-HJ-NP-Z2-9]{5}$/.test(value.toUpperCase());

function normalizePassword(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length < 8 || value.length > 128 || !value.trim()) {
    throw new HttpError(400, "La contraseña debe tener entre 8 y 128 caracteres", "INVALID_PASSWORD");
  }
  return value;
}

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: (await scrypt(password, salt)).toString("hex") };
}

async function verifyPassword(password, salt, expectedHex) {
  if (typeof password !== "string" || password.length > 128) return false;
  const actual = await scrypt(password, salt);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function makeLimiter(max, windowMs) {
  const hits = new Map();
  return {
    limited(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return false;
      }
      entry.count += 1;
      return entry.count > max;
    },
    sweep(now = Date.now()) { for (const [key, value] of hits) if (now >= value.resetAt) hits.delete(key); },
    clear() { hits.clear(); },
  };
}

function log(level, message, metadata = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/token|password|payload|document/i.test(key) && ["string", "number", "boolean"].includes(typeof value)) safe[key] = value;
  }
  (level === "error" ? console.error : console.log)(JSON.stringify({ level, message, ...safe, timestamp: new Date().toISOString() }));
}

async function unlinkManaged(filePath, metadata = {}) {
  try { await fsp.unlink(filePath); return true; }
  catch (error) {
    if (error.code !== "ENOENT") log("error", "No se pudo eliminar un archivo administrado", { ...metadata, errorCode: error.code });
    return error.code === "ENOENT";
  }
}

async function inspectPdf(filePath, maxPages) {
  const bytes = new Uint8Array(await fsp.readFile(filePath));
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new HttpError(400, "El archivo no es un PDF válido", "INVALID_PDF");
  }
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableScripting: false, useSystemFonts: false, stopAtErrors: true });
    const pdf = await task.promise;
    const pageCount = pdf.numPages;
    await task.destroy();
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > maxPages) {
      throw new HttpError(400, `El PDF debe tener entre 1 y ${maxPages} páginas`, "INVALID_PDF_PAGES");
    }
    return pageCount;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "El PDF está corrupto, cifrado o no es compatible", "INVALID_PDF");
  }
}

function createPdfLiveServer(options = {}) {
  const config = {
    ...DEFAULTS,
    ...options.config,
    port: options.port ?? Number(process.env.PORT || 3000),
    uploadDir: options.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, "uploads"),
    publicDir: options.publicDir || path.join(__dirname, "..", "public"),
    trustProxyHops: options.trustProxyHops ?? envInt("TRUST_PROXY_HOPS", 0, 0, 5),
    hsts: options.hsts ?? process.env.ENABLE_HSTS === "true",
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === "production",
  };
  config.maxSessions = options.config?.maxSessions ?? envInt("MAX_ACTIVE_SESSIONS", config.maxSessions);
  config.maxStorageBytes = options.config?.maxStorageBytes ?? envInt("MAX_STORAGE_BYTES", config.maxStorageBytes);
  config.inactiveTtlMs = options.config?.inactiveTtlMs ?? envInt("SESSION_IDLE_TTL_MS", config.inactiveTtlMs);
  config.adminSessionTtlMs = options.config?.adminSessionTtlMs ?? envInt("ADMIN_SESSION_TTL_MS", config.adminSessionTtlMs);

  const configuredOrigins = options.allowedOrigins || String(process.env.ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
  const origins = new Set(configuredOrigins.length ? configuredOrigins : [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
  if (process.env.NODE_ENV === "production" && configuredOrigins.length === 0) throw new Error("ALLOWED_ORIGINS es obligatorio en producción");

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const sessions = new Map();
  let reservedUploadBytes = 0;
  let reservedSessions = 0;
  let activePdfInspections = 0;
  const joinIpLimiter = makeLimiter(config.joinIpRate, config.rateWindowMs);
  const joinSessionLimiter = makeLimiter(config.joinSessionRate, config.rateWindowMs);
  const drawLimiters = new Map();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops || false);
  app.use((req, res, next) => { req.requestId = crypto.randomUUID(); res.setHeader("X-Request-ID", req.requestId); next(); });
  app.use(helmet({
    hsts: config.hsts ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], workerSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"], fontSrc: ["'self'"], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
    } },
  }));
  app.use((req, _res, next) => {
    const origin = req.get("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin && !origins.has(origin)) {
      return next(new HttpError(403, "Origen no permitido", "ORIGIN_DENIED"));
    }
    next();
  });
  app.get(["/health", "/healthz"], (_req, res) => res.json({ status: "ok" }));
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  app.get("/vendor/pdfjs/pdf.mjs", (_req, res) => res.sendFile(require.resolve("pdfjs-dist/build/pdf.mjs")));
  app.get("/vendor/pdfjs/pdf.worker.mjs", (_req, res) => res.sendFile(require.resolve("pdfjs-dist/build/pdf.worker.mjs")));
  app.use("/vendor/pdfjs/standard_fonts", express.static(path.join(pdfjsRoot, "standard_fonts"), { fallthrough: false }));
  app.use("/vendor/pdfjs/cmaps", express.static(path.join(pdfjsRoot, "cmaps"), { fallthrough: false }));
  app.use("/vendor/pdfjs/wasm", express.static(path.join(pdfjsRoot, "wasm"), { fallthrough: false }));
  app.get("/vendor/pdf-lib.min.js", (_req, res) => res.sendFile(require.resolve("pdf-lib/dist/pdf-lib.min.js")));
  app.use(express.static(config.publicDir, { etag: true, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));

  const upload = multer({
    storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, config.uploadDir), filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.pdf`) }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 1, fieldSize: 256, parts: 2 },
    fileFilter: (_req, file, cb) => file.mimetype === "application/pdf" ? cb(null, true) : cb(new HttpError(400, "Solo se aceptan archivos PDF", "INVALID_FILE_TYPE")),
  });
  const rateKey = (req) => ipKeyGenerator(getClientIp(req, config.trustProxyHops));
  const limiter = (limit, message) => rateLimit({ windowMs: 60000, limit, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: rateKey,
    handler: (_req, res) => res.status(429).json({ error: message }) });
  const createLimiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: rateKey,
    handler: (_req, res) => res.status(429).json({ error: "Demasiadas sesiones creadas desde esta red" }) });

  const sessionPath = (session) => path.join(config.uploadDir, session.pdfFile);
  const adminCookieName = (id) => `${config.secureCookies ? "__Host-" : ""}pdflive-admin-${id}`;
  const adminCookie = (id, value, maxAge = Math.ceil(config.adminSessionTtlMs / 1000)) => [
    `${adminCookieName(id)}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict",
    config.secureCookies ? "Secure" : null, `Max-Age=${maxAge}`,
  ].filter(Boolean).join("; ");
  function adminCredential(request, session, now = Date.now()) {
    const token = parseCookies(request.headers?.cookie).get(adminCookieName(session.id));
    if (!token || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
    const hash = tokenHash(token);
    const credential = session.adminSessions.get(hash);
    if (!credential || credential.expiresAt <= now) {
      session.adminSessions.delete(hash);
      return null;
    }
    return { hash, credential };
  }
  const touch = (session) => { session.lastActivityAt = Date.now(); session.emptySince = null; };
  const canAct = (session, socketId) => !session.locked || session.adminId === socketId;
  const validPage = (session, page) => Number.isSafeInteger(page) && page >= 1 && page <= session.pageCount;

  function issueAccess(session, socketId) {
    const client = session.clients.get(socketId);
    if (client?.accessToken) {
      const existing = session.accessTokens.get(tokenHash(client.accessToken));
      if (existing && existing.expiresAt > Date.now()) {
        existing.expiresAt = Date.now() + config.accessTokenTtlMs;
        return client.accessToken;
      }
    }
    const token = crypto.randomBytes(32).toString("base64url");
    session.accessTokens.set(tokenHash(token), { socketId, expiresAt: Date.now() + config.accessTokenTtlMs });
    if (client) client.accessToken = token;
    return token;
  }
  function revokeAccess(session, socketId) {
    for (const [hash, value] of session.accessTokens) if (value.socketId === socketId) session.accessTokens.delete(hash);
    const client = session.clients.get(socketId);
    if (client) client.accessToken = null;
  }
  function publicState(session, socketId, accessToken = null) {
    return {
      sessionId: session.id, pdfName: session.pdfOriginalName, currentPage: session.currentPage,
      pageCount: session.pageCount, locked: session.locked, freeMode: session.freeMode,
      adminId: session.adminId, isAdmin: session.adminId === socketId, isOwner: session.ownerId === socketId,
      hasPassword: Boolean(session.passwordHash), maxClients: config.maxClients, revision: session.revision,
      accessToken, strokes: Object.fromEntries(session.strokes),
      clients: [...session.clients].map(([id, client]) => ({ id, name: client.name, isOwner: client.isOwner })),
    };
  }
  function sessionId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id;
    do id = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(""); while (sessions.has(id));
    return id;
  }

  async function destroySession(id, reason = "expired") {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    session.accessTokens.clear();
    session.adminSessions.clear();
    io.to(id).emit("session_expired", { reason });
    for (const socket of await io.in(id).fetchSockets()) { socket.leave(id); if (socket.data.sessionId === id) socket.data.sessionId = null; }
    await unlinkManaged(sessionPath(session), { sessionId: id, reason });
    return true;
  }

  async function reconcileOrphans(now = Date.now()) {
    let entries;
    try { entries = await fsp.readdir(config.uploadDir, { withFileTypes: true }); }
    catch (error) { log("error", "No se pudo reconciliar uploads", { errorCode: error.code }); return; }
    const active = new Set([...sessions.values()].map((session) => session.pdfFile));
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.pdf$/i.test(entry.name) || active.has(entry.name)) continue;
      try {
        const filePath = path.join(config.uploadDir, entry.name);
        if (now - (await fsp.stat(filePath)).mtimeMs >= config.orphanGraceMs) await unlinkManaged(filePath, { reason: "orphan" });
      } catch (error) { log("error", "No se pudo inspeccionar un archivo huérfano", { errorCode: error.code }); }
    }
  }

  async function cleanupExpired(now = Date.now()) {
    joinIpLimiter.sweep(now); joinSessionLimiter.sweep(now);
    for (const value of drawLimiters.values()) value.sweep(now);
    for (const session of [...sessions.values()]) {
      for (const [hash, token] of session.accessTokens) if (token.expiresAt <= now) session.accessTokens.delete(hash);
      for (const [hash, credential] of session.adminSessions) if (credential.expiresAt <= now) session.adminSessions.delete(hash);
      const neverJoined = !session.everJoined && now - session.createdAt >= config.unjoinedTtlMs;
      const empty = session.everJoined && session.clients.size === 0 && session.emptySince && now - session.emptySince >= config.emptyTtlMs;
      const inactive = now - session.lastActivityAt >= config.inactiveTtlMs;
      if (neverJoined || empty || inactive) await destroySession(session.id, neverJoined ? "never_joined" : inactive ? "inactive" : "empty");
    }
    await reconcileOrphans(now);
  }

  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: config.maxSocketBytes,
    allowRequest: (request, callback) => callback(null, !request.headers.origin || origins.has(request.headers.origin)) });

  app.post("/api/sessions", createLimiter, upload.single("pdf"), async (req, res, next) => {
    if (!req.file) return next(new HttpError(400, "Falta el archivo PDF", "MISSING_PDF"));
    const filePath = path.join(config.uploadDir, req.file.filename);
    let reserved = false;
    try {
      if (sessions.size + reservedSessions >= config.maxSessions) throw new HttpError(503, "No se pueden crear más sesiones", "SESSION_CAPACITY");
      if (activePdfInspections >= config.maxConcurrentUploads) throw new HttpError(503, "Hay demasiados PDFs procesándose", "UPLOAD_CAPACITY");
      const used = [...sessions.values()].reduce((sum, session) => sum + session.fileSize, 0);
      if (used + reservedUploadBytes + req.file.size > config.maxStorageBytes) throw new HttpError(507, "No hay capacidad de almacenamiento", "STORAGE_CAPACITY");
      reservedUploadBytes += req.file.size;
      reservedSessions += 1;
      activePdfInspections += 1;
      reserved = true;
      const password = normalizePassword(req.body?.password);
      const pageCount = await inspectPdf(filePath, config.maxPages);
      const passwordData = password ? await hashPassword(password) : { salt: null, hash: null };
      const id = sessionId();
      const adminSessionId = crypto.randomBytes(32).toString("base64url");
      const now = Date.now();
      const session = {
        id, pdfFile: req.file.filename, pdfOriginalName: path.basename(req.file.originalname).slice(0, 200), fileSize: req.file.size, pageCount,
        ownerId: null, adminId: null, currentPage: 1, locked: false, freeMode: false,
        passwordHash: passwordData.hash, passwordSalt: passwordData.salt, strokes: new Map(), clients: new Map(), accessTokens: new Map(), adminSessions: new Map(),
        totalStrokes: 0, totalPoints: 0, stateBytes: 0, revision: 0, createdAt: now, lastActivityAt: now, emptySince: now, everJoined: false,
      };
      session.adminSessions.set(tokenHash(adminSessionId), { expiresAt: now + config.adminSessionTtlMs });
      sessions.set(id, session);
      res.setHeader("Set-Cookie", adminCookie(id, adminSessionId));
      res.status(201).json({ sessionId: id });
    } catch (error) { await unlinkManaged(filePath, { requestId: req.requestId, reason: "create_failed" }); next(error); }
    finally {
      if (reserved) {
        reservedUploadBytes -= req.file.size;
        reservedSessions -= 1;
        activePdfInspections -= 1;
      }
    }
  });

  app.get("/api/sessions/:id", limiter(30, "Demasiados intentos"), (req, res) => {
    const id = String(req.params.id || "").toUpperCase();
    if (!isSessionId(id) || !sessions.has(id)) throw new HttpError(404, "Sesión no encontrada", "NOT_FOUND");
    res.json({ sessionId: id, hasPassword: Boolean(sessions.get(id).passwordHash) });
  });

  app.get("/api/sessions/:id/pdf", limiter(240, "Demasiadas solicitudes de documento"), (req, res, next) => {
    const session = sessions.get(String(req.params.id || "").toUpperCase());
    if (!session) return next(new HttpError(404, "Sesión no encontrada", "NOT_FOUND"));
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(req.get("authorization") || "");
    if (!match) return next(new HttpError(401, "Credencial de documento requerida", "PDF_AUTH_REQUIRED"));
    const hash = tokenHash(match[1]);
    const credential = session.accessTokens.get(hash);
    if (!credential || credential.expiresAt <= Date.now() || !session.clients.has(credential.socketId)) {
      session.accessTokens.delete(hash);
      return next(new HttpError(403, "Credencial de documento inválida o expirada", "PDF_AUTH_INVALID"));
    }
    touch(session);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline; filename=\"document.pdf\"");
    res.sendFile(sessionPath(session), (error) => { if (error) next(error); });
  });

  app.get("/api/sessions/:id/admin-session", (req, res, next) => {
    const session = sessions.get(String(req.params.id || "").toUpperCase());
    if (!session) return next(new HttpError(404, "Sesión no encontrada", "NOT_FOUND"));
    res.setHeader("Cache-Control", "no-store");
    res.json({ authenticated: Boolean(adminCredential(req, session)) });
  });

  app.post("/api/sessions/:id/admin-session/logout", express.json({ limit: "1kb" }), async (req, res, next) => {
    const origin = req.get("origin");
    if (!origin || !origins.has(origin)) return next(new HttpError(403, "Origen no permitido", "CSRF_DENIED"));
    const session = sessions.get(String(req.params.id || "").toUpperCase());
    if (!session) return next(new HttpError(404, "Sesión no encontrada", "NOT_FOUND"));
    const auth = adminCredential(req, session);
    if (!auth) return next(new HttpError(401, "Sesión administrativa requerida", "ADMIN_SESSION_REQUIRED"));
    session.adminSessions.delete(auth.hash);
    res.setHeader("Set-Cookie", adminCookie(session.id, "", 0));
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.adminSessionHash === auth.hash) {
        socket.data.adminSessionHash = null;
        await leave(socket, "admin_logout");
        socket.emit("admin_logged_out");
      }
    }
    res.status(204).end();
  });

  app.use((req, _res, next) => next(new HttpError(404, "Recurso no encontrado", "NOT_FOUND")));
  app.use(async (error, req, res, next) => {
    if (req.file?.filename) await unlinkManaged(path.join(config.uploadDir, req.file.filename), { requestId: req.requestId, reason: "request_error" });
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? `El archivo supera el límite de ${Math.floor(config.maxUploadBytes / 1048576)} MB` : "El formulario de subida no es válido";
      return res.status(400).json({ error: message, incidentId: req.requestId });
    }
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.publicMessage, code: error.code, incidentId: req.requestId });
    log("error", "Error HTTP interno", { requestId: req.requestId, errorName: error?.name, errorCode: error?.code });
    res.status(500).json({ error: "Error interno", incidentId: req.requestId });
  });

  const accept = (ack, extra = {}) => { if (typeof ack === "function") ack({ ok: true, ...extra }); };
  function reject(socket, event, ack, message, code = "INVALID_OPERATION") {
    if (typeof ack === "function") ack({ ok: false, error: message, code });
    else socket.emit("operation_rejected", { event, error: message, code });
  }
  function validated(socket, event, validator, handler) {
    socket.on(event, async (payload, ack) => {
      if (!isObject(payload) || !validator(payload)) return reject(socket, event, ack, "Datos inválidos", "INVALID_PAYLOAD");
      try { await handler(payload, ack); }
      catch (error) {
        const incidentId = crypto.randomUUID();
        log("error", "Error interno en Socket.IO", { incidentId, event, errorName: error?.name, errorCode: error?.code });
        reject(socket, event, ack, "No se pudo procesar la operación", "INTERNAL_ERROR");
      }
    });
  }
  const current = (socket) => socket.data.sessionId ? sessions.get(socket.data.sessionId) : null;

  async function leave(socket, reason = "leave") {
    const id = socket.data.sessionId;
    if (!id) return;
    socket.data.sessionId = null;
    socket.leave(id);
    drawLimiters.delete(socket.id);
    const session = sessions.get(id);
    if (!session) return;
    session.clients.delete(socket.id); revokeAccess(session, socket.id);
    if (session.ownerId === socket.id) session.ownerId = null;
    if (session.adminId === socket.id) {
      const owner = [...session.clients].find(([, client]) => client.isOwner);
      session.adminId = owner?.[0] || session.clients.keys().next().value || null;
      if (session.adminId) io.to(id).emit("system_message", "El administrador cambió por desconexión.");
    }
    session.lastActivityAt = Date.now();
    if (!session.clients.size) session.emptySince = Date.now();
    io.to(id).emit("presence_update", publicState(session, null).clients);
    io.to(id).emit("admin_changed", { adminId: session.adminId });
    log("info", "Socket salió de una sesión", { sessionId: id, reason });
  }

  function removeStrokeCounters(session, strokes) {
    for (const stroke of strokes) {
      session.totalStrokes -= 1; session.totalPoints -= stroke.points.length; session.stateBytes -= 128 + stroke.points.length * 32;
      const author = session.clients.get(stroke.authorId);
      if (author) { author.strokeCount = Math.max(0, author.strokeCount - 1); author.pointCount = Math.max(0, author.pointCount - stroke.points.length); }
    }
  }

  io.on("connection", (socket) => {
    socket.data.sessionId = null;
    socket.data.adminSessionHash = null;
    const clientIp = getClientIp(socket.request, config.trustProxyHops);

    validated(socket, "join_session", (p) => isSessionId(p.sessionId) && typeof p.name === "string" && p.name.trim().length >= 1 && p.name.trim().length <= 30
      && (p.password === undefined || typeof p.password === "string" && p.password.length <= 128)
      && !Object.hasOwn(p, "adminToken"), async (payload, ack) => {
      const id = payload.sessionId.toUpperCase();
      if (joinIpLimiter.limited(clientIp) || joinSessionLimiter.limited(`${clientIp}:${id}`)) return reject(socket, "join_session", ack, "Demasiados intentos", "RATE_LIMITED");
      const session = sessions.get(id);
      if (!session) return reject(socket, "join_session", ack, "Esa sesión no existe", "NOT_FOUND");
      if (session.passwordHash && !await verifyPassword(payload.password || "", session.passwordSalt, session.passwordHash)) return reject(socket, "join_session", ack, "Credenciales incorrectas", "AUTH_FAILED");
      if (socket.data.sessionId && socket.data.sessionId !== id) await leave(socket, "switch");
      const existing = session.clients.get(socket.id);
      if (!existing && session.clients.size >= config.maxClients) return reject(socket, "join_session", ack, `Esta sesión ya tiene el máximo de ${config.maxClients} personas`, "SESSION_FULL");
      const auth = adminCredential(socket.request, session);
      const isOwner = Boolean(auth);
      socket.data.adminSessionHash = auth?.hash || null;
      session.clients.set(socket.id, { name: payload.name.trim(), isOwner, strokeCount: existing?.strokeCount || 0, pointCount: existing?.pointCount || 0, accessToken: null });
      socket.data.sessionId = id; socket.join(id); session.everJoined = true; touch(session);
      if (isOwner) session.ownerId = socket.id;
      if (!session.adminId) session.adminId = socket.id;
      revokeAccess(session, socket.id);
      const accessToken = issueAccess(session, socket.id);
      socket.emit("session_state", publicState(session, socket.id, accessToken));
      io.to(id).emit("presence_update", publicState(session, null).clients);
      io.to(id).emit("admin_changed", { adminId: session.adminId });
      if (!existing) socket.to(id).emit("system_message", `${payload.name.trim()} se unió a la sesión.`);
      accept(ack, { sessionId: id });
    });

    validated(socket, "request_state", (p) => Object.keys(p).length === 0, async (_payload, ack) => {
      const session = current(socket);
      if (!session) return reject(socket, "request_state", ack, "No pertenecés a una sesión", "NOT_JOINED");
      socket.emit("session_state", publicState(session, socket.id, issueAccess(session, socket.id)));
      accept(ack, { revision: session.revision });
    });

    validated(socket, "change_page", (p) => Number.isSafeInteger(p.page), async ({ page }, ack) => {
      const session = current(socket);
      if (!session || !validPage(session, page)) return reject(socket, "change_page", ack, "Página inválida", "INVALID_PAGE");
      if (!canAct(session, socket.id) || session.freeMode && session.adminId !== socket.id) return reject(socket, "change_page", ack, "Operación no autorizada", "FORBIDDEN");
      session.currentPage = page; touch(session);
      if (!session.freeMode) io.to(session.id).emit("page_changed", { page });
      accept(ack);
    });

    validated(socket, "draw_start", (p) => Number.isSafeInteger(p.page) && isUuid(p.strokeId) && typeof p.color === "string"
      && /^#[0-9a-f]{6}$/i.test(p.color) && Number.isFinite(p.width) && p.width >= 1 && p.width <= 12, async (payload, ack) => {
      const session = current(socket); const client = session?.clients.get(socket.id);
      if (!session || !client || !validPage(session, payload.page)) return reject(socket, "draw_start", ack, "Página inválida", "INVALID_PAGE");
      if (!canAct(session, socket.id)) return reject(socket, "draw_start", ack, "La sesión está bloqueada", "FORBIDDEN");
      const rate = drawLimiters.get(socket.id) || makeLimiter(config.drawRate, 1000); drawLimiters.set(socket.id, rate);
      if (rate.limited(socket.id)) return reject(socket, "draw_start", ack, "Demasiados eventos", "RATE_LIMITED");
      if ([...session.strokes.values()].some((items) => items.some((stroke) => stroke.id === payload.strokeId))) return reject(socket, "draw_start", ack, "Trazo duplicado", "DUPLICATE_STROKE");
      if (session.totalStrokes >= config.maxStrokes || client.strokeCount >= config.maxClientStrokes || session.stateBytes + 128 > config.maxStateBytes) return reject(socket, "draw_start", ack, "Límite de trazos alcanzado", "STATE_LIMIT");
      if (!session.strokes.has(payload.page)) session.strokes.set(payload.page, []);
      const stroke = { id: payload.strokeId, color: payload.color.toLowerCase(), width: payload.width, points: [], authorId: socket.id };
      session.strokes.get(payload.page).push(stroke); session.totalStrokes += 1; session.stateBytes += 128; client.strokeCount += 1; session.revision += 1; touch(session);
      socket.to(session.id).emit("draw_start", { page: payload.page, strokeId: stroke.id, color: stroke.color, width: stroke.width, authorId: socket.id, revision: session.revision });
      accept(ack, { revision: session.revision });
    });

    validated(socket, "draw_point", (p) => Number.isSafeInteger(p.page) && isUuid(p.strokeId) && isObject(p.point)
      && Number.isFinite(p.point.x) && p.point.x >= 0 && p.point.x <= 1 && Number.isFinite(p.point.y) && p.point.y >= 0 && p.point.y <= 1, async (payload, ack) => {
      const session = current(socket); const client = session?.clients.get(socket.id);
      if (!session || !client || !validPage(session, payload.page)) return reject(socket, "draw_point", ack, "Página inválida", "INVALID_PAGE");
      if (!canAct(session, socket.id)) return reject(socket, "draw_point", ack, "La sesión está bloqueada", "FORBIDDEN");
      const rate = drawLimiters.get(socket.id) || makeLimiter(config.drawRate, 1000); drawLimiters.set(socket.id, rate);
      if (rate.limited(socket.id)) return reject(socket, "draw_point", ack, "Demasiados eventos", "RATE_LIMITED");
      const stroke = (session.strokes.get(payload.page) || []).find((item) => item.id === payload.strokeId);
      if (!stroke || stroke.authorId !== socket.id) return reject(socket, "draw_point", ack, "No podés modificar ese trazo", "FORBIDDEN");
      if (stroke.points.length >= config.maxStrokePoints || session.totalPoints >= config.maxPoints || client.pointCount >= config.maxClientPoints || session.stateBytes + 32 > config.maxStateBytes) return reject(socket, "draw_point", ack, "Límite de puntos alcanzado", "STATE_LIMIT");
      const point = { x: payload.point.x, y: payload.point.y };
      stroke.points.push(point); session.totalPoints += 1; session.stateBytes += 32; client.pointCount += 1; session.revision += 1; touch(session);
      socket.to(session.id).emit("draw_point", { page: payload.page, strokeId: stroke.id, point, revision: session.revision });
      accept(ack, { revision: session.revision });
    });

    validated(socket, "draw_end", (p) => Number.isSafeInteger(p.page) && isUuid(p.strokeId), async (payload, ack) => {
      const session = current(socket); const stroke = session && (session.strokes.get(payload.page) || []).find((item) => item.id === payload.strokeId);
      if (!session || !validPage(session, payload.page) || !stroke || stroke.authorId !== socket.id) return reject(socket, "draw_end", ack, "Trazo inválido", "FORBIDDEN");
      socket.to(session.id).emit("draw_end", { page: payload.page, strokeId: payload.strokeId, revision: session.revision }); accept(ack, { revision: session.revision });
    });

    validated(socket, "clear_page", (p) => Number.isSafeInteger(p.page) && Number.isSafeInteger(p.expectedRevision), async ({ page, expectedRevision }, ack) => {
      const session = current(socket);
      if (!session || !validPage(session, page)) return reject(socket, "clear_page", ack, "Página inválida", "INVALID_PAGE");
      if (session.adminId !== socket.id) return reject(socket, "clear_page", ack, "Solo el administrador puede borrar la página", "FORBIDDEN");
      if (expectedRevision !== session.revision) return reject(socket, "clear_page", ack, "El estado cambió", "STALE_REVISION");
      removeStrokeCounters(session, session.strokes.get(page) || []); session.strokes.set(page, []); session.revision += 1; touch(session);
      io.to(session.id).emit("page_cleared", { page, revision: session.revision }); accept(ack, { revision: session.revision });
    });

    validated(socket, "erase_strokes", (p) => Number.isSafeInteger(p.page) && Number.isSafeInteger(p.expectedRevision) && Array.isArray(p.strokeIds)
      && p.strokeIds.length >= 1 && p.strokeIds.length <= 500 && p.strokeIds.every(isUuid), async ({ page, strokeIds, expectedRevision }, ack) => {
      const session = current(socket);
      if (!session || !validPage(session, page)) return reject(socket, "erase_strokes", ack, "Página inválida", "INVALID_PAGE");
      if (!canAct(session, socket.id)) return reject(socket, "erase_strokes", ack, "La sesión está bloqueada", "FORBIDDEN");
      if (expectedRevision !== session.revision) return reject(socket, "erase_strokes", ack, "El estado cambió", "STALE_REVISION");
      const wanted = new Set(strokeIds); const strokes = session.strokes.get(page) || [];
      const removed = strokes.filter((stroke) => wanted.has(stroke.id) && (stroke.authorId === socket.id || session.adminId === socket.id));
      if (!removed.length) return reject(socket, "erase_strokes", ack, "No hay trazos autorizados para borrar", "FORBIDDEN");
      const ids = new Set(removed.map((stroke) => stroke.id)); removeStrokeCounters(session, removed);
      session.strokes.set(page, strokes.filter((stroke) => !ids.has(stroke.id))); session.revision += 1; touch(session);
      io.to(session.id).emit("strokes_erased", { page, strokeIds: [...ids], revision: session.revision }); accept(ack, { revision: session.revision });
    });

    validated(socket, "toggle_lock", (p) => typeof p.locked === "boolean", async ({ locked }, ack) => {
      const session = current(socket);
      if (!session || session.adminId !== socket.id) return reject(socket, "toggle_lock", ack, "Solo el administrador puede bloquear", "FORBIDDEN");
      session.locked = locked; touch(session); io.to(session.id).emit("lock_changed", { locked }); accept(ack);
    });
    validated(socket, "toggle_free_mode", (p) => typeof p.enabled === "boolean", async ({ enabled }, ack) => {
      const session = current(socket);
      if (!session || session.adminId !== socket.id) return reject(socket, "toggle_free_mode", ack, "Solo el administrador puede cambiar el modo", "FORBIDDEN");
      session.freeMode = enabled; touch(session); io.to(session.id).emit("free_mode_changed", { enabled, page: session.currentPage }); accept(ack);
    });
    socket.on("disconnect", () => leave(socket, "disconnect").catch((error) => log("error", "Falló la limpieza del socket", { errorCode: error.code })));
  });

  const cleanupTimer = setInterval(() => cleanupExpired().catch((error) => log("error", "Falló la limpieza periódica", { errorCode: error.code })), config.cleanupIntervalMs);
  cleanupTimer.unref();
  reconcileOrphans().catch((error) => log("error", "Falló la reconciliación inicial", { errorCode: error.code }));

  async function start(port = config.port) {
    if (!httpServer.listening) await new Promise((resolve, reject) => {
      httpServer.once("error", reject); httpServer.listen(port, () => { httpServer.off("error", reject); resolve(); });
    });
    return httpServer.address();
  }
  async function close() {
    clearInterval(cleanupTimer); joinIpLimiter.clear(); joinSessionLimiter.clear(); drawLimiters.clear();
    await new Promise((resolve) => io.close(resolve));
  }
  return { app, httpServer, io, sessions, config, start, close, cleanupExpired, reconcileOrphans, destroySession };
}

if (require.main === module) {
  const service = createPdfLiveServer();
  service.start().then((address) => log("info", "PDF Live iniciado", { port: address.port }))
    .catch((error) => { log("error", "No se pudo iniciar PDF Live", { errorName: error.name, errorCode: error.code }); process.exitCode = 1; });
  let closing = false;
  const shutdown = async (signal) => { if (!closing) { closing = true; log("info", "Cierre ordenado", { signal }); await service.close(); } };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { createPdfLiveServer, HttpError, isObject, getClientIp, normalizePassword };
