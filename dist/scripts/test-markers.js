export async function readBenchMarkers(log) {
    const lines = await log.sync.readMarkers();
    const out = [];
    for (const line of lines) {
        if (!line.startsWith('bench '))
            continue;
        try {
            const parsed = JSON.parse(line.slice(6));
            const { bench: event, t, ...rest } = parsed;
            out.push({ event, t, fields: rest });
        }
        catch {
            /* skip malformed */
        }
    }
    return out;
}
//# sourceMappingURL=test-markers.js.map