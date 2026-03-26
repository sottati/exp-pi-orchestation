import { test, expect } from "bun:test";
import { createFrontendToolEntries } from "./frontend-tools";

test("createFrontendToolEntries returns 3 tools", () => {
  const tools = createFrontendToolEntries();
  expect(tools.length).toBe(3);
  const names = tools.map(t => t.name).sort();
  expect(names).toEqual(["check_responsive", "preview_page", "validate_accessibility"]);
});

test("all frontend tools have allow permission", () => {
  const tools = createFrontendToolEntries();
  for (const t of tools) {
    expect(t.defaultPermission).toBe("allow");
  }
});

test("all frontend tools are available", () => {
  const tools = createFrontendToolEntries();
  for (const t of tools) {
    expect(t.available).toBe(true);
  }
});

// Note: Full browser-based tests require Playwright chromium.
// These are covered by smoke:web-designer integration test.
