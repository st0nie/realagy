import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ImageResults } from "../src/image-results.js";

test("image results are staged once, visible to the native viewer, and removed on cleanup", () => {
 const root = mkdtempSync(join(tmpdir(), "realagy-image-test-"));
 const images = new ImageResults(root);
 try {
  const image = { data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" };
  const first = images.result("pi read output", false, [image]);
  assert.equal(first.isError, false);
  assert.equal(first.content.length, 1);
  assert.equal(first.content[0].type, "text");
  const text = first.content[0].type === "text" ? first.content[0].text : "";
  assert.match(text, /native view_file/);
  const path = JSON.parse(text.match(/Image 1: (".*")/)![1]) as string;
  assert.equal(readFileSync(path).toString("base64"), image.data);
  assert.deepEqual(images.result("pi read output", false, [image]), first);
  assert.equal(readdirSync(root).length, 1);
  images.clear();
  assert.equal(existsSync(path), false);
 } finally { images.clear(); rmSync(root, { recursive: true, force: true }); }
});

test("text outputs remain unchanged and staging failures are explicit", () => {
 const images = new ImageResults();
 assert.deepEqual(images.result("hello", false, []), { content: [{ type: "text", text: "hello" }], isError: false });
 const result = images.result("output", false, [{ data: "", mimeType: "image/png" }]);
 assert.equal(result.isError, true);
 assert.match(result.content[0].type === "text" ? result.content[0].text : "", /Image delivery failed/);
});
