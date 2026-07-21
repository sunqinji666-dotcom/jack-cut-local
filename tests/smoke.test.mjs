import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the local editor keeps its privacy promise and export entry point", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /服务器只发页面，不碰文件/);
  assert.match(html, /Built by Jacksun · 孙秦吉/);
  assert.match(script, /export-btn/);
});
