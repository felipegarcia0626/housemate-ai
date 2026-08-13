const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const routeModule = path.join(
  root,
  "app",
  "api",
  "receipts",
  "analyze",
  "route.ts",
);
const serviceModule = path.join(
  root,
  "modules",
  "receipts",
  "receipt.service.ts",
);
const typesModule = path.join(root, "modules", "receipts", "receipt.types.ts");
const repositoryModule = path.join(
  root,
  "modules",
  "receipts",
  "receipt.repository.ts",
);
const contextModule = path.join(root, "app", "api", "_lib", "http-context.ts");
const ocrModule = path.join(
  root,
  "infrastructure",
  "openai",
  "receipt-ocr.adapter.ts",
);
const storageModule = path.join(
  root,
  "infrastructure",
  "storage",
  "receipt-storage.adapter.ts",
);

const householdId = "42000000-0000-4000-8000-000000000001";
const conversationKey = "receipt-test-conversation";
const receiptId = "52000000-0000-4000-8000-000000000001";

function deterministicReceipt(status = "PROCESSED") {
  return {
    id: receiptId,
    householdId,
    conversationKey,
    storagePath: `receipts/${receiptId}.jpg`,
    originalFilename: "ticket.jpg",
    mimeType: "image/jpeg",
    uploadedAt: "2026-08-12T12:00:00.000Z",
    processingStatus: status,
    analysis: {
      merchant: "Demo Market",
      date: "2026-08-12",
      totalAmount: 185000,
      items: [
        { name: "Arroz", quantity: 2, unitPrice: 5000, totalPrice: 10000 },
      ],
      missingFields: [],
    },
  };
}

function createLoader(overrides = new Map()) {
  const cache = new Map();

  function resolve(specifier, parent) {
    if (specifier.startsWith("@/"))
      return path.join(root, `${specifier.slice(2)}.ts`);
    if (specifier.startsWith(".")) {
      return path.resolve(path.dirname(parent), `${specifier}.ts`);
    }
    return null;
  }

  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loaded = { exports: {} };
    cache.set(resolved, loaded);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (specifier) => {
      const target = resolve(specifier, resolved);
      return target ? load(target) : require(specifier);
    };
    new Function("require", "module", "exports", output)(
      localRequire,
      loaded,
      loaded.exports,
    );
    return loaded.exports;
  }

  return load;
}

async function routeChecks() {
  const calls = [];
  class FakeReceiptDomainError extends Error {
    constructor(code, message, receiptId) {
      super(message);
      this.code = code;
      this.receiptId = receiptId;
    }
  }
  let mode = "success";
  const fakeReceiptService = {
    async analyzeReceipt(context, request) {
      calls.push({ context, request });
      if (mode === "conflict") {
        throw new FakeReceiptDomainError(
          "ACTIVE_RECEIPT_EXISTS",
          "database details should stay hidden",
        );
      }
      if (mode === "analysis-error") {
        throw new FakeReceiptDomainError(
          "ANALYSIS_ERROR",
          "https://api.openai.com/internal",
          receiptId,
        );
      }
      return deterministicReceipt(mode === "pending" ? "PENDING" : "PROCESSED");
    },
  };
  const fakeContext = {
    getConfiguredHttpHouseholdContext: async () => ({ householdId }),
    getConfiguredHttpConversationKey: () => conversationKey,
  };
  const load = createLoader(
    new Map([
      [contextModule, fakeContext],
      [serviceModule, fakeReceiptService],
      [typesModule, { ReceiptDomainError: FakeReceiptDomainError }],
    ]),
  );
  const route = load(routeModule);

  const image = new File([new Uint8Array([1, 2, 3])], "ticket.jpg", {
    type: "image/jpeg",
  });
  const created = await route.POST(
    new Request("https://example.test/api/receipts/analyze", {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.set("file", image);
        return form;
      })(),
    }),
  );
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).data, {
    receiptId,
    storagePath: `receipts/${receiptId}.jpg`,
    processingStatus: "PROCESSED",
    merchant: "Demo Market",
    date: "2026-08-12",
    totalAmount: 185000,
    items: [{ name: "Arroz", quantity: 2, unitPrice: 5000, totalPrice: 10000 }],
    missingFields: [],
  });
  assert.equal(calls[0].context.householdId, householdId);
  assert.equal(calls[0].context.conversationKey, conversationKey);
  assert.equal(calls[0].request.kind, "NEW");
  console.log("PASS receipt route delegates controlled multipart analysis");

  const retried = await route.POST(
    new Request("https://example.test/api/receipts/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiptId }),
    }),
  );
  assert.equal(retried.status, 200);
  assert.equal(calls.at(-1).request.kind, "RETRY");
  console.log(
    "PASS receipt retry uses receiptId without accepting context input",
  );

  const clarified = await route.POST(
    new Request("https://example.test/api/receipts/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receiptId,
        clarifications: { merchant: "Clarified" },
      }),
    }),
  );
  assert.equal(clarified.status, 200);
  assert.equal(calls.at(-1).request.kind, "CLARIFY");
  console.log("PASS receipt clarification delegates to the service");

  const invalidQuery = await route.POST(
    new Request(
      "https://example.test/api/receipts/analyze?householdId=other-household",
      { method: "POST", body: new FormData() },
    ),
  );
  assert.equal(invalidQuery.status, 422);
  console.log("PASS receipt route rejects client-controlled household query");

  mode = "conflict";
  const conflict = await route.POST(
    new Request("https://example.test/api/receipts/analyze", {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.set("file", image);
        return form;
      })(),
    }),
  );
  assert.equal(conflict.status, 409);
  assert.ok(!(await conflict.text()).includes("database details"));
  console.log("PASS active receipt conflicts are sanitized");

  mode = "analysis-error";
  const failed = await route.POST(
    new Request("https://example.test/api/receipts/analyze", {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.set("file", image);
        return form;
      })(),
    }),
  );
  assert.equal(failed.status, 500);
  const failureBody = await failed.json();
  assert.equal(failureBody.error.code, "INTERNAL_ERROR");
  assert.equal(failureBody.receiptId, receiptId);
  assert.ok(!JSON.stringify(failureBody).includes("api.openai.com"));
  console.log("PASS OCR errors expose only sanitized status and receiptId");

  const routeSource = fs.readFileSync(routeModule, "utf8");
  assert.ok(!routeSource.includes("getSupabaseAdminClient"));
  assert.ok(!routeSource.includes("receipt.repository"));
  assert.ok(!routeSource.includes(".from("));
  assert.ok(!routeSource.includes(".rpc("));
  console.log("PASS receipt route has no direct persistence/provider access");
}

async function serviceChecks() {
  const state = { receipt: null, updates: [] };
  const fakeRepository = {
    async findActiveReceipt() {
      return null;
    },
    async findReceipt() {
      return state.receipt;
    },
    async createReceipt(input) {
      state.receipt = {
        ...deterministicReceipt("PENDING"),
        id: input.id,
        storagePath: input.storagePath,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        analysis: input.analysis,
      };
      return state.receipt;
    },
    async updateReceiptAnalysis(input) {
      state.updates.push(input.processingStatus);
      state.receipt = {
        ...state.receipt,
        processingStatus: input.processingStatus,
        analysis: input.analysis,
      };
      return state.receipt;
    },
    async deleteReceipt() {
      state.receipt = null;
    },
    ReceiptRepositoryError: class ReceiptRepositoryError extends Error {},
  };
  const load = createLoader(new Map([[repositoryModule, fakeRepository]]));
  const service = load(serviceModule);
  const dependencies = {
    uploadImage: async () => {},
    downloadImage: async () => new Uint8Array([1]),
    deleteImage: async () => {},
    analyzeImage: async () => ({
      merchant: "Demo Market",
      date: "2026-08-12",
      totalAmount: 100,
      items: [],
      missingFields: [],
    }),
  };
  const context = { householdId, conversationKey };
  const result = await service.analyzeReceipt(
    context,
    {
      kind: "NEW",
      image: {
        bytes: new Uint8Array([1]),
        originalFilename: "ticket.jpg",
        mimeType: "image/jpeg",
      },
    },
    dependencies,
  );
  assert.equal(result.processingStatus, "PROCESSED");
  assert.equal(state.updates.at(-1), "PROCESSED");
  console.log("PASS Receipt service transitions complete OCR to PROCESSED");

  const failingDependencies = {
    ...dependencies,
    analyzeImage: async () => {
      throw new Error("provider details must remain internal");
    },
  };
  await assert.rejects(
    service.analyzeReceipt(
      context,
      {
        kind: "NEW",
        image: {
          bytes: new Uint8Array([1]),
          originalFilename: "ticket.jpg",
          mimeType: "image/jpeg",
        },
      },
      failingDependencies,
    ),
    (error) =>
      error.code === "ANALYSIS_ERROR" &&
      !String(error.message).includes("provider details"),
  );
  assert.equal(state.receipt.processingStatus, "FAILED");
  console.log(
    "PASS OCR failure persists FAILED without exposing provider details",
  );

  const retry = await service.analyzeReceipt(
    context,
    { kind: "RETRY", receiptId: state.receipt.id },
    dependencies,
  );
  assert.equal(retry.processingStatus, "PROCESSED");
  assert.ok(state.updates.includes("PENDING"));
  console.log(
    "PASS FAILED receipt retry returns to PENDING and then PROCESSED",
  );

  state.receipt.processingStatus = "PENDING";
  state.receipt.analysis = {
    merchant: null,
    date: null,
    totalAmount: null,
    items: [],
    missingFields: ["merchant", "date", "totalAmount"],
  };
  const clarified = await service.analyzeReceipt(
    context,
    {
      kind: "CLARIFY",
      receiptId: state.receipt.id,
      clarifications: {
        merchant: "Clarified",
        date: "2026-08-12",
        totalAmount: 100,
      },
    },
    dependencies,
  );
  assert.equal(clarified.processingStatus, "PROCESSED");
  console.log("PASS Receipt service completes PENDING clarification");
}

async function main() {
  await routeChecks();
  await serviceChecks();
  console.log("Receipt functional harness: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
