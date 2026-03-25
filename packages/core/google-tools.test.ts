import { test, expect, describe } from "bun:test";
import { createGoogleSheetsToolEntries } from "./google-sheets-tools";
import { createGoogleDocsToolEntries } from "./google-docs-tools";
import { createGoogleDriveToolEntries } from "./google-drive-tools";
import { createGmailReadToolEntries, createGmailWriteToolEntries } from "./google-mail-tools";
import { createGoogleCalendarToolEntries } from "./google-calendar-tools";
import { createGoogleContactsToolEntries } from "./google-contacts-tools";
import { createGoogleTasksToolEntries } from "./google-tasks-tools";

function extractText(result: any): string {
  return result.content[0].text;
}

// ─── Google Sheets ───────────────────────────────────────────────────

describe("createGoogleSheetsToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createGoogleSheetsToolEntries();
    expect(entries.map(e => e.name)).toEqual(["read_gsheet", "write_gsheet", "create_gsheet"]);
  });

  test("read_gsheet has allow, write/create have hitl permission", () => {
    const entries = createGoogleSheetsToolEntries();
    expect(entries.find(e => e.name === "read_gsheet")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "write_gsheet")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "create_gsheet")!.defaultPermission).toBe("hitl");
  });

  test("all tools have source local, available, and execute", () => {
    const entries = createGoogleSheetsToolEntries();
    for (const entry of entries) {
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
      expect(typeof entry.execute).toBe("function");
    }
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGoogleSheetsToolEntries().find(e => e.name === "read_gsheet")!;
    const raw = await tool.execute("tc1", { spreadsheetId: "fake-id" });
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Google Docs ─────────────────────────────────────────────────────

describe("createGoogleDocsToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createGoogleDocsToolEntries();
    expect(entries.map(e => e.name)).toEqual(["read_gdoc", "write_gdoc", "create_gdoc"]);
  });

  test("read_gdoc has allow, write/create have hitl", () => {
    const entries = createGoogleDocsToolEntries();
    expect(entries.find(e => e.name === "read_gdoc")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "write_gdoc")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "create_gdoc")!.defaultPermission).toBe("hitl");
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGoogleDocsToolEntries().find(e => e.name === "read_gdoc")!;
    const raw = await tool.execute("tc1", { documentId: "fake-id" });
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Google Drive ────────────────────────────────────────────────────

describe("createGoogleDriveToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createGoogleDriveToolEntries();
    expect(entries.map(e => e.name)).toEqual(["drive_list", "drive_search", "drive_download"]);
  });

  test("list/search have allow, download has hitl", () => {
    const entries = createGoogleDriveToolEntries();
    expect(entries.find(e => e.name === "drive_list")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "drive_search")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "drive_download")!.defaultPermission).toBe("hitl");
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGoogleDriveToolEntries().find(e => e.name === "drive_list")!;
    const raw = await tool.execute("tc1", {});
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Gmail Read ──────────────────────────────────────────────────────

describe("createGmailReadToolEntries", () => {
  test("returns 2 tools with correct names", () => {
    const entries = createGmailReadToolEntries();
    expect(entries.map(e => e.name)).toEqual(["gmail_search", "gmail_read"]);
  });

  test("both have allow permission", () => {
    const entries = createGmailReadToolEntries();
    for (const entry of entries) {
      expect(entry.defaultPermission).toBe("allow");
    }
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGmailReadToolEntries().find(e => e.name === "gmail_search")!;
    const raw = await tool.execute("tc1", { query: "is:unread" });
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Gmail Write ─────────────────────────────────────────────────────

describe("createGmailWriteToolEntries", () => {
  test("returns 2 tools with correct names", () => {
    const entries = createGmailWriteToolEntries();
    expect(entries.map(e => e.name)).toEqual(["gmail_send", "gmail_draft"]);
  });

  test("both have hitl permission", () => {
    const entries = createGmailWriteToolEntries();
    for (const entry of entries) {
      expect(entry.defaultPermission).toBe("hitl");
    }
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGmailWriteToolEntries().find(e => e.name === "gmail_send")!;
    const raw = await tool.execute("tc1", { to: "x@x.com", subject: "Test", body: "Hi" });
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Google Calendar ─────────────────────────────────────────────────

describe("createGoogleCalendarToolEntries", () => {
  test("returns 4 tools with correct names", () => {
    const entries = createGoogleCalendarToolEntries();
    expect(entries.map(e => e.name)).toEqual(["calendar_list", "calendar_create", "calendar_update", "calendar_delete"]);
  });

  test("list has allow, create/update/delete have hitl", () => {
    const entries = createGoogleCalendarToolEntries();
    expect(entries.find(e => e.name === "calendar_list")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "calendar_create")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "calendar_update")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "calendar_delete")!.defaultPermission).toBe("hitl");
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGoogleCalendarToolEntries().find(e => e.name === "calendar_list")!;
    const raw = await tool.execute("tc1", {});
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Google Contacts ─────────────────────────────────────────────────

describe("createGoogleContactsToolEntries", () => {
  test("returns 2 tools with correct names", () => {
    const entries = createGoogleContactsToolEntries();
    expect(entries.map(e => e.name)).toEqual(["contacts_search", "contacts_create"]);
  });

  test("search has allow, create has hitl", () => {
    const entries = createGoogleContactsToolEntries();
    expect(entries.find(e => e.name === "contacts_search")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "contacts_create")!.defaultPermission).toBe("hitl");
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGoogleContactsToolEntries().find(e => e.name === "contacts_search")!;
    const raw = await tool.execute("tc1", { query: "John" });
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Google Tasks ────────────────────────────────────────────────────

describe("createGoogleTasksToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createGoogleTasksToolEntries();
    expect(entries.map(e => e.name)).toEqual(["tasks_list", "tasks_create", "tasks_complete"]);
  });

  test("list has allow, create/complete have hitl", () => {
    const entries = createGoogleTasksToolEntries();
    expect(entries.find(e => e.name === "tasks_list")!.defaultPermission).toBe("allow");
    expect(entries.find(e => e.name === "tasks_create")!.defaultPermission).toBe("hitl");
    expect(entries.find(e => e.name === "tasks_complete")!.defaultPermission).toBe("hitl");
  });

  test("returns credential error when no credentials", async () => {
    const tool = createGoogleTasksToolEntries().find(e => e.name === "tasks_list")!;
    const raw = await tool.execute("tc1", {});
    expect(extractText(raw)).toContain("Google credentials not found");
  });
});

// ─── Cross-cutting: all Google tools summary ─────────────────────────

describe("Google tools total count", () => {
  test("22 Google tools total across all modules", () => {
    const all = [
      ...createGoogleSheetsToolEntries(),     // 3
      ...createGoogleDocsToolEntries(),        // 3
      ...createGoogleDriveToolEntries(),       // 3
      ...createGmailReadToolEntries(),         // 2
      ...createGmailWriteToolEntries(),        // 2
      ...createGoogleCalendarToolEntries(),    // 4
      ...createGoogleContactsToolEntries(),    // 2
      ...createGoogleTasksToolEntries(),       // 3
    ];
    expect(all.length).toBe(22);

    // All have required fields
    for (const entry of all) {
      expect(entry.name).toBeTruthy();
      expect(entry.source).toBe("local");
      expect(entry.available).toBe(true);
      expect(entry.description).toBeTruthy();
      expect(entry.parameters).toBeTruthy();
      expect(typeof entry.execute).toBe("function");
    }

    // No duplicate names
    const names = all.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
