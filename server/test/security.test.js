"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const request = require("supertest");
const { io: connectSocket } = require("socket.io-client");
const { PDFDocument } = require("pdf-lib");
const { createCanvas } = require("@napi-rs/canvas");
const { createPdfLiveServer } = require("../server");

async function pdfBuffer(pageCount = 1, text = "PDF Live test") {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([400, 500]);
    page.drawText(`${text} ${index + 1}`, { x: 30, y: 450, size: 14 });
  }
  return Buffer.from(await pdf.save());
}

async function largePdfBuffer() {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 500]).drawText("PDF dentro del límite de upload");
  await pdf.attach(crypto.randomBytes(2 * 1024 * 1024), "random-test-data.bin", { mimeType: "application/octet-stream" });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function fixture(overrides = {}) {
  const { secureCookies, allowedOrigins = ["http://localhost"], ...configOverrides } = overrides;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pdflive-test-"));
  const uploadDir = path.join(root, "uploads");
  const service = createPdfLiveServer({
    uploadDir,
    allowedOrigins,
    secureCookies,
    config: { cleanupIntervalMs: 60 * 60 * 1000, orphanGraceMs: 1000, ...configOverrides },
  });
  const address = await service.start(0);
  const url = `http://127.0.0.1:${address.port}`;
  return {
    root, uploadDir, service, url,
    async close() { await service.close(); await fsp.rm(root, { recursive: true, force: true }); },
  };
}

async function createSession(ctx, options = {}) {
  let req = request(ctx.service.app).post("/api/sessions")
    .attach("pdf", options.pdf || await pdfBuffer(options.pages || 1), { filename: options.name || "test.pdf", contentType: "application/pdf" });
  if (options.password !== undefined) req = req.field("password", options.password);
  const response = await req;
  assert.equal(response.status, 201, response.text);
  const setCookie = response.headers["set-cookie"]?.[0];
  return { ...response.body, adminCookie: setCookie?.split(";", 1)[0], setCookie };
}

function socket(ctx, cookie = null) {
  return connectSocket(ctx.url, {
    forceNew: true, reconnection: false, transports: ["websocket"],
    extraHeaders: { Origin: "http://localhost", ...(cookie ? { Cookie: cookie } : {}) },
  });
}

function once(socketClient, event) {
  return new Promise((resolve) => socketClient.once(event, resolve));
}

async function join(socketClient, payload) {
  await (socketClient.connected ? Promise.resolve() : once(socketClient, "connect"));
  const statePromise = once(socketClient, "session_state");
  const result = await new Promise((resolve) => socketClient.emit("join_session", payload, resolve));
  return { result, state: result.ok ? await statePromise : null };
}

function emit(socketClient, event, payload) {
  return new Promise((resolve) => socketClient.emit(event, payload, resolve));
}

const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("cabeceras, CSP y bibliotecas autoalojadas están configuradas", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const response = await request(ctx.service.app).get("/");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-powered-by"], undefined);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.doesNotMatch(response.text, /cdnjs|jsdelivr|3\.11\.174/);
  assert.match(response.text, /type="module" src="\/app\.js"/);
  assert.equal((await request(ctx.service.app).get("/vendor/pdfjs/pdf.mjs")).status, 200);
  assert.equal((await request(ctx.service.app).get("/vendor/pdfjs/pdf.worker.mjs")).status, 200);
  assert.equal((await request(ctx.service.app).get("/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf")).status, 200);
});

test("PDF.js parcheado conserva las defensas contra scripting y eval", async () => {
  const packageData = JSON.parse(await fsp.readFile(require.resolve("pdfjs-dist/package.json"), "utf8"));
  const major = Number(packageData.version.split(".")[0]);
  assert.ok(major >= 6, packageData.version);
  const frontend = await fsp.readFile(path.join(__dirname, "../../public/app.js"), "utf8");
  assert.match(frontend, /isEvalSupported:\s*false/);
  assert.match(frontend, /enableScripting:\s*false/);
  assert.doesNotMatch(frontend, /3\.11\.174|cdnjs|jsdelivr/);
});

test("crea, inspecciona y navega PDFs normales, multipágina y relativamente grandes", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const created = await createSession(ctx, { pages: 25, name: "multi.pdf" });
  const owner = socket(ctx, created.adminCookie); t.after(() => owner.close());
  const joined = await join(owner, { sessionId: created.sessionId, name: "Owner", password: "" });
  assert.equal(joined.result.ok, true);
  assert.equal(joined.state.pageCount, 25);
  assert.equal((await emit(owner, "change_page", { page: 25 })).ok, true);
  assert.equal((await emit(owner, "change_page", { page: 26 })).code, "INVALID_PAGE");
  const pdf = await request(ctx.service.app).get(`/api/sessions/${created.sessionId}/pdf`)
    .set("Authorization", `Bearer ${joined.state.accessToken}`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.body.length > 1000);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf.body), isEvalSupported: false, enableScripting: false,
    standardFontDataUrl: `${path.join(pdfjsRoot, "standard_fonts")}${path.sep}`,
  });
  const parsed = await task.promise;
  const lastPage = await parsed.getPage(25);
  const viewport = lastPage.getViewport({ scale: 0.5 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await lastPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  assert.ok(canvas.toBuffer("image/png").length > 100);
  await task.destroy();
  const exported = await PDFDocument.load(pdf.body);
  exported.getPage(0).drawLine({ start: { x: 10, y: 10 }, end: { x: 30, y: 30 }, thickness: 2 });
  assert.ok((await exported.save()).length > 1000);
  const large = await largePdfBuffer();
  assert.ok(large.length > 2 * 1024 * 1024);
  await createSession(ctx, { pdf: large, name: "large.pdf" });
});

test("rechaza PDFs corruptos y limpia el archivo temporal", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const response = await request(ctx.service.app).post("/api/sessions")
    .attach("pdf", Buffer.from("%PDF-not-a-document"), { filename: "broken.pdf", contentType: "application/pdf" });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_PDF");
  assert.deepEqual(await fsp.readdir(ctx.uploadDir), []);
});

test("la contraseña protege join y el PDF requiere un token efímero ligado a la sesión", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const first = await createSession(ctx, { password: "correct horse battery" });
  const second = await createSession(ctx);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${first.sessionId}/pdf`)).status, 401);

  const wrong = socket(ctx); t.after(() => wrong.close());
  assert.equal((await join(wrong, { sessionId: first.sessionId, name: "Wrong", password: "incorrect password" })).result.code, "AUTH_FAILED");

  const member = socket(ctx); t.after(() => member.close());
  const joined = await join(member, { sessionId: first.sessionId, name: "Member", password: "correct horse battery" });
  assert.equal(joined.result.ok, true);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${first.sessionId}/pdf`).set("Authorization", `Bearer ${joined.state.accessToken}`)).status, 200);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${second.sessionId}/pdf`).set("Authorization", `Bearer ${joined.state.accessToken}`)).status, 403);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${first.sessionId}/pdf`).set("Authorization", "Bearer invalid-invalid-invalid-invalid-invalid-invalid")).status, 403);
  for (const credential of ctx.service.sessions.get(first.sessionId).accessTokens.values()) credential.expiresAt = 0;
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${first.sessionId}/pdf`).set("Authorization", `Bearer ${joined.state.accessToken}`)).status, 403);
  const refreshedPromise = once(member, "session_state");
  assert.equal((await emit(member, "request_state", {})).ok, true);
  const refreshed = await refreshedPromise;
  assert.match(refreshed.accessToken, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${first.sessionId}/pdf`).set("Authorization", `Bearer ${refreshed.accessToken}`)).status, 200);
  member.close(); await pause();
});

test("política de contraseña se aplica en backend sin normalizar espacios", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const short = await request(ctx.service.app).post("/api/sessions")
    .field("password", "short")
    .attach("pdf", await pdfBuffer(), { filename: "test.pdf", contentType: "application/pdf" });
  assert.equal(short.status, 400);
  assert.deepEqual(await fsp.readdir(ctx.uploadDir), []);
  const created = await createSession(ctx, { password: "  spaced password  " });
  const client = socket(ctx); t.after(() => client.close());
  assert.equal((await join(client, { sessionId: created.sessionId, name: "User", password: "  spaced password  " })).result.ok, true);
});

test("todos los eventos malformados se rechazan sin terminar el servidor", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const client = socket(ctx); t.after(() => client.close());
  await once(client, "connect");
  const events = ["join_session", "request_state", "change_page", "draw_start", "draw_point", "draw_end", "clear_page", "erase_strokes", "toggle_lock", "toggle_free_mode"];
  for (const event of events) {
    const result = await emit(client, event, null);
    assert.equal(result.code, "INVALID_PAYLOAD", event);
  }
  assert.equal((await request(ctx.service.app).get("/healthz")).status, 200);
});

test("dibujo valida autoría, límites, revisiones y bloqueo", async (t) => {
  const ctx = await fixture({ maxStrokePoints: 2, maxStrokes: 3 }); t.after(() => ctx.close());
  const created = await createSession(ctx);
  const owner = socket(ctx, created.adminCookie); const guest = socket(ctx); t.after(() => owner.close()); t.after(() => guest.close());
  const ownerJoin = await join(owner, { sessionId: created.sessionId, name: "Owner" });
  const guestJoin = await join(guest, { sessionId: created.sessionId, name: "Guest" });
  const ownerStroke = crypto.randomUUID();
  assert.equal((await emit(owner, "draw_start", { page: 1, strokeId: ownerStroke, color: "#112233", width: 3 })).ok, true);
  assert.equal((await emit(guest, "draw_point", { page: 1, strokeId: ownerStroke, point: { x: 0.2, y: 0.2 } })).code, "FORBIDDEN");
  assert.equal((await emit(owner, "draw_point", { page: 1, strokeId: ownerStroke, point: { x: 0.1, y: 0.1 } })).ok, true);
  assert.equal((await emit(owner, "draw_point", { page: 1, strokeId: ownerStroke, point: { x: 0.2, y: 0.2 } })).ok, true);
  assert.equal((await emit(owner, "draw_point", { page: 1, strokeId: ownerStroke, point: { x: 0.3, y: 0.3 } })).code, "STATE_LIMIT");
  assert.equal((await emit(owner, "draw_point", { page: 1, strokeId: ownerStroke, point: { x: 2, y: 0 } })).code, "INVALID_PAYLOAD");
  assert.equal((await emit(owner, "toggle_lock", { locked: true })).ok, true);
  assert.equal((await emit(guest, "draw_start", { page: 1, strokeId: crypto.randomUUID(), color: "#112233", width: 3 })).code, "FORBIDDEN");
  assert.equal((await emit(guest, "clear_page", { page: 1, expectedRevision: guestJoin.state.revision })).code, "FORBIDDEN");
  assert.equal((await emit(owner, "clear_page", { page: 1, expectedRevision: ownerJoin.state.revision })).code, "STALE_REVISION");
});

test("operaciones concurrentes conservan estado autoritativo y rechazan revisiones obsoletas", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const created = await createSession(ctx);
  const owner = socket(ctx, created.adminCookie); const guest = socket(ctx); t.after(() => owner.close()); t.after(() => guest.close());
  await join(owner, { sessionId: created.sessionId, name: "Owner" });
  await join(guest, { sessionId: created.sessionId, name: "Guest" });
  const first = crypto.randomUUID(); const second = crypto.randomUUID();
  const starts = await Promise.all([
    emit(owner, "draw_start", { page: 1, strokeId: first, color: "#123456", width: 2 }),
    emit(guest, "draw_start", { page: 1, strokeId: second, color: "#654321", width: 2 }),
  ]);
  assert.equal(starts.every((result) => result.ok), true);
  const points = await Promise.all([
    emit(owner, "draw_point", { page: 1, strokeId: first, point: { x: 0.1, y: 0.1 } }),
    emit(guest, "draw_point", { page: 1, strokeId: second, point: { x: 0.9, y: 0.9 } }),
  ]);
  assert.equal(points.every((result) => result.ok), true);
  const session = ctx.service.sessions.get(created.sessionId);
  assert.equal(session.totalStrokes, 2);
  assert.equal(session.totalPoints, 2);
  assert.equal((await emit(guest, "erase_strokes", { page: 1, strokeIds: [first], expectedRevision: session.revision })).code, "FORBIDDEN");
  const revision = session.revision;
  assert.equal((await emit(guest, "erase_strokes", { page: 1, strokeIds: [second], expectedRevision: revision })).ok, true);
  assert.equal((await emit(owner, "clear_page", { page: 1, expectedRevision: revision })).code, "STALE_REVISION");
  assert.equal((await emit(owner, "clear_page", { page: 1, expectedRevision: session.revision })).ok, true);
  assert.equal(session.totalStrokes, 0);
  assert.equal(session.totalPoints, 0);
});

test("cambio A a B libera membresía, cupo y room anterior", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const a = await createSession(ctx); const b = await createSession(ctx);
  const client = socket(ctx); t.after(() => client.close());
  await join(client, { sessionId: a.sessionId, name: "Mover" });
  assert.equal(ctx.service.sessions.get(a.sessionId).clients.has(client.id), true);
  await join(client, { sessionId: b.sessionId, name: "Mover" });
  assert.equal(ctx.service.sessions.get(a.sessionId).clients.has(client.id), false);
  assert.equal(ctx.service.sessions.get(b.sessionId).clients.has(client.id), true);
  client.close(); await pause();
  assert.equal(ctx.service.sessions.get(b.sessionId).clients.size, 0);
});

test("administración se transfiere y el propietario no la recupera automáticamente", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const created = await createSession(ctx);
  const owner = socket(ctx, created.adminCookie); const guest = socket(ctx); t.after(() => owner.close()); t.after(() => guest.close());
  await join(owner, { sessionId: created.sessionId, name: "Owner" });
  await join(guest, { sessionId: created.sessionId, name: "Guest" });
  owner.close(); await pause();
  assert.equal(ctx.service.sessions.get(created.sessionId).adminId, guest.id);
  const returning = socket(ctx, created.adminCookie); t.after(() => returning.close());
  const joined = await join(returning, { sessionId: created.sessionId, name: "Owner" });
  assert.equal(joined.state.isOwner, true);
  assert.equal(joined.state.isAdmin, false);
  assert.equal((await emit(returning, "toggle_lock", { locked: true })).code, "FORBIDDEN");
});

test("sesiones nunca unidas, vacías y archivos huérfanos expiran con seguridad", async (t) => {
  const ctx = await fixture({ unjoinedTtlMs: 20, emptyTtlMs: 20, orphanGraceMs: 20 }); t.after(() => ctx.close());
  const created = await createSession(ctx);
  const fileName = ctx.service.sessions.get(created.sessionId).pdfFile;
  await ctx.service.cleanupExpired(Date.now() + 100);
  assert.equal(ctx.service.sessions.has(created.sessionId), false);
  assert.equal(fs.existsSync(path.join(ctx.uploadDir, fileName)), false);

  const orphan = `${crypto.randomUUID()}.pdf`;
  const unrelated = "keep-me.txt";
  await fsp.writeFile(path.join(ctx.uploadDir, orphan), "orphan");
  await fsp.writeFile(path.join(ctx.uploadDir, unrelated), "unrelated");
  await ctx.service.reconcileOrphans(Date.now() + 100);
  assert.equal(fs.existsSync(path.join(ctx.uploadDir, orphan)), false);
  assert.equal(fs.existsSync(path.join(ctx.uploadDir, unrelated)), true);

  const active = await createSession(ctx);
  const client = socket(ctx); t.after(() => client.close());
  await join(client, { sessionId: active.sessionId, name: "Temporal" });
  client.close(); await pause();
  await ctx.service.cleanupExpired(Date.now() + 100);
  assert.equal(ctx.service.sessions.has(active.sessionId), false);
});

test("cuotas globales de sesiones y almacenamiento rechazan y limpian excedentes", async (t) => {
  const oneSession = await fixture({ maxSessions: 1 }); t.after(() => oneSession.close());
  await createSession(oneSession);
  const rejected = await request(oneSession.service.app).post("/api/sessions")
    .attach("pdf", await pdfBuffer(), { filename: "extra.pdf", contentType: "application/pdf" });
  assert.equal(rejected.status, 503);
  assert.equal((await fsp.readdir(oneSession.uploadDir)).filter((name) => name.endsWith(".pdf")).length, 1);

  const noStorage = await fixture({ maxStorageBytes: 100 }); t.after(() => noStorage.close());
  const tooLarge = await request(noStorage.service.app).post("/api/sessions")
    .attach("pdf", await pdfBuffer(), { filename: "large.pdf", contentType: "application/pdf" });
  assert.equal(tooLarge.status, 507);
  assert.deepEqual(await fsp.readdir(noStorage.uploadDir), []);
});

test("upload interrumpido no conserva un archivo parcial", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const boundary = `----pdflive${crypto.randomUUID()}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="partial.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-`);
  await new Promise((resolve) => {
    const req = http.request(`${ctx.url}/api/sessions`, { method: "POST", headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": prefix.length + 100000,
    } });
    req.on("error", () => resolve());
    req.write(prefix);
    req.destroy();
    setTimeout(resolve, 50);
  });
  await pause(100);
  assert.deepEqual((await fsp.readdir(ctx.uploadDir)).filter((name) => name.endsWith(".pdf")), []);
});

test("rate limit de join opera por IP y sesión", async (t) => {
  const ctx = await fixture({ joinSessionRate: 2, joinIpRate: 20 }); t.after(() => ctx.close());
  const created = await createSession(ctx, { password: "strong password" });
  const client = socket(ctx); t.after(() => client.close());
  await once(client, "connect");
  for (let index = 0; index < 2; index += 1) {
    const result = await emit(client, "join_session", { sessionId: created.sessionId, name: "Try", password: "wrong password" });
    assert.equal(result.code, "AUTH_FAILED");
  }
  assert.equal((await emit(client, "join_session", { sessionId: created.sessionId, name: "Try", password: "wrong password" })).code, "RATE_LIMITED");
});

test("errores HTTP usan códigos correctos, incident ID y no filtran rutas", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const missing = await request(ctx.service.app).get("/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body.incidentId, /^[0-9a-f-]{36}$/);
  assert.equal(missing.text.includes(ctx.root), false);
  const invalid = await request(ctx.service.app).post("/api/sessions")
    .attach("pdf", Buffer.from("hello"), { filename: "x.txt", contentType: "text/plain" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.text.includes(ctx.root), false);
});

test("CORS y WebSocket rechazan orígenes no autorizados", async (t) => {
  const ctx = await fixture({ allowedOrigins: ["http://localhost"] }); t.after(() => ctx.close());
  const response = await request(ctx.service.app).get("/").set("Origin", "https://evil.example");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  const client = connectSocket(ctx.url, {
    forceNew: true, reconnection: false, transports: ["websocket"],
    extraHeaders: { Origin: "https://evil.example" },
  });
  const rejected = await new Promise((resolve) => {
    client.once("connect_error", (error) => resolve(error));
    setTimeout(() => resolve(null), 500);
  });
  client.close();
  assert.ok(rejected, "el origen no autorizado debe ser rechazado");
});

test("el cliente no persiste contraseñas, tokens ni apunta a producción", async () => {
  const frontend = await fsp.readFile(path.join(__dirname, "../../public/app.js"), "utf8");
  const html = await fsp.readFile(path.join(__dirname, "../../public/index.html"), "utf8");
  assert.doesNotMatch(frontend, /sessionStorage|localStorage|adminToken/i);
  assert.doesNotMatch(frontend, /(?:fetch|io)\s*\(\s*["`]https?:\/\//i);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+https?:\/\//i);
  assert.ok(
    frontend.indexOf('el("home-screen").classList.add("hidden")') > frontend.indexOf('socket.on("session_state"'),
    "el dashboard solo debe mostrarse después de recibir el estado autorizado",
  );
});

test("el formulario bloquea dobles envíos y solo abre el dashboard tras session_state", async () => {
  const frontend = await fsp.readFile(path.join(__dirname, "../../public/app.js"), "utf8");
  assert.match(frontend, /const attempt = joinFlow\.begin\(\)/);
  assert.match(frontend, /button\.disabled = checking/);
  assert.match(frontend, /joinFlow\.isCurrent\(attempt\)/);
  assert.ok(
    frontend.indexOf('el("home-screen").classList.add("hidden")') > frontend.indexOf('socket.on("session_state"'),
    "el dashboard no debe mostrarse antes de la confirmación del servidor",
  );
  assert.match(frontend, /connect_error/);
});

async function newJoinFlow() {
  const modulePath = pathToFileURL(path.join(__dirname, "../../public/join-flow.mjs")).href;
  const { createJoinFlow, JOIN_STATUS } = await import(modulePath);
  return { flow: createJoinFlow(), JOIN_STATUS };
}

test("flujo de acceso: contraseña incorrecta mantiene estado no autenticado", async () => {
  const { flow, JOIN_STATUS } = await newJoinFlow();
  const attempt = flow.begin();
  assert.equal(flow.reject(attempt), true);
  assert.equal(flow.status, JOIN_STATUS.UNAUTHENTICATED);
});

test("flujo de acceso: contraseña correcta autentica una sola vez", async () => {
  const { flow, JOIN_STATUS } = await newJoinFlow();
  const attempt = flow.begin();
  assert.equal(flow.authenticate(attempt), true);
  assert.equal(flow.authenticate(attempt), false);
  assert.equal(flow.status, JOIN_STATUS.AUTHENTICATED);
});

test("flujo de acceso: respuesta pendiente conserva estado checking", async () => {
  const { flow, JOIN_STATUS } = await newJoinFlow();
  flow.begin();
  assert.equal(flow.status, JOIN_STATUS.CHECKING);
});

test("flujo de acceso: error de red permite reintentar", async () => {
  const { flow, JOIN_STATUS } = await newJoinFlow();
  const failedAttempt = flow.begin();
  assert.equal(flow.reject(failedAttempt), true);
  assert.equal(flow.status, JOIN_STATUS.UNAUTHENTICATED);
  assert.notEqual(flow.begin(), null);
});

test("flujo de acceso: doble clic no crea un segundo intento", async () => {
  const { flow } = await newJoinFlow();
  assert.notEqual(flow.begin(), null);
  assert.equal(flow.begin(), null);
});

test("flujo de acceso: sesión expirada invalida el acceso", async () => {
  const { flow, JOIN_STATUS } = await newJoinFlow();
  const attempt = flow.begin();
  flow.authenticate(attempt);
  flow.invalidate();
  assert.equal(flow.status, JOIN_STATUS.UNAUTHENTICATED);
});

test("flujo de acceso: una respuesta antigua no autoriza", async () => {
  const { flow, JOIN_STATUS } = await newJoinFlow();
  const oldAttempt = flow.begin();
  flow.invalidate();
  const currentAttempt = flow.begin();
  assert.equal(flow.authenticate(oldAttempt), false);
  assert.equal(flow.status, JOIN_STATUS.CHECKING);
  assert.equal(flow.authenticate(currentAttempt), true);
});

test("las respuestas de sesión no contienen contraseñas ni secretos de configuración", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const created = await createSession(ctx, { password: "safe password" });
  const serialized = JSON.stringify(created);
  assert.doesNotMatch(serialized, /safe password|SECRET|DATABASE_URL|PRIVATE_KEY/i);
  assert.equal(Object.hasOwn(created, "password"), false);
  assert.equal(Object.hasOwn(created, "adminToken"), false);
});

test("la creación emite una sesión administrativa HttpOnly sin exponer su identificador", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const created = await createSession(ctx);
  assert.match(created.setCookie, new RegExp(`^pdflive-admin-${created.sessionId}=`));
  assert.match(created.setCookie, /; Path=\//);
  assert.match(created.setCookie, /; HttpOnly/);
  assert.match(created.setCookie, /; SameSite=Strict/);
  assert.doesNotMatch(created.setCookie, /; Secure/);
  assert.deepEqual(Object.keys(created).filter((key) => !["adminCookie", "setCookie"].includes(key)), ["sessionId"]);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${created.sessionId}/admin-session`)).body.authenticated, false);
  const authenticated = await request(ctx.service.app).get(`/api/sessions/${created.sessionId}/admin-session`).set("Cookie", created.adminCookie);
  assert.equal(authenticated.body.authenticated, true);
  const manipulated = socket(ctx); t.after(() => manipulated.close());
  const result = await join(manipulated, { sessionId: created.sessionId, name: "Attacker", adminToken: "forged" });
  assert.equal(result.result.code, "INVALID_PAYLOAD");
});

test("producción usa cookie __Host con Secure, HttpOnly y SameSite estricto", async (t) => {
  const ctx = await fixture({ secureCookies: true }); t.after(() => ctx.close());
  const created = await createSession(ctx);
  assert.match(created.setCookie, new RegExp(`^__Host-pdflive-admin-${created.sessionId}=`));
  assert.match(created.setCookie, /; Secure/);
  assert.match(created.setCookie, /; HttpOnly/);
  assert.match(created.setCookie, /; SameSite=Strict/);
  assert.match(created.setCookie, /; Path=\//);
  assert.doesNotMatch(created.setCookie, /; Domain=/i);
});

test("logout exige origen válido, revoca la cookie y bloquea su reutilización", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const created = await createSession(ctx);
  const owner = socket(ctx, created.adminCookie); const guest = socket(ctx);
  t.after(() => owner.close()); t.after(() => guest.close());
  const ownerJoin = await join(owner, { sessionId: created.sessionId, name: "Owner" });
  assert.equal(ownerJoin.state.isOwner, true);
  await join(guest, { sessionId: created.sessionId, name: "Guest" });
  assert.equal((await request(ctx.service.app).post(`/api/sessions/${created.sessionId}/admin-session/logout`).set("Cookie", created.adminCookie)).status, 403);
  assert.equal((await request(ctx.service.app).post(`/api/sessions/${created.sessionId}/admin-session/logout`).set("Cookie", created.adminCookie).set("Origin", "https://evil.example")).status, 403);
  const logout = await request(ctx.service.app).post(`/api/sessions/${created.sessionId}/admin-session/logout`)
    .set("Cookie", created.adminCookie).set("Origin", "http://localhost").send({});
  assert.equal(logout.status, 204);
  assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${created.sessionId}/admin-session`).set("Cookie", created.adminCookie)).body.authenticated, false);
  const reused = socket(ctx, created.adminCookie); t.after(() => reused.close());
  const reusedJoin = await join(reused, { sessionId: created.sessionId, name: "Reused" });
  assert.equal(reusedJoin.state.isOwner, false);
  assert.equal((await emit(reused, "toggle_lock", { locked: true })).code, "FORBIDDEN");
});

test("sesiones administrativas inválidas y expiradas no autentican al propietario", async (t) => {
  const ctx = await fixture({ adminSessionTtlMs: 20 }); t.after(() => ctx.close());
  const created = await createSession(ctx);
  const invalid = created.adminCookie.replace(/=.*/, "=invalid-invalid-invalid-invalid-invalid-invalid");
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${created.sessionId}/admin-session`).set("Cookie", invalid)).body.authenticated, false);
  await pause(30);
  assert.equal((await request(ctx.service.app).get(`/api/sessions/${created.sessionId}/admin-session`).set("Cookie", created.adminCookie)).body.authenticated, false);
  const expired = socket(ctx, created.adminCookie); t.after(() => expired.close());
  const joined = await join(expired, { sessionId: created.sessionId, name: "Expired" });
  assert.equal(joined.state.isOwner, false);
});
