"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  CHECK_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  TERMINATION_CONFIRMATION_MS,
  TERMINATION_GRACE_MS,
  checks,
  classify,
  createOutputCollector,
  finalExitCode,
  runChecks,
  runCli,
  runSpawnedCheck,
  sanitize,
  summarize,
} = require("../scripts/run-validation.cjs");

let activeCase = "harness initialization";

function assertionLine(error) {
  try {
    if (!error || error.name !== "AssertionError" || typeof error.stack !== "string") return null;
    const match = error.stack.match(/run-validation-functional\.cjs:(\d+):\d+/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function createProcessDouble(onRegistration) {
  const emitter = new EventEmitter();
  const removedListeners = [];
  const originalRemoveListener = emitter.removeListener.bind(emitter);
  emitter.removeListener = (eventName, listener) => {
    removedListeners.push(eventName);
    return originalRemoveListener(eventName, listener);
  };
  const originalOn = emitter.on.bind(emitter);
  emitter.on = (eventName, listener) => {
    originalOn(eventName, listener);
    onRegistration?.(eventName, listener, emitter);
    return emitter;
  };
  emitter.removedListeners = removedListeners;
  return emitter;
}

function createFakeTimers() {
  let nextId = 0;
  const active = new Map();
  const setCalls = [];
  const clearCalls = [];
  return {
    active,
    setCalls,
    clearCalls,
    setTimeoutFn(callback, delayMs) {
      const id = ++nextId;
      active.set(id, callback);
      setCalls.push({ id, delayMs });
      return id;
    },
    clearTimeoutFn(id) {
      clearCalls.push(id);
      active.delete(id);
    },
    fireNext() {
      const entry = active.entries().next().value;
      assert.ok(entry, "expected a pending fake timer");
      const [id, callback] = entry;
      active.delete(id);
      callback();
      return id;
    },
  };
}

function passingResult() {
  return { status: 0, stdout: "", stderr: "", error: null, signal: null, processStarted: true };
}

function codedError(code, message) {
  const error = new Error(message || "simulated process result");
  error.code = code;
  return error;
}

function createChildDouble(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.unrefCalls = 0;
  child.kill = (signal) => {
    child.killCalls.push(signal || "DEFAULT");
    return true;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  return child;
}

async function main() {
  activeCase = "check manifest and timeout contract";
  assert.deepEqual(
    checks.map(({ name, command, args }) => ({ name, command, args: [...args] })),
    [
      { name: "format", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "format:check"] },
      { name: "typecheck", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "typecheck"] },
      { name: "lint", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "lint"] },
      { name: "build", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "build"] },
      { name: "sql", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "test:sql"] },
      { name: "sql-concurrency", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "test:sql:concurrency"] },
      { name: "notifications-ui", command: "node", args: ["tests/phase-6-notifications-ui-functional.cjs"] },
      { name: "notifications-api", command: "node", args: ["tests/phase-6-notifications-api-functional.cjs"] },
      { name: "web", command: "node", args: ["tests/phase-6-web-functional.cjs"] },
      { name: "household-invitations", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "test:household-invitations"] },
      { name: "household-membership", command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "test:household-membership"] },
      { name: "agent", command: "node", args: ["tests/phase-4-agent-functional.cjs"] },
      { name: "whatsapp", command: "node", args: ["tests/phase-4-whatsapp-functional.cjs"] },
    ],
  );
  assert.equal(checks.length, 13);
  assert.ok(checks.every((check) => check.timeoutMs === CHECK_TIMEOUT_MS));
  assert.ok(Object.isFrozen(checks));
  assert.ok(checks.every((check) => Object.isFrozen(check) && Object.isFrozen(check.args)));
  assert.equal(CHECK_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(MAX_OUTPUT_BYTES, 10 * 1024 * 1024);

  activeCase = "result classification";
  assert.equal(classify(passingResult()), "PASS");
  assert.equal(classify({ status: 1, stdout: "assertion failed", stderr: "" }), "FAIL");
  assert.equal(classify({ error: codedError("EPERM") }), "BLOCKED");
  assert.equal(classify({ error: codedError("ENOENT") }), "SPAWN_ERROR");
  assert.equal(classify({ error: codedError("ETIMEDOUT") }), "TIMEOUT");
  assert.equal(classify({ error: codedError("ENOBUFS") }), "OUTPUT_LIMIT");
  assert.equal(classify({ status: null, signal: "SIGINT" }), "CANCELLED");
  assert.equal(classify({ status: null, stopReason: { kind: "timeout" } }), "TIMEOUT");
  assert.equal(classify({ status: null, stopReason: { kind: "signal", signal: "SIGTERM" } }), "CANCELLED");
  assert.equal(classify({ status: null, stopReason: { kind: "output-limit" } }), "OUTPUT_LIMIT");
  for (const code of ["EACCES", "ENOSPC", "EBUSY", "ENOTEMPTY"]) {
    assert.equal(classify({ error: codedError(code) }), "BLOCKED");
  }
  assert.equal(classify({ status: 1, stderr: "EPERM: operation not permitted" }), "BLOCKED");
  assert.equal(classify({ status: 1, stderr: "EADDRINUSE: address already in use" }), "BLOCKED");
  assert.equal(classify({ status: 1, stdout: "assertion failed: EPERM is a domain value" }), "FAIL");

  activeCase = "final exit-code policy";
  assert.equal(finalExitCode([{ classification: "PASS" }]), 0);
  assert.equal(finalExitCode([{ classification: "FAIL" }]), 1);
  for (const classification of ["BLOCKED", "TIMEOUT", "CANCELLED", "SPAWN_ERROR", "OUTPUT_LIMIT", "NOT_STARTED"]) {
    assert.equal(finalExitCode([{ classification }]), 2);
  }
  assert.equal(finalExitCode([{ classification: "FAIL" }, { classification: "NOT_STARTED" }]), 2);
  assert.equal(finalExitCode([{ classification: "PASS" }], "SIGINT"), 130);
  assert.equal(finalExitCode([{ classification: "PASS" }], "SIGTERM"), 143);

  activeCase = "output collector byte limit";
  const collector = createOutputCollector(10);
  assert.equal(collector.append("stdout", Buffer.from("123456")), true);
  assert.equal(collector.append("stderr", Buffer.from("78901")), false);
  assert.equal(collector.append("stdout", Buffer.from("ignored")), false);
  assert.equal(collector.bytesStored, 10);
  assert.equal(collector.outputLimitExceeded, true);
  assert.deepEqual(collector.snapshot(), {
    stdout: "123456",
    stderr: "7890",
    bytesStored: 10,
    outputLimitExceeded: true,
  });

  activeCase = "diagnostic sanitization";
  for (const sample of [
    "SUPABASE_SERVICE_ROLE_KEY='service secret with spaces'",
    "PASSWORD=private phrase with spaces",
    "CLIENT_SECRET='client secret with spaces'",
    "E2E_NOTIFICATION_B_PASSWORD=second account password with spaces",
    "DATABASE_URL=postgres://db-user:db-password@localhost/test-db",
    JSON.stringify({ SUPABASE_ANON_KEY: "anon-secret-with-tail", ACCESS_TOKEN: "access-token-with-tail" }),
  ]) {
    const safe = sanitize(sample);
    assert.match(safe, /diagnostic omitted/);
    assert.doesNotMatch(safe, /service secret|private phrase|client secret|second account password|db-user|db-password|anon-secret-with-tail|access-token-with-tail/);
  }
  const authorizationSanitized = sanitize("Authorization: Bearer jwt-secret");
  assert.equal(authorizationSanitized, "[diagnostic omitted]");
  assert.doesNotMatch(authorizationSanitized, /jwt-secret/);
  const bearerSanitized = sanitize("Bearer jwt-secret");
  assert.match(bearerSanitized, /Bearer \[redacted\]/);
  assert.doesNotMatch(bearerSanitized, /jwt-secret/);
  const urlSanitized = sanitize("https://user:password@example.supabase.co/path");
  assert.equal(urlSanitized, "[url redacted]");
  assert.doesNotMatch(urlSanitized, /user:password@example/);
  assert.equal(sanitize("ordinary assertion failed"), "ordinary assertion failed");
  assert.equal(sanitize({ toString() { throw new Error("private conversion detail"); } }), "[diagnostic unavailable]");
  assert.equal(summarize({ toString() { throw new Error("private conversion detail"); } }), "[diagnostic unavailable]");
  assert.ok(summarize("x".repeat(400)).length <= 240);

  activeCase = "successful run orchestration";
  const allPassTimers = createFakeTimers();
  const processDouble = createProcessDouble();
  const calls = [];
  const logs = [];
  let fakeClock = 0;
  const successfulRun = await runChecks({
    execute(command, args, options) {
      calls.push({ command, args, options });
      return passingResult();
    },
    cwd: "C:/fake-housemate-worktree",
    processLike: processDouble,
    log: (message) => logs.push(message),
    setTimeoutFn: allPassTimers.setTimeoutFn,
    clearTimeoutFn: allPassTimers.clearTimeoutFn,
    yieldBetweenChecks: async () => {},
    now: () => fakeClock++,
  });
  assert.equal(successfulRun.exitCode, 0);
  assert.equal(successfulRun.results.length, checks.length);
  assert.deepEqual(successfulRun.results.map((result) => result.classification), checks.map(() => "PASS"));
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), checks.map(({ command, args }) => ({ command, args: [...args] })));
  for (const { options, command } of calls) {
    assert.equal(options.cwd, "C:/fake-housemate-worktree");
    assert.equal(options.shell, process.platform === "win32" && command === "npm.cmd");
    assert.equal(options.windowsHide, true);
    assert.equal(options.maxBufferBytes, MAX_OUTPUT_BYTES);
    assert.equal(options.timeoutMs, CHECK_TIMEOUT_MS);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(Object.hasOwn(options, "env"), false);
  }
  assert.equal(allPassTimers.setCalls.length, checks.length);
  assert.equal(allPassTimers.clearCalls.length, checks.length);
  assert.equal(allPassTimers.active.size, 0);
  assert.deepEqual(processDouble.removedListeners, ["SIGINT", "SIGTERM"]);
  assert.ok(logs.some((line) => line.includes("Validation summary")));
  assert.ok(logs.every((line) => !line.includes("SUPABASE") && !line.includes("npm run") && !line.includes("format:check")));

  activeCase = "ordinary failure continues through remaining checks";
  const failureTimers = createFakeTimers();
  let failCalls = 0;
  const continuedRun = await runChecks({
    execute() {
      failCalls += 1;
      return failCalls === 1 ? { status: 1, stdout: "assertion failed", stderr: "" } : passingResult();
    },
    cwd: "C:/fake-housemate-worktree",
    processLike: createProcessDouble(),
    log: () => {},
    setTimeoutFn: failureTimers.setTimeoutFn,
    clearTimeoutFn: failureTimers.clearTimeoutFn,
    yieldBetweenChecks: async () => {},
  });
  assert.equal(continuedRun.exitCode, 1);
  assert.equal(failCalls, checks.length);
  assert.equal(continuedRun.results[0].classification, "FAIL");
  assert.ok(continuedRun.results.slice(1).every((result) => result.classification === "PASS"));
  assert.equal(failureTimers.active.size, 0);

  for (const [expectedClassification, fakeResult] of [
    ["TIMEOUT", { status: null, stopReason: { kind: "timeout" }, termination: { directChild: "UNCONFIRMED", processTree: "UNCONFIRMED" } }],
    ["OUTPUT_LIMIT", { status: null, stopReason: { kind: "output-limit" }, outputLimitExceeded: true }],
    ["SPAWN_ERROR", { status: null, error: codedError("ENOENT") }],
    ["BLOCKED", { status: null, error: codedError("EPERM") }],
  ]) {
    activeCase = "stop classification: " + expectedClassification;
    const stopTimers = createFakeTimers();
    let launchCalls = 0;
    const stoppedRun = await runChecks({
      execute() {
        launchCalls += 1;
        return fakeResult;
      },
      cwd: "C:/fake-housemate-worktree",
      processLike: createProcessDouble(),
      log: () => {},
      setTimeoutFn: stopTimers.setTimeoutFn,
      clearTimeoutFn: stopTimers.clearTimeoutFn,
      yieldBetweenChecks: async () => {},
    });
    assert.equal(launchCalls, 1);
    assert.equal(stoppedRun.results[0].classification, expectedClassification);
    assert.equal(stoppedRun.results[0].executionAttempted, true);
    assert.ok(stoppedRun.results.slice(1).every((result) => result.classification === "NOT_STARTED"));
    assert.equal(stoppedRun.exitCode, 2);
    assert.equal(stopTimers.active.size, 0);
  }

  activeCase = "timeout abort stops the sequence";
  const timeoutTimers = createFakeTimers();
  let timeoutAbortObserved = false;
  const timeoutRun = await runChecks({
    execute(_command, _args, options) {
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          timeoutAbortObserved = options.signal.reason.kind === "timeout";
          resolve({ status: null, stopReason: options.signal.reason });
        }, { once: true });
        timeoutTimers.fireNext();
      });
    },
    cwd: "C:/fake-housemate-worktree",
    processLike: createProcessDouble(),
    log: () => {},
    setTimeoutFn: timeoutTimers.setTimeoutFn,
    clearTimeoutFn: timeoutTimers.clearTimeoutFn,
    yieldBetweenChecks: async () => {},
  });
  assert.equal(timeoutAbortObserved, true);
  assert.equal(timeoutRun.results[0].classification, "TIMEOUT");
  assert.ok(timeoutRun.results.slice(1).every((result) => result.classification === "NOT_STARTED"));
  assert.equal(timeoutRun.exitCode, 2);
  assert.equal(timeoutTimers.active.size, 0);

  for (const signalName of ["SIGINT", "SIGTERM"]) {
    activeCase = "signal between checks: " + signalName;
    let betweenCalls = 0;
    const signalProcess = createProcessDouble();
    const signalRun = await runChecks({
      execute() {
        betweenCalls += 1;
        return passingResult();
      },
      cwd: "C:/fake-housemate-worktree",
      processLike: signalProcess,
      log: () => {},
      yieldBetweenChecks: async () => {
        if (betweenCalls === 1) signalProcess.emit(signalName);
      },
    });
    assert.equal(betweenCalls, 1);
    assert.equal(signalRun.interruptedBy, signalName);
    assert.equal(signalRun.results[0].classification, "PASS");
    assert.equal(signalRun.results[1].classification, "CANCELLED");
    assert.equal(signalRun.results[1].executionAttempted, false);
    assert.ok(signalRun.results.slice(2).every((result) => result.classification === "NOT_STARTED"));
    assert.equal(signalRun.exitCode, signalName === "SIGINT" ? 130 : 143);
    assert.deepEqual(signalProcess.removedListeners, ["SIGINT", "SIGTERM"]);
  }

  activeCase = "signal before first check";
  let preSignalCalls = 0;
  const preSignalProcess = createProcessDouble((eventName, _listener, emitter) => {
    if (eventName === "SIGINT") emitter.emit("SIGINT");
  });
  const preSignalRun = await runChecks({
    execute() {
      preSignalCalls += 1;
      return passingResult();
    },
    cwd: "C:/fake-housemate-worktree",
    processLike: preSignalProcess,
    log: () => {},
    yieldBetweenChecks: async () => {},
  });
  assert.equal(preSignalCalls, 0);
  assert.equal(preSignalRun.interruptedBy, "SIGINT");
  assert.equal(preSignalRun.results[0].classification, "CANCELLED");
  assert.ok(preSignalRun.results.slice(1).every((result) => result.classification === "NOT_STARTED"));
  assert.equal(preSignalRun.exitCode, 130);

  activeCase = "active cancellation preserves the first signal";
  const activeSignalProcess = createProcessDouble();
  let activeLaunches = 0;
  let cancellationRequests = 0;
  let cancellationWaitCompleted = false;
  const activeSignalRun = await runChecks({
    execute(_command, _args, options) {
      activeLaunches += 1;
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          cancellationRequests += 1;
          resolve({
            status: null,
            stopReason: options.signal.reason,
            termination: { directChild: "CONFIRMED", processTree: "UNCONFIRMED" },
          });
          cancellationWaitCompleted = true;
        }, { once: true });
        activeSignalProcess.emit("SIGTERM");
        activeSignalProcess.emit("SIGINT");
      });
    },
    cwd: "C:/fake-housemate-worktree",
    processLike: activeSignalProcess,
    log: () => {},
    yieldBetweenChecks: async () => {},
  });
  assert.equal(activeLaunches, 1);
  assert.equal(cancellationRequests, 1);
  assert.equal(cancellationWaitCompleted, true);
  assert.equal(activeSignalRun.interruptedBy, "SIGTERM");
  assert.equal(activeSignalRun.results[0].classification, "CANCELLED");
  assert.ok(activeSignalRun.results.slice(1).every((result) => result.classification === "NOT_STARTED"));
  assert.equal(activeSignalRun.results.length, checks.length);
  assert.equal(activeSignalRun.exitCode, 143);
  assert.deepEqual(activeSignalProcess.removedListeners, ["SIGINT", "SIGTERM"]);

  activeCase = "executor exception stops the sequence";
  const throwingTimers = createFakeTimers();
  const throwingProcess = createProcessDouble();
  const throwingRun = await runChecks({
    execute() {
      throw new Error("simulated executor failure");
    },
    cwd: "C:/fake-housemate-worktree",
    processLike: throwingProcess,
    log: () => {},
    setTimeoutFn: throwingTimers.setTimeoutFn,
    clearTimeoutFn: throwingTimers.clearTimeoutFn,
    yieldBetweenChecks: async () => {},
  });
  assert.equal(throwingRun.results[0].classification, "SPAWN_ERROR");
  assert.ok(throwingRun.results.slice(1).every((result) => result.classification === "NOT_STARTED"));
  assert.equal(throwingTimers.active.size, 0);
  assert.deepEqual(throwingProcess.removedListeners, ["SIGINT", "SIGTERM"]);

  activeCase = "CLI rejects unsupported arguments";
  const cliTimers = createFakeTimers();
  let unsupportedCalls = 0;
  const cliLogs = [];
  const unsupportedExit = await runCli(["--dry-run"], {
    execute() {
      unsupportedCalls += 1;
      return passingResult();
    },
    processLike: createProcessDouble(),
    log: (message) => cliLogs.push(message),
  });
  assert.equal(unsupportedExit, 64);
  assert.equal(unsupportedCalls, 0);
  assert.ok(cliLogs.every((line) => !line.includes("--dry-run")));
  assert.equal(cliTimers.active.size, 0);

  activeCase = "spawn cancellation with observed close";
  const confirmedTimers = createFakeTimers();
  const confirmedChild = createChildDouble();
  let observedSpawn;
  const confirmedController = new AbortController();
  const confirmedPromise = runSpawnedCheck("npm.cmd", ["run", "validation"], {
    cwd: "C:/fake-housemate-worktree",
    shell: true,
    windowsHide: true,
    maxBufferBytes: 64,
    signal: confirmedController.signal,
    platform: "win32",
    spawnImpl(command, args, options) {
      observedSpawn = { command, args, options };
      return confirmedChild;
    },
    setTimeoutFn: confirmedTimers.setTimeoutFn,
    clearTimeoutFn: confirmedTimers.clearTimeoutFn,
    terminationGraceMs: TERMINATION_GRACE_MS,
    confirmationGraceMs: TERMINATION_CONFIRMATION_MS,
  });
  confirmedChild.emit("spawn");
  confirmedController.abort({ kind: "signal", signal: "SIGTERM" });
  assert.deepEqual(confirmedChild.killCalls, ["DEFAULT"]);
  confirmedChild.emit("close", null, "SIGTERM");
  const confirmedResult = await confirmedPromise;
  assert.equal(observedSpawn.command, "npm.cmd");
  assert.deepEqual(observedSpawn.args, ["run", "validation"]);
  assert.equal(observedSpawn.options.cwd, "C:/fake-housemate-worktree");
  assert.equal(observedSpawn.options.shell, true);
  assert.equal(observedSpawn.options.windowsHide, true);
  assert.deepEqual(observedSpawn.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(Object.hasOwn(observedSpawn.options, "env"), false);
  assert.equal(confirmedResult.termination.directChild, "CONFIRMED");
  assert.equal(confirmedResult.termination.processTree, "UNCONFIRMED");
  assert.equal(confirmedTimers.active.size, 0);
  assert.equal(classify(confirmedResult), "CANCELLED");

  activeCase = "spawn cancellation without observed close";
  const unconfirmedTimers = createFakeTimers();
  const unconfirmedChild = createChildDouble();
  const unconfirmedController = new AbortController();
  const unconfirmedPromise = runSpawnedCheck("npm.cmd", ["run", "validation"], {
    cwd: "C:/fake-housemate-worktree",
    shell: true,
    signal: unconfirmedController.signal,
    platform: "win32",
    spawnImpl: () => unconfirmedChild,
    setTimeoutFn: unconfirmedTimers.setTimeoutFn,
    clearTimeoutFn: unconfirmedTimers.clearTimeoutFn,
    terminationGraceMs: 10,
    confirmationGraceMs: 20,
  });
  unconfirmedChild.emit("spawn");
  unconfirmedController.abort({ kind: "timeout" });
  unconfirmedTimers.fireNext();
  assert.deepEqual(unconfirmedChild.killCalls, ["DEFAULT", "SIGKILL"]);
  unconfirmedTimers.fireNext();
  const unconfirmedResult = await unconfirmedPromise;
  assert.equal(unconfirmedResult.termination.directChild, "UNCONFIRMED");
  assert.equal(unconfirmedResult.termination.processTree, "UNCONFIRMED");
  assert.match(unconfirmedResult.termination.strategy, /not guaranteed/);
  assert.equal(unconfirmedChild.unrefCalls, 1);
  assert.equal(unconfirmedTimers.active.size, 0);
  assert.equal(classify(unconfirmedResult), "TIMEOUT");

  activeCase = "spawn output limit";
  const limitTimers = createFakeTimers();
  const limitChild = createChildDouble();
  const limitController = new AbortController();
  const limitPromise = runSpawnedCheck("node", ["fake-check"], {
    cwd: "C:/fake-housemate-worktree",
    signal: limitController.signal,
    maxBufferBytes: 3,
    spawnImpl: () => limitChild,
    setTimeoutFn: limitTimers.setTimeoutFn,
    clearTimeoutFn: limitTimers.clearTimeoutFn,
    terminationGraceMs: 10,
    confirmationGraceMs: 20,
  });
  limitChild.emit("spawn");
  limitChild.stdout.emit("data", Buffer.from("abcd"));
  assert.deepEqual(limitChild.killCalls, ["DEFAULT"]);
  limitChild.emit("close", null, "SIGTERM");
  const limitedResult = await limitPromise;
  assert.equal(limitedResult.stdout, "abc");
  assert.equal(limitedResult.outputLimitExceeded, true);
  assert.equal(classify(limitedResult), "OUTPUT_LIMIT");
  assert.equal(limitTimers.active.size, 0);

  activeCase = "spawn error classification";
  const spawnErrorTimers = createFakeTimers();
  const failedSpawnChild = createChildDouble(null);
  const failedSpawnPromise = runSpawnedCheck("node", ["missing-fake"], {
    cwd: "C:/fake-housemate-worktree",
    spawnImpl: () => failedSpawnChild,
    setTimeoutFn: spawnErrorTimers.setTimeoutFn,
    clearTimeoutFn: spawnErrorTimers.clearTimeoutFn,
  });
  failedSpawnChild.emit("error", codedError("ENOENT"));
  const failedSpawnResult = await failedSpawnPromise;
  assert.equal(failedSpawnResult.processStarted, false);
  assert.equal(classify(failedSpawnResult), "SPAWN_ERROR");
  assert.equal(spawnErrorTimers.active.size, 0);

  console.log("PASS validation runner async orchestration and safety contracts (injected process/timer doubles)");
}

main().catch((error) => {
  const line = assertionLine(error);
  const location = line ? "; assertion line " + line : "";
  console.error("FAIL " + activeCase + location + "; diagnostic omitted.");
  process.exitCode = 1;
});
