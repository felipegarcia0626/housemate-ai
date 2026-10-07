const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "database/migrations/0030_household_membership_lifecycle.sql"), "utf8");
const service = fs.readFileSync(path.join(root, "modules/households/membership-lifecycle.service.ts"), "utf8");
const page = fs.readFileSync(path.join(root, "components/household/household-page.tsx"), "utf8");

assert.match(migration, /ADD COLUMN role TEXT/);
assert.match(migration, /ADD COLUMN status TEXT/);
assert.match(migration, /role='OWNER' AND status='ACTIVE'/);
assert.match(migration, /fn_transfer_household_owner/);
assert.match(migration, /fn_remove_household_member/);
assert.match(migration, /fn_leave_household/);
assert.match(migration, /REVOKE EXECUTE/);
assert.match(migration, /GRANT EXECUTE .*service_role/);
assert.match(service, /getAuthenticatedAuthUser/);
assert.match(service, /transferOwnership/);
assert.match(service, /removeHouseholdMember/);
assert.match(service, /leaveMembership/);
assert.match(page, /transfer-owner/);
assert.match(page, /\/leave/);
assert.match(page, /\/members\//);
assert.match(page, /isCurrentUser/);
const membersRoute = fs.readFileSync(path.join(root, "app/api/auth/households/[householdId]/members/route.ts"), "utf8");
assert.match(membersRoute, /membershipId/);
assert.doesNotMatch(membersRoute, /user_id\s*:/);
console.log("PASS household membership lifecycle routes, authorization and UI coverage");
