"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workflow = fs.readFileSync(path.join(__dirname, "../../.github/workflows/render-keepalive.yml"), "utf8");
const script = workflow.split("node <<'NODE'\n")[1].split("          NODE")[0]
  .replace(/^          /gm, "");

async function run({ url = "https://example.test/", hour = 12, replies = [200] } = {}) {
  const logs = [], calls = [];
  const context = {
    require: () => ({ setTimeout: async () => {} }),
    URL, AbortSignal, Date,
    Intl: { DateTimeFormat: class { format() { return String(hour); } } },
    process: { env: { RENDER_BACKEND_URL: url }, exitCode: 0 },
    console: { log: (s) => logs.push(s), error: (s) => logs.push(s) },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return { status: reply, body: { cancel: async () => {} } };
    },
  };
  await vm.runInNewContext(script.replace("main().catch", "globalThis.completion = main().catch"), context);
  return { logs: logs.join("\n"), calls, code: context.process.exitCode };
}

test("cron cubre todos los días de 08:00 a 21:46 con intervalos exactos de 14 minutos", () => {
  const times = [];
  const entries = [...workflow.matchAll(/cron: '([^']+)'\n\s+timezone: (\S+)/g)];
  assert.equal(entries.length, 7);
  for (const [, cron, zone] of entries) {
    assert.equal(zone, "America/Argentina/Buenos_Aires");
    const [minutes, hours, ...days] = cron.split(" ");
    assert.deepEqual(days, ["*", "*", "*"]);
    for (const hour of hours.split(",").map(Number)) {
      for (const minute of minutes.split(",").map(Number)) times.push(hour * 60 + minute);
    }
  }
  times.sort((a, b) => a - b);
  assert.equal(times.length, 60);
  assert.equal(times[0], 8 * 60);
  assert.equal(times.at(-1), 21 * 60 + 46);
  times.slice(1).forEach((time, i) => assert.equal(time - times[i], 14));
});

test("construye /health sin barras duplicadas y acepta solamente HTTP 200", async () => {
  for (const url of ["https://example.test", "https://example.test/", "https://example.test///"]) {
    const result = await run({ url });
    assert.equal(result.code, 0);
    assert.equal(result.calls[0].url, "https://example.test/health");
    assert.equal(result.calls[0].options.redirect, "manual");
    assert.match(result.logs, /HTTP 200/);
  }
  for (const status of [301, 404, 500]) {
    const result = await run({ replies: [status] });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, status === 500 ? 2 : 1);
    assert.match(result.logs, new RegExp(`HTTP ${status}`));
  }
});

test("configuración inválida falla sin peticiones ni exposición del valor", async () => {
  for (const url of ["", "invalid", "http://example.test", "https://user:secret@example.test", "https://example.test/api", "https://example.test/?token=secret", "https://example.test/#secret"]) {
    const result = await run({ url });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.match(result.logs, /RENDER_BACKEND_URL/);
    assert.doesNotMatch(result.logs, /secret/);
  }
});

test("fallos de conexión y timeout tienen logs claros y reintentos limitados", async () => {
  for (const error of [new Error("private network details"), Object.assign(new Error("private"), { name: "TimeoutError" })]) {
    const result = await run({ replies: [error] });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 2);
    assert.match(result.logs, /Timeout:|Error de conexión:/);
    assert.doesNotMatch(result.logs, /private/);
  }
  const coldStart = await run({ replies: [503, 200] });
  assert.equal(coldStart.code, 0);
  assert.equal(coldStart.calls.length, 2);
});

test("ejecuciones manuales y retrasadas respetan los límites horarios", async () => {
  for (const hour of [0, 7, 22, 23]) {
    const result = await run({ hour });
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 0);
    assert.match(result.logs, /fuera de/);
  }
  for (const hour of [8, 21]) assert.equal((await run({ hour })).calls.length, 1);
});
