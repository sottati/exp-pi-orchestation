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
      details: {},
    }),
  };
}

function throwingTool(name = "boom_tool"): AgentTool<any> {
  return {
    name,
    label: name,
    description: "throws",
    parameters: Type.Object({ input: Type.String() }),
    execute: async () => {
      throw new Error("boom");
    },
  };
}

const approveAll: HITLHandler = async () => ({ approved: true });
const denyAll: HITLHandler = async () => ({ approved: false });
const noopTrace = async () => {};

function getText(result: { content: any[] }, idx = 0): string {
  return (result.content[idx] as { text: string }).text;
}

describe("wrapTool", () => {
  test("allow permission passes through to original execute", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: denyAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(getText(result)).toBe("result:hello");
  });

  test("deny permission blocks execution", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "deny",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(getText(result)).toContain("denied");
  });

  test("hitl permission with approval passes through", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(getText(result)).toBe("result:hello");
  });

  test("hitl permission with denial blocks execution", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: denyAll,
      agentId: "code",
      tracePermission: noopTrace,
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(getText(result)).toContain("denied");
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
    expect(getText(result)).toBe("result:modified");
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
    expect(getText(result)).toBe("result:hooked");
  });

  test("afterTool hook can transform result", async () => {
    const wrapped = wrapTool(fakeTool(), {
      permission: "allow",
      hitlHandler: approveAll,
      agentId: "code",
      tracePermission: noopTrace,
      hooks: {
        afterTool: async (_name, result) => ({
          content: [{ type: "text" as const, text: "after-hooked" }],
          details: {},
        }),
      },
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(getText(result)).toBe("after-hooked");
  });

  test("hitl lifecycle callbacks run around approval flow", async () => {
    const calls: string[] = [];
    const wrapped = wrapTool(fakeTool(), {
      permission: "hitl",
      hitlHandler: async () => ({ approved: true }),
      agentId: "code",
      tracePermission: noopTrace,
      onHitlStart: async () => { calls.push("start"); },
      onHitlEnd: async () => { calls.push("end"); },
    });

    const result = await wrapped.execute("tc1", { input: "hello" });
    expect(getText(result)).toBe("result:hello");
    expect(calls).toEqual(["start", "end"]);
  });

  test("logs and rethrows tool execution errors", async () => {
    const logs: string[] = [];
    const originalError = console.error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.error = ((...args: any[]) => {
      logs.push(args.map(String).join(" "));
    }) as typeof console.error;

    try {
      const wrapped = wrapTool(throwingTool(), {
        permission: "allow",
        hitlHandler: approveAll,
        agentId: "code",
        tracePermission: noopTrace,
      });
      await expect(wrapped.execute("tc1", { input: "hello" })).rejects.toThrow("boom");
      expect(logs.some((line) => line.includes("[tool-error] agent=code tool=boom_tool call=tc1: boom"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
