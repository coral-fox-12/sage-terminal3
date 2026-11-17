// Tests for t3/lib.mjs — pure helpers only. No network, no API key.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildDescriptor,
  contractName,
  decodeExecuteResult,
  describeSecret,
  requireEnv,
  sha256Hex,
  sourceHash,
  tenantIdFromDid,
} from "../t3/lib.mjs";

test("sha256Hex matches Node crypto on known vectors", () => {
  assert.equal(
    sha256Hex(Buffer.from("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(sha256Hex(Buffer.from("abc")), createHash("sha256").update("abc").digest("hex"));
  assert.equal(sha256Hex("NVDA"), createHash("sha256").update("NVDA").digest("hex"));
});

test("describeSecret never contains the secret", () => {
  const key = "test-secret-key-material-1234567890";
  const desc = describeSecret(key);
  assert.ok(!desc.includes("test-secret"));
  assert.ok(!desc.includes("1234567890"));
  assert.ok(desc.includes(String(key.length)));
});

test("requireEnv throws naming the missing variable", () => {
  delete process.env.T3_DEFINITELY_NOT_SET_XYZ;
  assert.throws(() => requireEnv("T3_DEFINITELY_NOT_SET_XYZ"), /T3_DEFINITELY_NOT_SET_XYZ/);
  process.env.T3_DEFINITELY_NOT_SET_XYZ = "x";
  assert.equal(requireEnv("T3_DEFINITELY_NOT_SET_XYZ"), "x");
  delete process.env.T3_DEFINITELY_NOT_SET_XYZ;
});

test("tenantIdFromDid / contractName", () => {
  const did = "did:t3n:abcdef0123456789abcdef0123456789abcdef01";
  assert.equal(tenantIdFromDid(did), "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(contractName(did), "z:abcdef0123456789abcdef0123456789abcdef01:sage-private-brief");
  assert.throws(() => tenantIdFromDid("not-a-did"), /Unexpected tenant DID/);
});

test("decodeExecuteResult handles string JSON, plain strings and objects", () => {
  assert.deepEqual(decodeExecuteResult('{"key":"abc","bytes":12}'), { key: "abc", bytes: 12 });
  assert.equal(decodeExecuteResult("not json"), "not json");
  assert.deepEqual(decodeExecuteResult({ key: "abc" }), { key: "abc" });
  assert.equal(decodeExecuteResult(null), null);
});

test("buildDescriptor has a non-empty functions array matching the contract", () => {
  const d = buildDescriptor();
  assert.equal(typeof d.summary, "string");
  assert.ok(d.summary.length > 0);
  assert.ok(Array.isArray(d.functions) && d.functions.length === 2);
  assert.deepEqual(
    d.functions.map((f) => f.name).sort(),
    ["private-rewrite", "seal-brief"]
  );
  for (const f of d.functions) {
    assert.equal(typeof f.summary, "string");
    assert.ok(f.summary.length > 0);
    assert.equal(typeof f.input, "object");
    assert.equal(typeof f.output, "object");
  }
});

test("sourceHash is deterministic and 64 hex chars", async () => {
  const a = await sourceHash();
  const b = await sourceHash();
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
