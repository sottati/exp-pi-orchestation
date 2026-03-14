import { ThreadStore } from "../../packages/core/thread-store";

function parseArgs(args: string[]) {
    let sessionId = "default";
    for (let i = 0; i < args.length; i++) {
        const next = args[i + 1];
        if (args[i] === "--session" && next) {
            sessionId = next;
            i += 1;
        }
    }
    return { sessionId };
}

const { sessionId } = parseArgs(Bun.argv.slice(2));
const store = new ThreadStore({ sessionId });
const traces = await store.getTraces();

const runCount = traces.filter((event) => event.type === "run_started").length;
const chatCreatedCount = traces.filter((event) => event.type === "chat_created").length;
const failureCount = traces.filter((event) => event.type === "run_failed" || event.type === "chat_failed").length;

const chatStarts = traces
    .filter((event) => event.type === "chat_started")
    .map((event) => ({ ts: event.timestamp, delta: 1 }));
const chatEnds = traces
    .filter(
        (event) =>
            event.type === "chat_completed" ||
            event.type === "chat_failed" ||
            event.type === "chat_cancelled",
    )
    .map((event) => ({ ts: event.timestamp, delta: -1 }));

const timeline = [...chatStarts, ...chatEnds].sort((a, b) => a.ts - b.ts);
let currentParallel = 0;
let maxParallel = 0;
for (const point of timeline) {
    currentParallel += point.delta;
    if (currentParallel > maxParallel) {
        maxParallel = currentParallel;
    }
}

const traceVolumeHigh = traces.length >= 400;
const hasConcurrencyPressure = maxParallel > 1;
const hasChatPressure = chatCreatedCount >= 5;

const shouldEnableUi = hasConcurrencyPressure || hasChatPressure || traceVolumeHigh;
const reasons: string[] = [];
if (hasConcurrencyPressure) reasons.push(`concurrencia detectada (maxParallelChats=${maxParallel})`);
if (hasChatPressure) reasons.push(`carga de chats creciente (chatsCreated=${chatCreatedCount})`);
if (traceVolumeHigh) reasons.push(`volumen de trazas alto (events=${traces.length})`);
if (!reasons.length) reasons.push("sin señales de friccion operativa fuertes");

console.log("UI Gate Report");
console.log("==============");
console.log(`sessionId: ${sessionId}`);
console.log(`runs: ${runCount}`);
console.log(`chatsCreated: ${chatCreatedCount}`);
console.log(`maxParallelChats: ${maxParallel}`);
console.log(`failures: ${failureCount}`);
console.log(`traceEvents: ${traces.length}`);
console.log(`decision: ${shouldEnableUi ? "ENABLE_UI" : "STAY_TERMINAL"}`);
console.log(`reasons: ${reasons.join("; ")}`);

if (shouldEnableUi) {
    console.log("\nMonorepo proposal (Turbo):");
    console.log("- apps/cli");
    console.log("- apps/web");
    console.log("- packages/agent-runtime");
    console.log("- packages/contracts");
    console.log("- packages/store");
}
