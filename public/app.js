import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
import { createJoinFlow, JOIN_STATUS } from "/join-flow.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const DEFAULT_RENDER_SCALE = 1.4;
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;

const state = {
  socket: null,
  sessionId: null,
  myName: null,
  joined: false,
  pdfDoc: null,
  pdfLoadingTask: null,
  pdfName: "documento.pdf",
  totalPages: 0,
  currentPage: 1,
  locked: false,
  freeMode: false,
  adminId: null,
  isAdmin: false,
  isOwner: false,
  maxClients: 20,
  accessToken: null,
  revision: 0,
  strokesByPage: new Map(),
  renderScale: DEFAULT_RENDER_SCALE,
  zoomPercent: 100,
  drawMode: false,
  eraserMode: false,
  activeStroke: null,
  activeEraser: null,
  renderVersion: 0,
  renderTask: null,
  joinStatus: JOIN_STATUS.UNAUTHENTICATED,
};

const el = (id) => document.getElementById(id);
const joinFlow = createJoinFlow((status) => {
  state.joinStatus = status;
  const button = el("join-submit");
  if (!button) return;
  const checking = status === JOIN_STATUS.CHECKING;
  button.disabled = checking;
  button.textContent = checking ? "Verificando…" : "Unirme";
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    el(btn.dataset.tab === "create" ? "create-form" : "join-form").classList.add("active");
  });
});

const params = new URLSearchParams(location.search);
if (params.get("session")) {
  document.querySelector('[data-tab="join"]').click();
  el("join-code").value = params.get("session").toUpperCase();
}

el("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("create-error").textContent = "";
  const name = el("create-name").value.trim();
  const file = el("create-pdf").files[0];
  const password = el("create-password").value;
  if (!file) return;

  const formData = new FormData();
  formData.append("pdf", file);
  if (password) formData.append("password", password);

  try {
    const res = await fetch("/api/sessions", { method: "POST", body: formData, credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo crear la sesión");
    enterSession(data.sessionId, name, password);
  } catch (err) {
    el("create-error").textContent = err.message;
  }
});

el("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const attempt = joinFlow.begin();
  if (attempt === null) return;
  state.socket?.close();
  el("join-error").textContent = "";
  const name = el("join-name").value.trim();
  const code = el("join-code").value.trim().toUpperCase();
  const password = el("join-password").value;

  try {
    const res = await fetch(`/api/sessions/${code}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sesión no encontrada");

    if (!joinFlow.isCurrent(attempt)) return;
    if (data.hasPassword && !password) {
      el("join-password-wrap").classList.remove("hidden");
      el("join-password").required = true;
      el("join-password").focus();
      el("join-error").textContent = "Esta sesión requiere una contraseña.";
      joinFlow.reject(attempt);
      return;
    }

    enterSession(code, name, password, attempt);
  } catch (err) {
    if (joinFlow.isCurrent(attempt)) {
      el("join-error").textContent = err.message || "No se pudo verificar la sesión";
      joinFlow.reject(attempt);
    }
  }
});

async function enterSession(sessionId, name, password = "", attempt = joinFlow.begin()) {
  if (attempt === null || !joinFlow.isCurrent(attempt)) return;
  if (state.pdfLoadingTask) state.pdfLoadingTask.destroy().catch(() => {});
  state.sessionId = sessionId;
  state.myName = name;
  state.joined = false;
  state.pdfDoc = null;
  state.pdfLoadingTask = null;
  state.accessToken = null;
  state.isOwner = false;
  state.revision = 0;
  state.strokesByPage = new Map();

  try {
    const response = await fetch(`/api/sessions/${sessionId}/admin-session`, { credentials: "include" });
    if (response.ok) state.isOwner = Boolean((await response.json()).authenticated);
  } catch {
  }
  if (!joinFlow.isCurrent(attempt)) return;
  updateAdminUI();

  const socket = io({ withCredentials: true });
  state.socket = socket;

  socket.on("connect", () => {
    socket.emit("join_session", { sessionId, name, password }, (result) => {
      if (!result?.ok && joinFlow.isCurrent(attempt)) handleJoinFailure(result?.error || "No se pudo ingresar a la sesión");
    });
  });

  function handleJoinFailure(message) {
    if (!joinFlow.isCurrent(attempt)) return;
    showToast(message);
    state.joined = false;
    joinFlow.reject(attempt);
    socket.close();
    el("session-screen").classList.add("hidden");
    el("home-screen").classList.remove("hidden");
    document.querySelector('[data-tab="join"]').click();
    el("join-error").textContent = message;
    history.replaceState(null, "", location.pathname);
  }

  socket.on("error_message", (msg) => {
    if (!state.joined && joinFlow.isCurrent(attempt)) {
      handleJoinFailure(msg);
    }
  });

  socket.on("connect_error", () => {
    handleJoinFailure("No se pudo conectar con la sesión. Intentá nuevamente.");
  });

  socket.on("session_state", async (s) => {
    if (!joinFlow.authenticate(attempt)) return;
    state.joined = true;
    state.locked = s.locked;
    state.freeMode = s.freeMode;
    state.adminId = s.adminId;
    state.isAdmin = s.isAdmin;
    state.isOwner = s.isOwner;
    state.currentPage = s.currentPage;
    state.maxClients = s.maxClients;
    state.revision = s.revision;
    if (s.accessToken) state.accessToken = s.accessToken;
    state.pdfName = s.pdfName || state.pdfName;
    state.strokesByPage = new Map(Object.entries(s.strokes).map(([k, v]) => [Number(k), v]));
    el("home-screen").classList.add("hidden");
    el("session-screen").classList.remove("hidden");
    el("session-code-label").textContent = sessionId;
    history.replaceState(null, "", `?session=${sessionId}`);
    updatePresence(s.clients);
    updateAdminUI();
    updateLockUI();
    updateFreeModeUI();
    try {
      if (!state.pdfDoc) await loadPdf();
      goToPage(state.currentPage, false);
    } catch (err) {
      console.error("No se pudo abrir el PDF", err);
      showToast("El PDF está corrupto o no es compatible");
    }
  });

  socket.on("page_changed", ({ page }) => goToPage(page, false));

  socket.on("free_mode_changed", ({ enabled, page }) => {
    state.freeMode = enabled;
    updateFreeModeUI();
    if (!enabled && Number.isFinite(page)) goToPage(page, false);
    showToast(enabled ? "El administrador activó el modo libre" : "El administrador volvió al modo guiado");
  });

  socket.on("draw_start", ({ page, strokeId, color, width, authorId, revision }) => {
    if (Number.isSafeInteger(revision)) state.revision = revision;
    ensurePageStrokes(page).push({ id: strokeId, color, width, points: [], authorId });
  });

  socket.on("draw_point", ({ page, strokeId, point, revision }) => {
    if (Number.isSafeInteger(revision)) state.revision = revision;
    const stroke = ensurePageStrokes(page).find((s) => s.id === strokeId);
    if (!stroke) return;
    stroke.points.push(point);
    if (page === state.currentPage) drawSegment(stroke);
  });

  socket.on("draw_end", () => {
  });

  socket.on("page_cleared", ({ page, revision }) => {
    if (Number.isSafeInteger(revision)) state.revision = revision;
    state.strokesByPage.set(page, []);
    if (page === state.currentPage) redrawStrokes();
  });

  socket.on("strokes_erased", ({ page, strokeIds, revision }) => {
    if (Number.isSafeInteger(revision)) state.revision = revision;
    removeStrokes(page, strokeIds);
  });

  socket.on("operation_rejected", ({ error }) => {
    showToast(error || "La operación fue rechazada");
    requestStateSync();
  });

  socket.on("session_expired", () => {
    joinFlow.invalidate();
    showToast("La sesión expiró por inactividad");
    state.joined = false;
    socket.close();
    el("session-screen").classList.add("hidden");
    el("home-screen").classList.remove("hidden");
  });

  socket.on("admin_logged_out", () => {
    state.isAdmin = false;
    state.isOwner = false;
    updateAdminUI();
    socket.emit("join_session", { sessionId, name, password }, (result) => {
      if (!result?.ok) handleJoinFailure(result?.error || "No se pudo volver a la sesión");
    });
  });

  socket.on("lock_changed", ({ locked }) => {
    state.locked = locked;
    updateLockUI();
    showToast(locked ? "El administrador bloqueó la sesión" : "La sesión fue desbloqueada");
  });

  socket.on("admin_changed", ({ adminId }) => {
    state.adminId = adminId;
    state.isAdmin = adminId === state.socket.id;
    updateAdminUI();
  });

  socket.on("presence_update", updatePresence);
  socket.on("system_message", showToast);
}

function isAdmin() {
  return state.isAdmin;
}

function canAct() {
  return !state.locked || isAdmin();
}

async function loadPdf() {
  if (!state.accessToken) throw new Error("Falta la credencial temporal del documento");
  const loadingTask = pdfjsLib.getDocument({
    url: `/api/sessions/${state.sessionId}/pdf`,
    httpHeaders: { Authorization: `Bearer ${state.accessToken}` },
    isEvalSupported: false,
    enableScripting: false,
    stopAtErrors: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    wasmUrl: "/vendor/pdfjs/wasm/",
  });
  state.pdfLoadingTask = loadingTask;
  state.pdfDoc = await loadingTask.promise;
  state.totalPages = state.pdfDoc.numPages;
  el("page-count").textContent = state.totalPages;
}

async function renderCurrentPage() {
  const pageNumber = state.currentPage;
  const renderVersion = ++state.renderVersion;
  const page = await state.pdfDoc.getPage(pageNumber);
  if (renderVersion !== state.renderVersion) return;

  const previousRender = state.renderTask;
  if (previousRender) {
    previousRender.cancel();
    try {
      await previousRender.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") throw err;
    }
    if (renderVersion !== state.renderVersion) return;
  }

  const viewport = page.getViewport({ scale: state.renderScale });

  const pdfCanvas = el("pdf-canvas");
  const drawCanvas = el("draw-canvas");
  const stage = el("viewer-stage");

  [pdfCanvas, drawCanvas].forEach((c) => {
    c.width = viewport.width;
    c.height = viewport.height;
  });
  stage.style.width = viewport.width + "px";
  stage.style.height = viewport.height + "px";

  const ctx = pdfCanvas.getContext("2d");
  const renderTask = page.render({ canvasContext: ctx, viewport });
  state.renderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
    return;
  }
  if (renderVersion !== state.renderVersion) return;
  state.renderTask = null;

  redrawStrokes();
}

function goToPage(page, shouldEmit) {
  const clamped = Math.min(Math.max(1, page), state.totalPages || page);
  state.currentPage = clamped;
  el("page-input").value = clamped;
  renderCurrentPage().catch(() => showToast("No se pudo renderizar esta página"));
  if (shouldEmit) emitOperation("change_page", { page: clamped });
}

function requestStateSync() {
  if (state.socket?.connected && state.joined) state.socket.emit("request_state", {});
}

function emitOperation(event, payload, onRejected = requestStateSync) {
  state.socket.emit(event, payload, (result) => {
    if (result?.ok) {
      if (Number.isSafeInteger(result.revision)) state.revision = result.revision;
      return;
    }
    showToast(result?.error || "La operación fue rechazada");
    if (onRejected) onRejected(result);
  });
}

function requestPageChange(page) {
  const canNavigateLocally = state.freeMode && !isAdmin();
  if (!canAct() && !canNavigateLocally) {
    showToast("La sesión está bloqueada por el administrador");
    return;
  }
  const shouldEmit = !state.freeMode || isAdmin();
  goToPage(page, shouldEmit);
}

el("prev-page").addEventListener("click", () => requestPageChange(state.currentPage - 1));
el("next-page").addEventListener("click", () => requestPageChange(state.currentPage + 1));
el("page-input").addEventListener("change", (e) => requestPageChange(Number(e.target.value)));

function setZoom(percent) {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, percent));
  state.zoomPercent = zoom;
  state.renderScale = DEFAULT_RENDER_SCALE * (zoom / 100);
  el("zoom-range").value = zoom;
  el("zoom-level").textContent = `${zoom}%`;
  if (state.pdfDoc) renderCurrentPage();
}

el("zoom-out").addEventListener("click", () => setZoom(state.zoomPercent - ZOOM_STEP));
el("zoom-in").addEventListener("click", () => setZoom(state.zoomPercent + ZOOM_STEP));
el("zoom-range").addEventListener("input", (e) => setZoom(Number(e.target.value)));

function cssColorToRgb(color) {
  const value = color.replace("#", "");
  const number = Number.parseInt(value.length === 3
    ? value.split("").map((part) => part + part).join("")
    : value, 16);
  return PDFLib.rgb(
    ((number >> 16) & 255) / 255,
    ((number >> 8) & 255) / 255,
    (number & 255) / 255,
  );
}

function pointToPdfCoordinates(point, page, rotation) {
  const { width, height } = page.getSize();
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: point.y * width, y: point.x * height };
    case 180:
      return { x: (1 - point.x) * width, y: (1 - point.y) * height };
    case 270:
      return { x: (1 - point.y) * width, y: (1 - point.x) * height };
    default:
      return { x: point.x * width, y: (1 - point.y) * height };
  }
}

function drawStrokeInPdf(page, stroke) {
  if (stroke.points.length < 2) return;
  const color = cssColorToRgb(stroke.color);
  const rotation = page.getRotation().angle;
  const lineWidth = stroke.width / DEFAULT_RENDER_SCALE;

  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = pointToPdfCoordinates(stroke.points[index - 1], page, rotation);
    const end = pointToPdfCoordinates(stroke.points[index], page, rotation);
    page.drawLine({
      start,
      end,
      thickness: lineWidth,
      color,
      lineCap: PDFLib.LineCapStyle.Round,
    });
  }
}

function exportFilename(name) {
  const base = name.replace(/\.pdf$/i, "") || "documento";
  return `${base}-con-dibujos.pdf`;
}

el("download-pdf").addEventListener("click", async () => {
  const button = el("download-pdf");
  if (!state.pdfDoc || !window.PDFLib) {
    showToast("El PDF todavía no está listo para descargar");
    return;
  }

  button.disabled = true;
  button.textContent = "Preparando PDF…";
  try {
    const originalBytes = await state.pdfDoc.getData();
    const outputPdf = await PDFLib.PDFDocument.load(originalBytes);
    const pages = outputPdf.getPages();
    state.strokesByPage.forEach((strokes, pageNumber) => {
      const page = pages[pageNumber - 1];
      if (!page) return;
      strokes.forEach((stroke) => drawStrokeInPdf(page, stroke));
    });

    const bytes = await outputPdf.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(state.pdfName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("PDF con dibujos descargado");
  } catch (err) {
    console.error("No se pudo exportar el PDF", err);
    showToast("No se pudo preparar el PDF para descargar");
  } finally {
    button.disabled = false;
    button.textContent = "↓ Descargar PDF";
  }
});

function ensurePageStrokes(page) {
  if (!state.strokesByPage.has(page)) state.strokesByPage.set(page, []);
  return state.strokesByPage.get(page);
}

function redrawStrokes() {
  const canvas = el("draw-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = state.strokesByPage.get(state.currentPage) || [];
  strokes.forEach((s) => drawFullStroke(s));
}

function removeStrokes(page, strokeIds) {
  const ids = new Set(strokeIds);
  const strokes = ensurePageStrokes(page);
  state.strokesByPage.set(page, strokes.filter((stroke) => !ids.has(stroke.id)));
  if (page === state.currentPage) redrawStrokes();
}

function drawFullStroke(stroke) {
  const canvas = el("draw-canvas");
  const ctx = canvas.getContext("2d");
  if (stroke.points.length < 2) return;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  stroke.points.forEach((p, i) => {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawSegment(stroke) {
  const canvas = el("draw-canvas");
  const ctx = canvas.getContext("2d");
  const pts = stroke.points;
  if (pts.length < 2) return;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
  ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
  ctx.stroke();
}

function updateDrawCursor() {
  const canvas = el("draw-canvas");
  const hasActiveTool = state.drawMode || state.eraserMode;
  canvas.classList.toggle("drawable", hasActiveTool && canAct());
  canvas.classList.toggle("erasing", state.eraserMode && canAct());
  canvas.classList.toggle("locked-out", hasActiveTool && !canAct());
}

el("draw-toggle").addEventListener("click", () => {
  state.drawMode = !state.drawMode;
  if (state.drawMode) state.eraserMode = false;
  el("draw-toggle").classList.toggle("active", state.drawMode);
  el("eraser-toggle").classList.remove("active");
  updateDrawCursor();
});

el("eraser-toggle").addEventListener("click", () => {
  state.eraserMode = !state.eraserMode;
  if (state.eraserMode) state.drawMode = false;
  el("eraser-toggle").classList.toggle("active", state.eraserMode);
  el("draw-toggle").classList.remove("active");
  updateDrawCursor();
});

el("clear-page").addEventListener("click", () => {
  if (!canAct()) return showToast("La sesión está bloqueada por el administrador");
  if (!isAdmin()) return showToast("Solo el administrador puede borrar toda la página");
  emitOperation("clear_page", { page: state.currentPage, expectedRevision: state.revision });
});

function getCanvasPoint(evt) {
  const canvas = el("draw-canvas");
  const rect = canvas.getBoundingClientRect();
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

function startDrawing(evt) {
  if (!state.drawMode || !canAct()) return;
  evt.preventDefault();
  const strokeId = crypto.randomUUID();
  const color = el("draw-color").value;
  const width = Number(el("draw-width").value);
  const stroke = { id: strokeId, color, width, points: [], authorId: state.socket.id };
  ensurePageStrokes(state.currentPage).push(stroke);
  state.activeStroke = stroke;
  emitOperation("draw_start", { page: state.currentPage, strokeId, color, width }, () => {
    removeStrokes(state.currentPage, [strokeId]);
    state.activeStroke = null;
    requestStateSync();
  });
  addPoint(getCanvasPoint(evt));
}

function distanceToSegmentSquared(point, start, end, canvas) {
  const px = point.x * canvas.width;
  const py = point.y * canvas.height;
  const ax = start.x * canvas.width;
  const ay = start.y * canvas.height;
  const bx = end.x * canvas.width;
  const by = end.y * canvas.height;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  const nearestX = ax + t * dx;
  const nearestY = ay + t * dy;
  const offsetX = px - nearestX;
  const offsetY = py - nearestY;
  return offsetX * offsetX + offsetY * offsetY;
}

function strokeIsTouched(stroke, point, eraserRadius) {
  const canvas = el("draw-canvas");
  const points = stroke.points;
  if (!points.length) return false;
  const radius = eraserRadius + (stroke.width || 0) / 2;
  const radiusSquared = radius * radius;
  if (points.length === 1) return distanceToSegmentSquared(point, points[0], points[0], canvas) <= radiusSquared;
  return points.some((current, index) => index > 0
    && distanceToSegmentSquared(point, points[index - 1], current, canvas) <= radiusSquared);
}

function eraseAt(point) {
  const activeEraser = state.activeEraser;
  if (!activeEraser) return;
  const radius = Number(el("eraser-width").value) / 2;
  const touchedIds = ensurePageStrokes(activeEraser.page)
    .filter((stroke) => (isAdmin() || stroke.authorId === state.socket.id)
      && !activeEraser.erasedIds.has(stroke.id) && strokeIsTouched(stroke, point, radius))
    .map((stroke) => stroke.id);
  if (!touchedIds.length) return;
  touchedIds.forEach((id) => activeEraser.erasedIds.add(id));
}

function startErasing(evt) {
  if (!state.eraserMode || !canAct()) return;
  evt.preventDefault();
  state.activeEraser = { page: state.currentPage, erasedIds: new Set() };
  eraseAt(getCanvasPoint(evt));
}

function moveDrawing(evt) {
  if (state.activeEraser) {
    evt.preventDefault();
    eraseAt(getCanvasPoint(evt));
    return;
  }
  if (!state.activeStroke) return;
  evt.preventDefault();
  addPoint(getCanvasPoint(evt));
}

function addPoint(point) {
  const stroke = state.activeStroke;
  stroke.points.push(point);
  drawSegment(stroke);
  emitOperation("draw_point", { page: state.currentPage, strokeId: stroke.id, point }, () => {
    state.activeStroke = null;
    requestStateSync();
  });
}

function endDrawing() {
  if (state.activeEraser) {
    const { page, erasedIds } = state.activeEraser;
    state.activeEraser = null;
    if (erasedIds.size) emitOperation("erase_strokes", { page, strokeIds: [...erasedIds], expectedRevision: state.revision });
    return;
  }
  if (!state.activeStroke) return;
  emitOperation("draw_end", { page: state.currentPage, strokeId: state.activeStroke.id }, null);
  state.activeStroke = null;
}

function startCanvasAction(evt) {
  if (state.eraserMode) startErasing(evt);
  else startDrawing(evt);
}

const drawCanvasEl = el("draw-canvas");
drawCanvasEl.addEventListener("mousedown", startCanvasAction);
drawCanvasEl.addEventListener("mousemove", moveDrawing);
window.addEventListener("mouseup", endDrawing);
drawCanvasEl.addEventListener("touchstart", startCanvasAction, { passive: false });
drawCanvasEl.addEventListener("touchmove", moveDrawing, { passive: false });
drawCanvasEl.addEventListener("touchend", endDrawing);

el("lock-toggle").addEventListener("click", () => {
  if (!isAdmin()) return showToast("Solo el administrador puede bloquear la sesión");
  emitOperation("toggle_lock", { locked: !state.locked }, null);
});

el("free-mode-toggle").addEventListener("click", () => {
  if (!isAdmin()) return showToast("Solo el administrador puede activar el modo libre");
  emitOperation("toggle_free_mode", { enabled: !state.freeMode }, null);
});

el("logout-admin").addEventListener("click", async () => {
  if (!state.sessionId) return;
  try {
    const response = await fetch(`/api/sessions/${state.sessionId}/admin-session/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok && response.status !== 401) throw new Error("No se pudo cerrar la sesión administrativa");
    state.isAdmin = false;
    state.isOwner = false;
    updateAdminUI();
    showToast("Sesión administrativa cerrada");
  } catch (error) {
    showToast(error.message);
  }
});

function updateAdminUI() {
  const admin = isAdmin();
  el("role-badge").textContent = admin ? "Administrador" : "Invitado";
  el("role-badge").classList.toggle("is-admin", admin);
  el("lock-toggle").style.opacity = admin ? "1" : "0.5";
  el("lock-toggle").style.cursor = admin ? "pointer" : "not-allowed";
  el("free-mode-toggle").style.opacity = admin ? "1" : "0.5";
  el("free-mode-toggle").style.cursor = admin ? "pointer" : "not-allowed";
  el("logout-admin").classList.toggle("hidden", !state.isOwner);
  updateDrawCursor();
}

function updateLockUI() {
  const btn = el("lock-toggle");
  btn.textContent = state.locked ? "🔒 Bloqueada" : "🔓 Desbloqueada";
  btn.classList.toggle("locked", state.locked);
  updateDrawCursor();
}

function updateFreeModeUI() {
  const btn = el("free-mode-toggle");
  btn.textContent = state.freeMode ? "↔ Libre activo" : "↔ Modo libre";
  btn.title = state.freeMode ? "Desactivar modo libre" : "Activar modo libre";
  btn.classList.toggle("active", state.freeMode);
}

function updatePresence(clients) {
  el("people-list").textContent = clients.map((c) => c.name).join(" · ");
  el("people-count").textContent = `${clients.length}/${state.maxClients}`;
}

el("copy-code-btn").addEventListener("click", async () => {
  const sessionCode = state.sessionId;
  try {
    await navigator.clipboard.writeText(sessionCode);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = sessionCode;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
  const btn = el("copy-code-btn");
  btn.classList.add("copied");
  showToast("Código de sesión copiado");
  setTimeout(() => btn.classList.remove("copied"), 1800);
});

let toastTimer = null;
function showToast(msg) {
  const toast = el("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}
