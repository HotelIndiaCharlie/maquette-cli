// MAQUETTE_TRACE: traces of what the agent does, sent to Phoenix (or any OpenTelemetry
// collector that takes OTLP over HTTP) while developing Maquette's tools. See docs/telemetry.md.
// The OpenTelemetry packages are dev dependencies, so this works from a clone, not from a
// global install; to take tracing out, delete this folder and the lines in cli.ts that load it.
import { randomUUID } from "node:crypto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { AgentEvent } from "../agent/events.ts";
import type { ServerEvent } from "../server.ts";
import { Tracing } from "./spans.ts";

export { ensurePhoenix } from "./phoenix.ts";

export const defaultEndpoint = "http://localhost:6006";

// MAQUETTE_TRACE=1 means Phoenix on its usual port; a URL names another collector.
export function endpointOf(value: string): string {
  const base = /^(1|true|yes|on|phoenix)$/i.test(value.trim()) ? defaultEndpoint : value.trim().replace(/\/+$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

export type TracingOptions = {
  value: string; // MAQUETTE_TRACE
  session?: { on(listener: (e: AgentEvent) => void): () => void };
  server: { on(listener: (e: ServerEvent) => void): () => void };
  say: (text: string, level: "info" | "warn") => void;
  version: string;
};

export function startTracing(options: TracingOptions): { url: string; shutdown(): Promise<void> } {
  const url = endpointOf(options.value);
  const exporter = new OTLPTraceExporter({ url });
  // Says once when the collector stops taking spans, since a missing one fails silently.
  let told = false;
  const reporting: SpanExporter = {
    export(spans: ReadableSpan[], done) {
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
  const tracing = new Tracing(provider.getTracer("maquette", options.version), randomUUID());
  const offs = [options.server.on((e) => tracing.onServer(e)), ...(options.session ? [options.session.on((e) => tracing.onAgent(e))] : [])];
  return {
    url,
    async shutdown() {
      for (const off of offs) off();
      tracing.endTurn(performance.timeOrigin + performance.now());
      await provider.shutdown().catch(() => {});
    },
  };
}
