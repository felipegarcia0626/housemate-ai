const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const getRoute = fs.readFileSync(path.join(root, "app", "api", "notifications", "route.ts"), "utf8");
const readRoute = fs.readFileSync(path.join(root, "app", "api", "notifications", "[id]", "read", "route.ts"), "utf8");
const readAllRoute = fs.readFileSync(path.join(root, "app", "api", "notifications", "read-all", "route.ts"), "utf8");
const service = fs.readFileSync(path.join(root, "modules", "notifications", "notification.service.ts"), "utf8");
const types = fs.readFileSync(path.join(root, "modules", "notifications", "notification.types.ts"), "utf8");

assert.match(getRoute, /export async function GET/);
assert.match(getRoute, /listNotifications\(/);
assert.match(getRoute, /unreadOnly/);
assert.match(getRoute, /householdId/);
assert.match(getRoute, /nextCursor/);
assert.doesNotMatch(getRoute, /recipientUserId.*searchParams|searchParams.*recipientUserId/);
assert.match(readRoute, /export async function POST/);
assert.match(readRoute, /markNotificationAsRead\(id\)/);
assert.match(readAllRoute, /markAllNotificationsAsRead\(\)/);
assert.match(service, /getAuthenticatedAuthUser\(\)/);
assert.match(service, /findApplicationUserByAuthUserId/);
assert.match(service, /findActiveMembershipsByUserId/);
assert.match(service, /NotificationNotFoundError/);
assert.match(types, /"HOUSEHOLD_INVITATION"/);
assert.match(types, /"HOUSEHOLD_MEMBER"/);
assert.match(types, /"HOUSEHOLD"/);
assert.doesNotMatch(types, /S extends "INVITATION" \| "MEMBERSHIP"/);
console.log("PASS notifications API route contracts and server-side identity wiring");
