// Reusable E2E session/request helper. The implementation lives beside the
// control runner so future API and browser diagnostics use the same auth path.
const {
  createAuthenticatedCookieHeader,
  requestJson,
} = require("./agent-authenticated.cjs");

module.exports = {
  getE2ECookieHeader: createAuthenticatedCookieHeader,
  authenticatedRequest: requestJson,
};
