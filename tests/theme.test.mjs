import test from "node:test";
import assert from "node:assert/strict";
import { resolveTheme, nextTheme } from "../js/theme.js";

test("resolveTheme restores an explicit saved preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("resolveTheme follows the system only without a valid preference", () => {
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(null, false), "light");
  assert.equal(resolveTheme("blue", true), "dark");
});

test("nextTheme alternates between both modes", () => {
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "light");
});
