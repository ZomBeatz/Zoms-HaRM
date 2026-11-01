// Opens every page, tab, ⋯ menu and dialog of the interface in a real browser, on the demo's made-up
// data, and fails on anything that goes wrong: an error in the browser, a page that can't be shown,
// a page wider than a phone screen, or the AI switch not hiding what it should.
//
//   node tests/pages_test.mjs            (starts its own demo on port 8199; needs Chromium or Chrome,
//                                         or set CHROME=/path/to/chrome)
//
// Runs on GitHub with every change (.github/workflows/tests.yml).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8199, DEBUG_PORT = 9399;
const APP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const fail = (where, what) => { problems.push(`${where}: ${what}`); console.log(`  ✗ ${where}: ${what}`); };

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try { execFileSync("which", [c], { stdio: "ignore" }); return c; } catch { /* next */ }
  }
  throw new Error("Chromium or Chrome is needed (or set CHROME=/path/to/chrome).");
}

// The demo: HaRM with made-up data, in a throwaway folder.
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const demo = spawn(python, ["scripts/demo.py", "--port", String(PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  demo.stdout.on("data", (b) => { if (String(b).includes("Demo running")) resolve(); });
  demo.on("exit", (code) => reject(new Error(`The demo stopped (exit ${code}).`)));
  setTimeout(() => reject(new Error("The demo didn't start within 90 seconds.")), 90000);
});

const profile = mkdtempSync(join(tmpdir(), "harm-pages-"));
const chrome = spawn(findChrome(), ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) (waiting.get(d.id)(d), waiting.delete(d.id));
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type))
    errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
};
const cdp = (method, params = {}) => new Promise((r) => { const i = ++n; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const size = (w, h, mobile) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
// Wait until the page has drawn and stopped changing.
const settle = `const txt = () => document.querySelector('#view')?.innerText || ''; let prev = '', same = 0;
  for (let i = 0; i < 50 && same < 3; i++) { await new Promise((r) => setTimeout(r, 100)); const t = txt(); if (t === prev && t.length) same++; else same = 0; prev = t; }
  return prev;`;
const errorsSince = (i) => errors.slice(i).filter((e) => !/serviceworker|service worker/i.test(e));

try {
  await cdp("Runtime.enable");
  await size(1440, 900, false);
  await cdp("Page.navigate", { url: APP });
  await sleep(1500);
  await ev(`await fetch("/api/auth/login", { method: "POST", headers: { "X-HaRM": "1", "Content-Type": "application/json" }, body: JSON.stringify({ password: "demo-password" }) });`);
  await cdp("Page.navigate", { url: APP + "/?pages-test" });
  await sleep(2000);

  const ids = await ev(`const get = (p) => fetch("/api" + p, { headers: { "X-HaRM": "1" } }).then((r) => r.json());
    const out = {}; for (const k of ["devices", "racks", "locations", "networks", "builds", "clusters"]) out[k] = (await get("/" + k)).map((x) => x.id); return out;`);
  const routes = ["/dashboard", "/status", "/actions", "/uptime", "/devices", "/racks", "/components", "/connections", "/locations",
    "/networks", "/discover", "/virtual", "/setup", "/builds", "/library", "/export", "/tasks", "/help", "/vault", "/audit", "/settings",
    "/search?q=pve", ...Object.entries(ids).flatMap(([k, list]) => list.map((id) => `/${k === "clusters" ? "clusters" : k}/${id}`))];

  console.log(`Pages, tabs and menus (${routes.length} pages)`);
  for (const r of routes) {
    const e0 = errors.length;
    await ev(`Object.keys(localStorage).filter((k) => k.startsWith("harm-tab-")).forEach((k) => localStorage.removeItem(k)); location.hash = ${JSON.stringify("#" + r)};`);
    await sleep(150);
    const text = await ev(settle);
    const bad = await ev(`return [...document.querySelectorAll('#view .form-error')].map((e) => e.innerText).filter(Boolean).join('; ')`);
    if (!text.trim()) fail(r, "the page is empty");
    if (/Page not found|couldn’t be shown/.test(text)) fail(r, text.split("\n")[0]);
    if (bad) fail(r, bad);
    const tabs = await ev(`return [...document.querySelectorAll('#view [role=tab]')].map((b) => b.dataset.tab)`);
    for (const t of tabs) {
      await ev(`document.querySelector('#view [role=tab][data-tab="${t}"]').click()`);
      if (!(await ev(settle)).trim()) fail(`${r} (${t} tab)`, "the tab is empty");
    }
    const menus = await ev(`return [...document.querySelectorAll('#view button')].filter((b) => b.textContent.trim().startsWith('⋯')).length`);
    for (let i = 0; i < menus; i++) {
      const items = await ev(`const b = [...document.querySelectorAll('#view button')].filter((b) => b.textContent.trim().startsWith('⋯'))[${i}]; b.click();
        await new Promise((r) => setTimeout(r, 150)); const m = [...document.querySelectorAll('[role=menu]')].find((m) => !m.hidden && m.offsetParent);
        const t = m ? m.innerText : ''; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return t;`);
      if (!items.trim()) fail(r, `⋯ menu ${i + 1} opens empty`);
    }
    for (const e of errorsSince(e0)) fail(r, e);
  }

  console.log("Dialogs");
  const kinds = ["locations", "racks", "devices", "device_slots", "components", "clusters", "networks", "interfaces", "builds", "services", "connections"];
  const dialogs = kinds.map((k) => [`new ${k}`, `harm.editEntity('${k}', {})`]).concat([
    ["new login", "harm.editCredential({})"], ["new action", "harm.editAction({})"], ["alerts", "await harm.editAlerts()"],
    ["new devices on the network", "await harm.editNetwatch()"], ["AI Assist", "await harm.aiAssist()"], ["phone setup", "await harm.phoneAppHelp()"],
    ["scanner", "harm.scanDialog({ title: 'Scan label', targets: [{ k: 'serial', label: 'Serial' }], onPick: () => {} })"]]);
  for (const [name, call] of dialogs) {
    const e0 = errors.length;
    await cdp("Page.navigate", { url: `${APP}/?dialog=${encodeURIComponent(name)}#/devices` });
    await sleep(1500);
    await ev(`Object.keys(localStorage).filter((k) => k.startsWith('harm-draft')).forEach((k) => localStorage.removeItem(k)); ${call};`);
    await sleep(800);
    if (!(await ev(`return !!document.querySelector('.modal')`))) fail(name, "the dialog didn't open");
    for (const e of errorsSince(e0)) fail(name, e);
  }

  console.log("Phone width");
  await size(375, 812, true);
  for (const r of routes) {
    await ev(`location.hash = ${JSON.stringify("#" + r)};`);
    await sleep(150);
    await ev(settle);
    const tabs = await ev(`return [...document.querySelectorAll('#view [role=tab]')].map((b) => b.dataset.tab)`);
    for (const t of [null, ...tabs]) {
      if (t) { await ev(`document.querySelector('#view [role=tab][data-tab="${t}"]').click()`); await ev(settle); }
      const w = await ev(`return document.documentElement.scrollWidth`);
      if (w > 376) fail(`${r}${t ? ` (${t} tab)` : ""}`, `${w}px wide on a 375px phone`);
    }
  }
  await size(1440, 900, false);

  console.log("AI switch");
  const aiShown = () => ev(`location.hash = '#/components'; await new Promise((r) => setTimeout(r, 1200));
    const page = [...document.querySelectorAll('#view button')].some((b) => b.textContent.includes('AI Assist'));
    const menu = document.querySelector('.qa-menu')?.innerHTML.includes('AI Assist');
    const server = (await fetch('/api/ai/prompt', { method: 'POST', headers: { 'X-HaRM': '1', 'Content-Type': 'application/json' }, body: '{}' })).status;
    return { page, menu, server };`);
  const setAi = (on) => ev(`location.hash = '#/settings'; await new Promise((r) => setTimeout(r, 1500));
    const box = [...document.querySelectorAll('#view label.check')].find((l) => l.innerText.includes('Use AI features')).querySelector('input');
    if (box.checked !== ${on}) box.click(); await new Promise((r) => setTimeout(r, 1200));`);
  let s = await aiShown();
  if (!s.page || !s.menu || s.server !== 200) fail("AI on", JSON.stringify(s));
  await setAi(false);
  s = await aiShown();
  if (s.page || s.menu || s.server !== 403) fail("AI off", JSON.stringify(s));
  await setAi(true);
  s = await aiShown();
  if (!s.page || !s.menu || s.server !== 200) fail("AI back on", JSON.stringify(s));
} catch (e) {
  fail("test", e.message);
} finally {
  chrome.kill();
  demo.kill("SIGINT");
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} found.`);
  process.exit(1);
}
console.log("\nEverything opened without problems.");
process.exit(0);
