const {
  prepareExpenseFixtures,
  cleanupExpenseFixtures,
} = require("./fixtures.cjs");

module.exports = async function globalSetup() {
  const fixtures = await prepareExpenseFixtures();
  return async function globalTeardown() {
    await cleanupExpenseFixtures(fixtures);
  };
};
