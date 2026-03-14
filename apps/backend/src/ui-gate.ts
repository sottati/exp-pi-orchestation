import { ThreadStore } from "./thread-store";

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
const asyncTaskCount = traces.filter((event) => event.type === "task_queued").length;
const failureCount = traces.filter((event) => event.type === "run_failed" || event.type === "task_failed").length;

const taskStarts = traces
    .filter((event) => event.type === "task_started")
    .map((event) => ({ ts: event.timestamp, delta: 1 }));
const taskEnds = traces
    .filter(
        (event) =>
            event.type === "task_completed" ||
            event.type === "task_failed" ||
            event.type === "task_cancelled",
    )
    .map((event) => ({ ts: event.timestamp, delta: -1 }));

const timeline = [...taskStarts, ...taskEnds].sort((a, b) => a.ts - b.ts);
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
const hasAsyncPressure = asyncTaskCount >= 5;

const shouldEnableUi = hasConcurrencyPressure || hasAsyncPressure || traceVolumeHigh;
const reasons: string[] = [];
if (hasConcurrencyPressure) reasons.push(`concurrencia detectada (maxParallelTasks=${maxParallel})`);
if (hasAsyncPressure) reasons.push(`carga async creciente (taskQueued=${asyncTaskCount})`);
if (traceVolumeHigh) reasons.push(`volumen de trazas alto (events=${traces.length})`);
if (!reasons.length) reasons.push("sin señales de friccion operativa fuertes");

console.log("UI Gate Report");
console.log("==============");
console.log(`sessionId: ${sessionId}`);
console.log(`runs: ${runCount}`);
console.log(`asyncTasksQueued: ${asyncTaskCount}`);
console.log(`maxParallelTasks: ${maxParallel}`);
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
