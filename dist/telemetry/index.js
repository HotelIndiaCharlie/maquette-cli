// MAQUETTE_TRACE: traces of what the agent does, sent to Phoenix (or any OpenTelemetry
// collector that takes OTLP over HTTP) while developing Maquette's tools. See docs/telemetry.md.
// The OpenTelemetry packages are dev dependencies, so this works from a clone, not from a
// global install; to take tracing out, delete this folder and the lines in cli.ts that load it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Tracing } from "./spans.js";
export { ensurePhoenix } from "./phoenix.js";
export const defaultEndpoint = "http://localhost:6006";
// MAQUETTE_TRACE=1 means Phoenix on its usual port; a URL names another collector.
export function endpointOf(value) {
    const base = /^(1|true|yes|on|phoenix)$/i.test(value.trim()) ? defaultEndpoint : value.trim().replace(/\/+$/, "");
    return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}
// The commit this run's code and prompts are from, with "+changes" when prompts/ or src/ have
// edits not yet committed. Undefined outside a clone.
export function gitCommit(repo = fileURLToPath(new URL("../..", import.meta.url))) {
    try {
        const commit = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const changed = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", "prompts", "src"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return changed ? `${commit}+changes` : commit;
    }
    catch {
        return undefined;
    }
}
export function startTracing(options) {
    const url = endpointOf(options.value);
    const commit = gitCommit();
    const exporter = new OTLPTraceExporter({ url });
    // Says once when the collector stops taking spans, since a missing one fails silently.
    let told = false;
    const reporting = {
        export(spans, done) {
            exporter.export(spans, (result) => {
                // 0 is ExportResultCode.SUCCESS.
                if (result.code !== 0 && !told) {
                    told = true;
                    options.say(`Tracing couldn't send to ${url}: ${result.error?.message ?? "no reply"}. Is Phoenix running? See docs/telemetry.md.`, "warn");
                }
                done(result);
            });
        },
        shutdown: () => exporter.shutdown(),
        forceFlush: () => exporter.forceFlush(),
    };
    const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ "service.name": "maquette", "service.version": options.version, "openinference.project.name": "maquette" }),
        // A long conversation flattens into many attributes on each request's span.
        spanLimits: { attributeCountLimit: 100_000, attributeValueLengthLimit: 200_000, eventCountLimit: 1000 },
        spanProcessors: [new BatchSpanProcessor(reporting, { scheduledDelayMillis: 1000 })],
    });
    const tracing = new Tracing(provider.getTracer("maquette", options.version), randomUUID(), commit ? { "maquette.git.commit": commit } : {});
    const offs = [options.server.on((e) => tracing.onServer(e)), ...(options.session ? [options.session.on((e) => tracing.onAgent(e))] : [])];
    return {
        url,
        async shutdown() {
            for (const off of offs)
                off();
            tracing.endTurn(performance.timeOrigin + performance.now());
            await provider.shutdown().catch(() => { });
        },
    };
}
