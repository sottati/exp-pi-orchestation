import { test, expect, describe } from "bun:test";
import { createExplorerToolEntries } from "./explorer-tools";

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

  test("all tools have description, parameters, and execute function", () => {
    const entries = createExplorerToolEntries({});
    for (const entry of entries) {
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }
  });

  test("interact_page parameters have url and task (not actions)", () => {
    const entries = createExplorerToolEntries({});
    const interactTool = entries.find(e => e.name === "interact_page")!;
    const schema = interactTool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("url");
    expect(schema.properties).toHaveProperty("task");
    expect(schema.properties).not.toHaveProperty("actions");
    expect(schema.properties).not.toHaveProperty("followUpUrls");
  });
});
