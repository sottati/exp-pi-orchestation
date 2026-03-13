/** Extract error message from unknown throw value. */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Wraps async fn, catches errors, logs to stderr. For fire-and-forget paths. */
export async function safeAsync<T>(fn: () => Promise<T>, label: string): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        console.error(`[${label}]`, errorMessage(err));
        return undefined;
    }
}

/** JSON.parse a single line, returns undefined on failure. For JSONL fault tolerance. */
export function safeParseLine<T>(line: string): T | undefined {
    try {
        return JSON.parse(line) as T;
    } catch {
        return undefined;
    }
}
