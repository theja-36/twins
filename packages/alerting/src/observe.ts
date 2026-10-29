import { consoleSink, createStructuredLogger, type LogFields, type LogSink, type StructuredLogger } from "@twins/shared";
import { alerterFromEnv, createAlerter, type Alerter } from "./alerter";
import { alertingSink } from "./rules";

/**
 * The standard logger for a TWINS process: JSON lines as before, plus alerts for the events in ALERT_RULES. An invalid alert configuration never
 * stops the process: it is logged (`alert.config_invalid`) and alerts are then logged as undelivered.
 */
export function observe(service: string, env: Record<string, string | undefined> = process.env, sink: LogSink = consoleSink, base: LogFields = {}): { logger: StructuredLogger; alerter: Alerter } {
  const own = createStructuredLogger(sink, { service });
  let alerter: Alerter;
  try {
    alerter = alerterFromEnv(env, service, own);
  } catch {
    own.error("alert.config_invalid", { reason: "invalid_alert_environment" });
    alerter = createAlerter({ context: { environment: env["TWINS_ENV_NAME"] ?? "unknown", service, build: env["TWINS_IMAGE_TAG"] }, logger: own });
  }
  return { logger: createStructuredLogger(alertingSink(sink, alerter), { service, ...base }), alerter };
}
