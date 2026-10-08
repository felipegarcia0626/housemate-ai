const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const component = fs.readFileSync(path.join(root, "components", "notifications", "notifications-bell.tsx"), "utf8");
const page = fs.readFileSync(path.join(root, "app", "page.tsx"), "utf8");

assert.match(component, /export function NotificationsBell/);
assert.match(page, /NotificationsBell[\s\S]{0,180}userId=\{session\?\.user\.id\}/);
assert.match(component, /\/api\/notifications\?limit=20&unreadOnly=false/);
assert.match(component, /cursor=/);
assert.match(component, /\/api\/notifications\/\$\{notification\.id\}\/read/);
assert.match(component, /\/api\/notifications\/read-all/);
assert.match(component, /AbortController/);
assert.match(component, /generation/);
assert.match(component, /aria-label="Notificaciones"/);
assert.match(component, /aria-expanded=\{open\}/);
assert.match(component, /aria-controls=\{panelId\}/);
assert.match(component, /Escape/);
assert.match(component, /role="status"/);
assert.match(component, /role="alert"/);
assert.doesNotMatch(component, /onAuthStateChange|getSession|visibilitychange|setInterval|supabase/);
assert.doesNotMatch(page, /notifications-bell.*getSession|NotificationsBell[\s\S]{0,1000}onAuthStateChange/);
console.log("PASS notifications UI contract, API consumption, fencing, accessibility and scope");
