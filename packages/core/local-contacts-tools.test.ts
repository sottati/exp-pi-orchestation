import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalContactsToolEntries } from "./local-contacts-tools";

function textFromResult(result: any): string {
  return result.content?.[0]?.text ?? "";
}

describe("createLocalContactsToolEntries", () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function makeEntries() {
    dataDir = await mkdtemp(join(tmpdir(), "secretary-contacts-"));
    return createLocalContactsToolEntries({ dataDir });
  }

  test("returns expected tool names and permissions", async () => {
    const entries = await makeEntries();
    expect(entries.map((entry) => entry.name)).toEqual([
      "contacts_list",
      "contacts_read",
      "contacts_search",
      "contacts_create",
      "contacts_delete",
    ]);

    expect(entries.find((entry) => entry.name === "contacts_list")!.defaultPermission).toBe("allow");
    expect(entries.find((entry) => entry.name === "contacts_read")!.defaultPermission).toBe("allow");
    expect(entries.find((entry) => entry.name === "contacts_search")!.defaultPermission).toBe("allow");
    expect(entries.find((entry) => entry.name === "contacts_create")!.defaultPermission).toBe("hitl");
    expect(entries.find((entry) => entry.name === "contacts_delete")!.defaultPermission).toBe("hitl");
  });

  test("creates, lists, reads, and deletes contacts", async () => {
    const entries = await makeEntries();
    const createTool = entries.find((entry) => entry.name === "contacts_create")!;
    const listTool = entries.find((entry) => entry.name === "contacts_list")!;
    const readTool = entries.find((entry) => entry.name === "contacts_read")!;
    const deleteTool = entries.find((entry) => entry.name === "contacts_delete")!;

    const create = await createTool.execute("tc-create", {
      givenName: "Ana",
      familyName: "Mora",
      email: "ana@example.com",
      phone: "+54 11 5555-1111",
    });
    expect(textFromResult(create)).toContain("Contact saved:");
    const created = (create.details as any)?.contact;
    expect(created?.contactId).toBeTruthy();
    expect(created?.name).toBe("Ana Mora");

    const list = await listTool.execute("tc-list", {});
    const listed = (list.details as any)?.contacts ?? [];
    expect((list.details as any)?.totalContacts).toBe(1);
    expect(listed[0].contactId).toBe(created.contactId);

    const read = await readTool.execute("tc-read", { contactId: created.contactId });
    expect((read.details as any)?.found).toBe(true);
    expect((read.details as any)?.contact?.emails).toContain("ana@example.com");

    const deleted = await deleteTool.execute("tc-delete", { contactId: created.contactId });
    expect(textFromResult(deleted)).toContain("Contact deleted:");
    expect((deleted.details as any)?.deleted).toBe(true);

    const listAfterDelete = await listTool.execute("tc-list-2", {});
    expect((listAfterDelete.details as any)?.totalContacts).toBe(0);
  });

  test("searches contacts by partial query", async () => {
    const entries = await makeEntries();
    const createTool = entries.find((entry) => entry.name === "contacts_create")!;
    const searchTool = entries.find((entry) => entry.name === "contacts_search")!;

    await createTool.execute("tc-create-a", {
      name: "Amorina Perez",
      emails: ["amorina@example.com"],
      tags: ["familia"],
    });
    await createTool.execute("tc-create-b", {
      name: "Luis Castro",
      emails: ["luis@example.com"],
    });

    const search = await searchTool.execute("tc-search", { query: "Amo" });
    const contacts = (search.details as any)?.contacts ?? [];
    expect(contacts.length).toBe(1);
    expect(contacts[0].name).toBe("Amorina Perez");
  });

  test("requires at least name, email, or phone when creating", async () => {
    const entries = await makeEntries();
    const createTool = entries.find((entry) => entry.name === "contacts_create")!;
    const result = await createTool.execute("tc-invalid", {});
    expect(textFromResult(result)).toContain("Error: a contact needs at least a name, email, or phone.");
  });
});
