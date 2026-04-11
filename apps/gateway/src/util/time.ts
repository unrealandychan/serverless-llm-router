export function nowIso(): string {
    return new Date().toISOString();
}

/** Returns elapsed milliseconds since `startMs` (from Date.now()). */
export function elapsedMs(startMs: number): number {
    return Date.now() - startMs;
}
