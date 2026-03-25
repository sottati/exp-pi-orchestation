import { test, expect, describe } from "bun:test";
import { createExplorerToolEntries, redactActions } from "./explorer-tools";
import { CredentialStore } from "./credential-store";

describe("createExplorerToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createExplorerToolEntries({});
    const names = entries.map(e => e.name);
    expect(names).toEqual(["browse_url", "search_web", "interact_page"]);
  });

  test("browse_url and search_web have allow permission", () => {
    const entries = createExplorerToolEntries({});
    const perms = Object.fromEntries(entries.map(e => [e.name, e.defaultPermission]));
    expect(perms["browse_url"]).toBe("allow");
    expect(perms["search_web"]).toBe("allow");
  });

  test("interact_page has hitl permission", () => {
    const entries = createExplorerToolEntries({});
    const tool = entries.find(e => e.name === "interact_page")!;
    expect(tool.defaultPermission).toBe("hitl");
  });

  test("all tools have source local and are available", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
    }
  });

  test("all tools have description and parameters", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }
  });
});

describe("redactActions", () => {
  test("masks password fill values", () => {
    const actions = [
      { type: "fill" as const, selector: "[name=username]", value: "alice" },
      { type: "fill" as const, selector: "[type=password]", value: "secret123" },
      { type: "fill" as const, selector: "#password-field", value: "hidden" },
      { type: "click" as const, selector: "#submit" },
    ];
    const redacted = redactActions(actions);
    expect(redacted[0]).toEqual({ type: "fill", selector: "[name=username]", value: "alice" });
    expect(redacted[1]).toEqual({ type: "fill", selector: "[type=password]", value: "***REDACTED***" });
    expect(redacted[2]).toEqual({ type: "fill", selector: "#password-field", value: "***REDACTED***" });
    expect(redacted[3]).toEqual({ type: "click", selector: "#submit" });
  });
});
