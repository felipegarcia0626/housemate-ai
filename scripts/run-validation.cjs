"use strict";

const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_CONFIRMATION_MS = 5_000;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const checks = Object.freeze([
  { name: "format", command: npmCommand, args: ["run", "format:check"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "typecheck", command: npmCommand, args: ["run", "typecheck"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "lint", command: npmCommand, args: ["run", "lint"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "build", command: npmCommand, args: ["run", "build"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "sql", command: npmCommand, args: ["run", "test:sql"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "sql-concurrency", command: npmCommand, args: ["run", "test:sql:concurrency"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "notifications-ui", command: "node", args: ["tests/phase-6-notifications-ui-functional.cjs"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "notifications-api", command: "node", args: ["tests/phase-6-notifications-api-functional.cjs"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "web", command: "node", args: ["tests/phase-6-web-functional.cjs"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "household-invitations", command: npmCommand, args: ["run", "test:household-invitations"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "household-membership", command: npmCommand, args: ["run", "test:household-membership"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "agent", command: "node", args: ["tests/phase-4-agent-functional.cjs"], timeoutMs: CHECK_TIMEOUT_MS },
  { name: "whatsapp", command: "node", args: ["tests/phase-4-whatsapp-functional.cjs"], timeoutMs: CHECK_TIMEOUT_MS },
].map((check) => Object.freeze({ ...check, args: Object.freeze(check.args) })));

const BLOCKED_ERROR_CODES = new Set(["EPERM", "EACCES", "ENOSPC", "EBUSY", "ENOTEMPTY"]);
const STOP_STATUSES = new Set(["BLOCKED", "TIMEOUT", "CANCELLED", "SPAWN_ERROR", "OUTPUT_LIMIT"]);
const KNOWN_BLOCKED_OUTPUT = /(?:EPERM|EACCES):\s*(?:operation not permitted|permission denied)|EADDRINUSE:\s*address already in use/i;
const SENSITIVE_ASSIGNMENT = /\b[A-Z0-9_.-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|COOKIE|AUTHORIZATION|DATABASE_URL|_URL|_URI)\b["']?\s*[:=]\s*["']?/i;
const URL_PATTERN = /\b(?:https?|wss?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const MAX_DIAGNOSTIC_CHARS = 240;

function readProperty(value, name) {
  try {
    return value == null ? undefined : value[name];
  } catch {
    return undefined;
  }
}

function sanitize(value) {
  // Pattern-based redaction is a defense-in-depth measure, not a universal secret detector.
  let message;
  try {
    message = typeof value === "string" ? value : String(value);
  } catch {
    return "[diagnostic unavailable]";
  }

  if (SENSITIVE_ASSIGNMENT.test(message)) return "[diagnostic omitted]";
  message = message
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(URL_PATTERN, "[url redacted]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  message = message.replace(/\s+/g, " ").trim();
  if (!message) return "[no diagnostic]";
  return message.length > MAX_DIAGNOSTIC_CHARS
    ? message.slice(0, MAX_DIAGNOSTIC_CHARS - 1) + "…"
    : message;
}

function summarize(value) {
  return sanitize(value);
}

function createOutputCollector(maxBytes = MAX_OUTPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }

  const chunks = { stdout: [], stderr: [] };
  let bytesStored = 0;
  let outputLimitExceeded = false;

  function append(channel, value) {
    if (channel !== "stdout" && channel !== "stderr") {
      throw new TypeError("output channel must be stdout or stderr");
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const available = Math.max(0, maxBytes - bytesStored);
    const retainedLength = Math.min(available, chunk.length);
    if (retainedLength > 0) {
      chunks[channel].push(Buffer.from(chunk.subarray(0, retainedLength)));
      bytesStored += retainedLength;
    }
    if (retainedLength < chunk.length) outputLimitExceeded = true;
    return !outputLimitExceeded;
  }

  function snapshot() {
    return {
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      bytesStored,
      outputLimitExceeded,
    };
  }

  return {
    append,
    snapshot,
    get bytesStored() {
      return bytesStored;
    },
    get outputLimitExceeded() {
      return outputLimitExceeded;
    },
  };
}

function normalizeStopReason(reason) {
  const kind = readProperty(reason, "kind");
  if (kind === "timeout" || kind === "output-limit" || kind === "signal") {
    return {
      kind,
      signal: kind === "signal" ? readProperty(reason, "signal") || null : null,
    };
  }
  return { kind: "signal", signal: null };
}

function classify(result = {}) {
  const stopReason = readProperty(result, "stopReason");
  const stopKind = readProperty(stopReason, "kind");
  if (stopKind === "timeout") return "TIMEOUT";
  if (stopKind === "signal") return "CANCELLED";
  if (stopKind === "output-limit" || readProperty(result, "outputLimitExceeded") === true) return "OUTPUT_LIMIT";
  if (readProperty(result, "signal")) return "CANCELLED";

  const error = readProperty(result, "error");
  if (error) {
    const code = readProperty(error, "code");
    if (code === "ETIMEDOUT") return "TIMEOUT";
    if (code === "ENOBUFS") return "OUTPUT_LIMIT";
    if (BLOCKED_ERROR_CODES.has(code)) return "BLOCKED";
    return "SPAWN_ERROR";
  }

  const status = readProperty(result, "status") ?? readProperty(result, "exitCode");
  if (!Number.isInteger(status)) return "SPAWN_ERROR";
  if (status === 0) return "PASS";

  const stdout = readProperty(result, "stdout");
  const stderr = readProperty(result, "stderr");
  const diagnostic = (typeof stdout === "string" ? stdout : "") + "\n" + (typeof stderr === "string" ? stderr : "");
  return KNOWN_BLOCKED_OUTPUT.test(diagnostic) ? "BLOCKED" : "FAIL";
}

function finalExitCode(results, interruptedBy = null) {
  if (interruptedBy === "SIGINT") return 130;
  if (interruptedBy === "SIGTERM") return 143;
  if (results.some((result) => !["PASS", "FAIL"].includes(result.classification))) return 2;
  if (results.some((result) => result.classification === "FAIL")) return 1;
  return 0;
}

function safeClearTimeout(clearTimeoutFn, handle) {
  if (handle === undefined || handle === null) return;
  try {
    clearTimeoutFn(handle);
  } catch {
    // Cleanup is best-effort; no timer handle or diagnostic is logged.
  }
}

function runSpawnedCheck(command, args, options = {}) {
  const {
    cwd,
    shell = false,
    windowsHide = true,
    maxBufferBytes = MAX_OUTPUT_BYTES,
    signal,
    spawnImpl = spawn,
    platform = process.platform,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    terminationGraceMs = TERMINATION_GRACE_MS,
    confirmationGraceMs = TERMINATION_CONFIRMATION_MS,
  } = options;

  const collector = createOutputCollector(maxBufferBytes);
  const snapshot = () => collector.snapshot();
  const base = (extra = {}) => ({ ...snapshot(), processStarted: false, ...extra });
  if (signal?.aborted) {
    return Promise.resolve(base({ status: null, signal: null, stopReason: normalizeStopReason(signal.reason) }));
  }

  return new Promise((resolve) => {
    let child;
    let processStarted = false;
    let settled = false;
    let spawnError = null;
    let stopReason = null;
    let killTimer;
    let confirmationTimer;
    const streamHandlers = [];

    function removeListener(target, eventName, handler) {
      try {
        target?.removeListener?.(eventName, handler);
      } catch {
        // Listener cleanup is best-effort and intentionally silent.
      }
    }

    function cleanup() {
      safeClearTimeout(clearTimeoutFn, killTimer);
      safeClearTimeout(clearTimeoutFn, confirmationTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (child) {
        removeListener(child, "spawn", onSpawn);
        removeListener(child, "error", onError);
        removeListener(child, "close", onClose);
      }
      for (const [stream, eventName, handler] of streamHandlers) removeListener(stream, eventName, handler);
    }

    function finish(extra = {}) {
      if (settled) return;
      settled = true;
      if (extra.termination?.directChild === "UNCONFIRMED") {
        try {
          child?.unref?.();
          child?.stdout?.unref?.();
          child?.stderr?.unref?.();
        } catch {
          // Unref is best-effort; termination remains explicitly unconfirmed.
        }
      }
      cleanup();
      resolve({
        ...snapshot(),
        processStarted,
        status: null,
        signal: null,
        error: null,
        stopReason,
        ...extra,
      });
    }

    function scheduleConfirmation() {
      try {
        confirmationTimer = setTimeoutFn(() => {
          finish({
            termination: {
              directChild: "UNCONFIRMED",
              processTree: "UNCONFIRMED",
              strategy: "direct-child termination attempts only; process-tree termination is not guaranteed",
              platform,
            },
          });
        }, confirmationGraceMs);
      } catch {
        finish({
          termination: {
            directChild: "UNCONFIRMED",
            processTree: "UNCONFIRMED",
            strategy: "termination timer unavailable; process-tree termination is not guaranteed",
            platform,
          },
        });
      }
    }

    function requestStop(reason) {
      if (settled || stopReason) return;
      stopReason = normalizeStopReason(reason);
      try {
        child.kill();
      } catch {
        // The result records unconfirmed termination if close is never observed.
      }
      try {
        killTimer = setTimeoutFn(() => {
          if (settled) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // No platform-independent tree-kill guarantee is available here.
          }
          scheduleConfirmation();
        }, terminationGraceMs);
      } catch {
        finish({
          termination: {
            directChild: "UNCONFIRMED",
            processTree: "UNCONFIRMED",
            strategy: "direct-child termination attempt only; confirmation timer unavailable",
            platform,
          },
        });
      }
    }

    function onSpawn() {
      processStarted = true;
    }

    function onError(error) {
      spawnError = error;
      if (!processStarted && child?.pid == null) {
        finish({
          status: null,
          error,
          termination: stopReason
            ? { directChild: "NOT_STARTED", processTree: "NOT_STARTED", platform }
            : undefined,
        });
      }
    }

    function onClose(code, childSignal) {
      processStarted = processStarted || child?.pid != null;
      finish({
        status: code,
        signal: childSignal,
        error: spawnError,
        termination: stopReason
          ? {
              directChild: "CONFIRMED",
              processTree: "UNCONFIRMED",
              strategy: "direct child close observed; descendant termination is not guaranteed",
              platform,
            }
          : undefined,
      });
    }

    function onAbort() {
      requestStop(signal.reason);
    }

    try {
      child = spawnImpl(command, args, {
        cwd,
        shell,
        windowsHide,
        stdio: ["ignore", "pipe", "pipe"],
      });
      processStarted = child?.pid != null;
    } catch (error) {
      finish({ status: null, error });
      return;
    }

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("close", onClose);

    for (const [channel, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
      if (!stream?.on) continue;
      const handler = (chunk) => {
        if (!collector.append(channel, chunk)) requestStop({ kind: "output-limit" });
      };
      const streamErrorHandler = () => {
        // Stream diagnostics are not trusted or logged; child close/error determines the result.
      };
      stream.on("data", handler);
      stream.on("error", streamErrorHandler);
      streamHandlers.push([stream, "data", handler], [stream, "error", streamErrorHandler]);
    }

    if (signal?.addEventListener) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function diagnosticFor(result) {
  const error = readProperty(result, "error");
  if (error) {
    const message = readProperty(error, "message");
    if (typeof message === "string" && message) return sanitize(message);
  }
  const stdout = readProperty(result, "stdout");
  const stderr = readProperty(result, "stderr");
  const combined = [stdout, stderr].filter((part) => typeof part === "string" && part.length > 0).join(" ");
  return combined ? sanitize(combined) : null;
}

function writeLog(log, message) {
  try {
    log(message);
  } catch {
    // A logging sink must not alter check orchestration or result classification.
  }
}

function printSummary(results, exitCode, interruptedBy, log) {
  writeLog(log, "Validation summary:");
  for (const result of results) {
    const duration = Number.isFinite(result.durationMs) ? " (" + Math.round(result.durationMs) + " ms)" : "";
    const diagnostic = result.diagnostic ? " — " + result.diagnostic : "";
    writeLog(log, result.name + ": " + result.classification + duration + diagnostic);
    if (result.termination?.processTree === "UNCONFIRMED") {
      writeLog(log, result.name + ": process-tree termination UNCONFIRMED; only the direct child was targeted.");
    }
  }
  if (interruptedBy) writeLog(log, "Validation interrupted by " + interruptedBy + "; no later check was started.");
  writeLog(log, "Validation exit code: " + exitCode);
}

function markNotStarted(results, startIndex) {
  for (let index = startIndex; index < checks.length; index += 1) {
    results.push({
      name: checks[index].name,
      classification: "NOT_STARTED",
      executionAttempted: false,
      processStarted: false,
      durationMs: 0,
      diagnostic: null,
      termination: null,
    });
  }
}

async function runChecks({
  execute = runSpawnedCheck,
  cwd = process.cwd(),
  processLike = process,
  log = console.log,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  yieldBetweenChecks = () => new Promise((resolve) => setImmediate(resolve)),
  now = () => performance.now(),
} = {}) {
  const results = [];
  let interruptedBy = null;
  let activeController = null;
  const handleSignal = (signalName) => {
    if (interruptedBy) return;
    interruptedBy = signalName;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort({ kind: "signal", signal: signalName });
    }
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");

  let sigintRegistered = false;
  let sigtermRegistered = false;
  try {
    processLike.on("SIGINT", onSigint);
    sigintRegistered = true;
    processLike.on("SIGTERM", onSigterm);
    sigtermRegistered = true;

    for (let index = 0; index < checks.length; index += 1) {
      const check = checks[index];
      if (interruptedBy) {
        results.push({
          name: check.name,
          classification: "CANCELLED",
          executionAttempted: false,
          processStarted: false,
          durationMs: 0,
          diagnostic: null,
          termination: null,
        });
        markNotStarted(results, index + 1);
        break;
      }

      const controller = new AbortController();
      activeController = controller;
      let timeoutTriggered = false;
      let timerHandle;
      const startedAt = now();
      let executionResult;
      let executionError;
      try {
        timerHandle = setTimeoutFn(() => {
          if (controller.signal.aborted) return;
          timeoutTriggered = true;
          controller.abort({ kind: "timeout" });
        }, check.timeoutMs);
        executionResult = await execute(check.command, [...check.args], {
          cwd,
          shell: process.platform === "win32" && check.command === "npm.cmd",
          windowsHide: true,
          maxBufferBytes: MAX_OUTPUT_BYTES,
          timeoutMs: check.timeoutMs,
          signal: controller.signal,
        });
      } catch (error) {
        executionError = error;
      } finally {
        safeClearTimeout(clearTimeoutFn, timerHandle);
        if (activeController === controller) activeController = null;
      }

      const durationMs = Math.max(0, now() - startedAt);
      const result = executionError
        ? { status: null, error: executionError }
        : executionResult && typeof executionResult === "object"
          ? executionResult
          : { status: null, error: new Error("executor returned no result") };
      let classification;
      if (timeoutTriggered) classification = "TIMEOUT";
      else if (controller.signal.aborted && readProperty(controller.signal.reason, "kind") === "signal") {
        classification = "CANCELLED";
      } else {
        classification = classify(result);
      }

      results.push({
        name: check.name,
        classification,
        executionAttempted: true,
        processStarted: readProperty(result, "processStarted") ?? null,
        durationMs,
        diagnostic: ["PASS", "CANCELLED"].includes(classification) ? null : diagnosticFor(result),
        termination: readProperty(result, "termination") ?? null,
      });

      if (STOP_STATUSES.has(classification)) {
        markNotStarted(results, index + 1);
        break;
      }

      if (index < checks.length - 1) {
        try {
          await yieldBetweenChecks();
        } catch {
          results[results.length - 1].diagnostic = "[runner scheduling failed before the next check]";
          markNotStarted(results, index + 1);
          break;
        }
      }
    }
  } finally {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort({ kind: "signal", signal: interruptedBy });
    }
    if (sigintRegistered) {
      try {
        processLike.removeListener("SIGINT", onSigint);
      } catch {
        // Best-effort listener cleanup.
      }
    }
    if (sigtermRegistered) {
      try {
        processLike.removeListener("SIGTERM", onSigterm);
      } catch {
        // Best-effort listener cleanup.
      }
    }
  }

  const exitCode = finalExitCode(results, interruptedBy);
  printSummary(results, exitCode, interruptedBy, log);
  return { exitCode, results, interruptedBy };
}

async function runCli(args = process.argv.slice(2), dependencies = {}) {
  if (args.length > 0) {
    writeLog(dependencies.log || console.log, "Usage: node scripts/run-validation.cjs");
    return 64;
  }
  const result = await runChecks(dependencies);
  return result.exitCode;
}

if (require.main === module) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("Validation runner failed; diagnostic omitted.");
      process.exitCode = 2;
    });
}

module.exports = {
  BLOCKED_ERROR_CODES,
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
};
