import { MultiAgentRuntime } from "./runtime";
import { parseArgs } from "util";
import { type BaseAgentId, type ThreadEnvelope } from "./contracts";

const args = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        port: {
            type: "string",
            short: "p",
            default: "3001",
        },
        session: {
            type: "string",
            short: "s",
            default: "default",
        },
    },
});

const port = parseInt(args.values.port as string, 10);
const runtime = new MultiAgentRuntime(args.values.session);

// We'll keep track of SSE clients. In a more complete app we'd map clients to session/threads.
// For now, we will simply broadcast to all connected clients.
const sseClients = new Set<{ send: (data: string) => void; close: () => void }>();

// A little hack: We patch appendThreadMessage in the thread store to intercept new messages.
// This allows us to push them via SSE to the frontend instantly.
const originalAppend = runtime.store.appendThreadMessage.bind(runtime.store);
runtime.store.appendThreadMessage = async (envelope: ThreadEnvelope) => {
    await originalAppend(envelope);
    // Broadcast the new envelope
    const payload = JSON.stringify(envelope);
    for (const client of sseClients) {
        client.send(`data: ${payload}\n\n`);
    }
};

const server = Bun.serve({
    port,
    async fetch(req, server) {
        const url = new URL(req.url);

        // CORS Handling for preflight
        if (req.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            });
        }

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
        };

        if (url.pathname === "/agents" && req.method === "GET") {
            return Response.json(runtime.listAgents(), { headers: corsHeaders });
        }

        if (url.pathname === "/threads" && req.method === "GET") {
            try {
                const threads = await runtime.listThreadIds();
                return Response.json(threads, { headers: corsHeaders });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
            }
        }

        if (url.pathname === "/thread" && req.method === "GET") {
            const threadId = url.searchParams.get("id");
            if (!threadId) return Response.json({ error: "missing id" }, { status: 400, headers: corsHeaders });
            try {
                const thread = await runtime.getThread(threadId);
                return Response.json(thread, { headers: corsHeaders });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
            }
        }

        if (url.pathname === "/chat" && req.method === "POST") {
            try {
                const body = await req.json() as Record<string, unknown>;
                const toAgentId = typeof body.toAgentId === "string" ? body.toAgentId : undefined;
                const content = typeof body.content === "string" ? body.content : undefined;
                const fromAgentId = typeof body.fromAgentId === "string" ? body.fromAgentId : undefined;

                if (!toAgentId || !content) {
                    return Response.json({ error: "missing toAgentId or content" }, { status: 400, headers: corsHeaders });
                }

                // Fire and forget chat to not block HTTP response while agent thinks,
                // messages will flow through SSE. However, since the user expects an answer
                // in the thread immediately or shortly, we can just await the chat call and return.
                // Depending on the use case, returning early and letting SSE handle is better.
                // We will await here just to make the POST return when done.
                const output = await runtime.chat({
                    toAgentId: toAgentId as Exclude<BaseAgentId, "user">,
                    content,
                    fromAgentId: fromAgentId as BaseAgentId | undefined,
                });

                return Response.json(output, { headers: corsHeaders });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
            }
        }

        if (url.pathname === "/events" && req.method === "GET") {
            // Setup SSE
            const body = new ReadableStream({
                start(controller) {
                    const client = {
                        send: (data: string) => {
                            controller.enqueue(new TextEncoder().encode(data));
                        },
                        close: () => {
                            controller.close();
                        },
                    };
                    sseClients.add(client);

                    req.signal.addEventListener("abort", () => {
                        sseClients.delete(client);
                        client.close();
                    });
                },
            });

            return new Response(body, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                },
            });
        }

        return new Response("Not found", { status: 404, headers: corsHeaders });
    },
});

console.log(`Backend running on http://localhost:${server.port}`);
console.log(`Session ID: ${runtime.sessionId}`);
