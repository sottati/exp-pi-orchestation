import { test, expect, describe } from "bun:test";
import {
  McpDisconnectedError,
  parseMcpToolName,
  type McpServerConfig,
} from "./mcp-client";

describe("McpDisconnectedError", () => {
  test("is an Error instance with correct name", () => {
    const err = new McpDisconnectedError("filesystem");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpDisconnectedError");
    expect(err.serverName).toBe("filesystem");
    expect(err.message).toContain("filesystem");
  });
});

describe("parseMcpToolName", () => {
  test("creates namespaced tool name", () => {
    expect(parseMcpToolName("filesystem", "read_file")).toBe("mcp:filesystem/read_file");
  });

  test("handles empty server name", () => {
    expect(parseMcpToolName("", "tool")).toBe("mcp:/tool");
  });
});

describe("McpServerConfig type", () => {
  test("stdio config has required fields", () => {
    const config: McpServerConfig = {
      name: "filesystem",
      transport: "stdio",
      command: "mcp-fs",
      args: ["."],
    };
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("mcp-fs");
  });

  test("http config has required fields", () => {
    const config: McpServerConfig = {
      name: "remote",
      transport: "http",
      url: "http://localhost:8080",
    };
    expect(config.transport).toBe("http");
    expect(config.url).toBe("http://localhost:8080");
  });
});
