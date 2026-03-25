import { test, expect, describe, afterAll } from "bun:test";
import { createAnalystToolEntries } from "./analyst-tools";
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

function extractText(result: any): string {
  return result.content[0].text;
}

describe("createAnalystToolEntries", () => {
  test("returns 4 tools with correct names", () => {
    const entries = createAnalystToolEntries();
    const names = entries.map(e => e.name);
    expect(names).toEqual(["query_sqlite", "query_supabase", "parse_csv", "analyze_data"]);
  });

  test("query_sqlite and query_supabase have hitl permission", () => {
    const entries = createAnalystToolEntries();
    expect(entries.find(e => e.name === "query_sqlite")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "query_supabase")!.defaultPermission).toBe("hitl");
  });

  test("parse_csv and analyze_data have allow permission", () => {
    const entries = createAnalystToolEntries();
    const perms = Object.fromEntries(entries.map(e => [e.name, e.defaultPermission]));
    expect(perms["parse_csv"]).toBe("allow");
    expect(perms["analyze_data"]).toBe("allow");
  });

  test("all tools have source local and are available", () => {
    const entries = createAnalystToolEntries();
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
    }
  });

  test("all tools have description and execute function", () => {
    const entries = createAnalystToolEntries();
    for (const entry of entries) {
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }
  });
});

describe("query_sqlite", () => {
  const testDir = join(tmpdir(), `analyst-test-${Date.now()}`);
  const dbPath = join(testDir, "test.db");

  const getQueryTool = () => {
    const entries = createAnalystToolEntries();
    return entries.find(e => e.name === "query_sqlite")!;
  };

  // Setup: create test DB once
  mkdirSync(testDir, { recursive: true });
  const setupDb = new Database(dbPath);
  setupDb.run("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, price REAL)");
  setupDb.run("INSERT INTO items (name, price) VALUES ('apple', 1.5), ('banana', 0.75), ('cherry', 3.0)");
  setupDb.close();

  afterAll(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  test("executes SELECT query on a real SQLite database", async () => {
    const tool = getQueryTool();
    const raw = await tool.execute("tc1", { dbPath, query: "SELECT * FROM items" });
    const result = JSON.parse(extractText(raw));
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].name).toBe("apple");
  });

  test("rejects non-SELECT queries", async () => {
    const tool = getQueryTool();
    const raw = await tool.execute("tc2", { dbPath: ":memory:", query: "DROP TABLE items" });
    const text = extractText(raw);
    expect(text).toContain("Only read-only queries are allowed");
  });

  test("returns error for non-existent database", async () => {
    const tool = getQueryTool();
    const raw = await tool.execute("tc3", { dbPath: "/nonexistent/path.db", query: "SELECT 1" });
    const text = extractText(raw);
    expect(text).toContain("Error:");
  });
});

describe("query_supabase", () => {
  const getSupabaseTool = () => {
    const entries = createAnalystToolEntries();
    return entries.find(e => e.name === "query_supabase")!;
  };

  test("rejects non-SELECT queries", async () => {
    const tool = getSupabaseTool();
    const raw = await tool.execute("tc-sb1", { query: "DROP TABLE users" });
    const text = extractText(raw);
    expect(text).toContain("Only read-only queries are allowed");
  });

  test("rejects INSERT queries", async () => {
    const tool = getSupabaseTool();
    const raw = await tool.execute("tc-sb2", { query: "INSERT INTO users (name) VALUES ('x')" });
    const text = extractText(raw);
    expect(text).toContain("Only read-only queries are allowed");
  });

  test("returns error when no connection URL is available", async () => {
    // No DATABASE_URL in env, no supabaseUrl in opts, no connectionUrl param
    const entries = createAnalystToolEntries({ supabaseUrl: undefined });
    const tool = entries.find(e => e.name === "query_supabase")!;
    const originalEnv = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const raw = await tool.execute("tc-sb3", { query: "SELECT 1" });
      const text = extractText(raw);
      expect(text).toContain("No connection URL provided");
    } finally {
      if (originalEnv !== undefined) process.env.DATABASE_URL = originalEnv;
    }
  });

  test("returns error for invalid connection URL", async () => {
    const tool = getSupabaseTool();
    const raw = await tool.execute("tc-sb4", {
      query: "SELECT 1",
      connectionUrl: "postgres://invalid:invalid@localhost:59999/nonexistent",
    });
    const text = extractText(raw);
    expect(text).toContain("Error:");
  });

  test("accepts WITH as a valid read-only keyword", async () => {
    const tool = getSupabaseTool();
    // Will fail on connection but should pass the keyword check
    const raw = await tool.execute("tc-sb5", {
      query: "WITH cte AS (SELECT 1) SELECT * FROM cte",
      connectionUrl: "postgres://invalid:invalid@localhost:59999/nonexistent",
    });
    const text = extractText(raw);
    // Should get a connection error, not a "read-only" rejection
    expect(text).not.toContain("Only read-only queries are allowed");
    expect(text).toContain("Error:");
  });
});

describe("parse_csv", () => {
  const testDir = join(tmpdir(), `analyst-csv-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const getCsvTool = () => {
    const entries = createAnalystToolEntries();
    return entries.find(e => e.name === "parse_csv")!;
  };

  afterAll(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  test("parses a simple CSV with headers", async () => {
    const csvPath = join(testDir, "test.csv");
    await Bun.write(csvPath, "name,age,city\nAlice,30,NYC\nBob,25,LA\n");

    const tool = getCsvTool();
    const raw = await tool.execute("tc4", { filePath: csvPath });
    const result = JSON.parse(extractText(raw));
    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(["name", "age", "city"]);
    expect(result.rows[0]).toEqual({ name: "Alice", age: "30", city: "NYC" });
  });

  test("parses CSV without headers", async () => {
    const csvPath = join(testDir, "noheader.csv");
    await Bun.write(csvPath, "Alice,30\nBob,25\n");

    const tool = getCsvTool();
    const raw = await tool.execute("tc5", { filePath: csvPath, hasHeader: false });
    const result = JSON.parse(extractText(raw));
    expect(result.columns).toEqual(["col_0", "col_1"]);
    expect(result.rows[0]).toEqual({ col_0: "Alice", col_1: "30" });
  });

  test("handles custom delimiter", async () => {
    const csvPath = join(testDir, "tab.csv");
    await Bun.write(csvPath, "name\tage\nAlice\t30\n");

    const tool = getCsvTool();
    const raw = await tool.execute("tc6", { filePath: csvPath, delimiter: "\t" });
    const result = JSON.parse(extractText(raw));
    expect(result.rows[0]).toEqual({ name: "Alice", age: "30" });
  });

  test("returns error for non-existent file", async () => {
    const tool = getCsvTool();
    const raw = await tool.execute("tc7", { filePath: "/nonexistent/file.csv" });
    const text = extractText(raw);
    expect(text).toContain("Error:");
  });
});

describe("analyze_data", () => {
  const getAnalyzeTool = () => {
    const entries = createAnalystToolEntries();
    return entries.find(e => e.name === "analyze_data")!;
  };

  test("computes numeric stats", async () => {
    const tool = getAnalyzeTool();
    const data = [
      { value: 10, label: "a" },
      { value: 20, label: "b" },
      { value: 30, label: "c" },
      { value: 40, label: "a" },
    ];
    const raw = await tool.execute("tc8", { data, columns: ["value"] });
    const result = JSON.parse(extractText(raw));
    expect(result.stats.value.type).toBe("numeric");
    expect(result.stats.value.min).toBe(10);
    expect(result.stats.value.max).toBe(40);
    expect(result.stats.value.mean).toBe(25);
    expect(result.stats.value.median).toBe(25);
    expect(result.stats.value.count).toBe(4);
  });

  test("computes text stats", async () => {
    const tool = getAnalyzeTool();
    const data = [
      { name: "Alice" },
      { name: "Bob" },
      { name: "Alice" },
    ];
    const raw = await tool.execute("tc9", { data, columns: ["name"] });
    const result = JSON.parse(extractText(raw));
    expect(result.stats.name.type).toBe("text");
    expect(result.stats.name.count).toBe(3);
    expect(result.stats.name.unique).toBe(2);
  });

  test("returns error for empty data", async () => {
    const tool = getAnalyzeTool();
    const raw = await tool.execute("tc10", { data: [] });
    const text = extractText(raw);
    expect(text).toContain("empty");
  });
});
