"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const violations = [];

for (const relative of tracked) {
  const normalized = relative.replaceAll("\\", "/");
  if (/(^|\/)uploads\/(?!\.gitkeep$)/i.test(normalized)) violations.push(`${relative}: archivo dentro de uploads`);
  if (/(^|\/)\.env(?:\.|$)/i.test(normalized) && !normalized.endsWith(".env.example")) violations.push(`${relative}: archivo de entorno`);
  if (/\.(?:pdf|pem|key|p12|pfx)$/i.test(normalized)) violations.push(`${relative}: tipo de archivo sensible`);
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.size > 5 * 1024 * 1024) violations.push(`${relative}: supera 5 MB`);
  if (stat.size <= 1024 * 1024) {
    const content = fs.readFileSync(absolute, "utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(content)) violations.push(`${relative}: posible clave privada`);
  }
}

if (violations.length) {
  console.error("Archivos que requieren revisión:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Repositorio actual sin uploads, PDFs, credenciales o claves privadas rastreadas.");
}
