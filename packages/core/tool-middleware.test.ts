import { test, expect, describe } from "bun:test";
import { wrapTool, type HITLHandler, type HITLRequest } from "./tool-middleware";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Permission } from "./contracts";

function fakeTool(name = "test_tool"): AgentTool<any> {
  return {
    name,
    label: name,
    description: "test",
    parameters: Type.Object({ input: Type.String() }),
    execute: async (_id: string, params: any) => ({
      content: [{ type: "text" as const, text: `result:${params.input}` }],
    }),
  };
}

const approveAll: HITLHandler = async () => ({ approved: true });
const denyAll: HITLHandler = async () => ({ approved: false });
const noopTrace = async () => {};

describe("wrapTool", () => {
  test("allow permission passes through to original execute", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: denyAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toBe("result:hello");
  });

  test("deny permission blocks execution", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "deny",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toContain("denied");
  });

  test("hitl permission with approval passes through", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toBe("result:hello");
  });

  test("hitl permission with denial blocks execution", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: denyAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toContain("denied");
  });

  test("hitl with modifiedParams uses new params", async () => {
    const handler: HITLHandler = async () => ({
      approved: true,
      modifiedParams: { input: "modified" },
    });

    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: handler,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "original" });
    expect(result.content[0].text).toBe("result:modified");
  });

  test("beforeTool hook can transform params", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
      hooks: {
        beforeTool: async (_name, params) => ({ ...params, input: "hooked" }),
      },
    });

    const result = await wrapped.execute("tc1", { input: "original" });
    expect(result.content[0].text).toBe("result:hooked");
  });

  test("afterTool hook can transform result", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
      hooks: {
        afterTool: async (_name, result) => ({
          content: [{ type: "text", text: "after-hooked" }],
        }),
      },
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(result.content[0].text).toBe("after-hooked");
  });
});
