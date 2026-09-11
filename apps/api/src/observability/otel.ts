import {
  ROOT_CONTEXT,
  SpanStatusCode,
  defaultTextMapGetter,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Optional OTLP export of run/hop spans. Unset OTEL_EXPORTER_OTLP_ENDPOINT
 * → no-op tracer (existing e2e unchanged). This is an integration into
 * collectors people already run (Jaeger, Grafana Tempo, Honeycomb), not
 * an OpenBots-built observability product.
 *
 * One trace per run (trace id = run UUID without dashes). Each hop is a
 * child span. Prompt/output text is never an attribute — only ids, names,
 * token counts, and truncated error messages.
 */

const propagator = new W3CTraceContextPropagator();
let provider: BasicTracerProvider | null = null;

export function initOtel(serviceName: string): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;
  if (provider) return;

  const url = endpoint.includes("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/, "")}/v1/traces`;
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url, headers: parseOtelHeaders() })),
    ],
  });
  trace.setGlobalTracerProvider(provider);
}

function parseOtelHeaders(): Record<string, string> | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function tracer(): Tracer {
  return trace.getTracer("openbots");
}

function runTraceId(runId: string): string {
  return runId.replace(/-/g, "");
}

/** Stable 8-byte parent so every hop in a run shares one trace tree. */
function runParentSpanId(runId: string): string {
  return runTraceId(runId).slice(0, 16);
}

function runContext(runId: string) {
  const traceparent = `00-${runTraceId(runId)}-${runParentSpanId(runId)}-01`;
  return propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
}

export function startHopSpan(args: {
  runId: string;
  graphId: string;
  nodeId: string;
  nodeName: string;
  sequence: number;
  startTime: Date;
}): Span {
  return tracer().startSpan(
    "openbots.hop",
    {
      startTime: args.startTime,
      attributes: {
        "openbots.run_id": args.runId,
        "openbots.graph_id": args.graphId,
        "openbots.node_id": args.nodeId,
        "openbots.node_name": args.nodeName,
        "openbots.sequence": args.sequence,
      },
    },
    runContext(args.runId),
  );
}

export function finishHopSpan(
  span: Span,
  result:
    | {
        ok: true;
        provider?: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        outputChars?: number;
      }
    | { ok: false; error: string },
): void {
  if (result.ok) {
    if (result.provider) span.setAttribute("openbots.provider", result.provider);
    if (result.model) span.setAttribute("openbots.model", result.model);
    if (result.inputTokens !== undefined) span.setAttribute("openbots.input_tokens", result.inputTokens);
    if (result.outputTokens !== undefined) span.setAttribute("openbots.output_tokens", result.outputTokens);
    if (result.outputChars !== undefined) span.setAttribute("openbots.output_chars", result.outputChars);
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    span.setAttribute("openbots.error", result.error.slice(0, 200));
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.slice(0, 200) });
  }
  span.end();
}

export function recordRunFinished(args: {
  runId: string;
  graphId: string;
  status: "completed" | "error";
  createdAt: Date;
}): void {
  const span = tracer().startSpan(
    "openbots.run",
    {
      startTime: args.createdAt,
      attributes: {
        "openbots.run_id": args.runId,
        "openbots.graph_id": args.graphId,
        "openbots.run_status": args.status,
      },
    },
    runContext(args.runId),
  );
  span.setStatus({
    code: args.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
  span.end();
}
