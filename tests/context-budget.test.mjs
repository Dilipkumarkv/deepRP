import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as chats from "../js/chats.js";

test("chats.js exposes the transcript budget to other modules", () => {
  assert.equal(chats.MAX_TRANSCRIPT_CHARS, 12000);
});

test("app.js imports the cross-module symbols it references", async () => {
  const source = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const importBlock = source.slice(0, source.indexOf('} from "./chats.js"'));
  for (const symbol of ["MAX_TRANSCRIPT_CHARS"]) {
    assert.ok(importBlock.includes(symbol), `js/app.js must import ${symbol} from ./chats.js`);
  }
});
