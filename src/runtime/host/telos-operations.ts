/** Runtime Host TELOS 协议操作；协议 payload 的校验与 TELOS storage 调用集中在此处。 */
import type { CommandRuntime } from "../CommandRuntime.js";
import {
  readTelosDocumentInput,
  readTelosDriftAction,
  readTelosPatternAction,
  requiredInteger,
  requiredString
} from "./validation.js";

export async function executeRuntimeHostTelosOperation(
  commands: CommandRuntime,
  payload: Record<string, unknown>
): Promise<unknown> {
  const storage = commands.agent.getTelosStorage();
  const action = requiredString(payload.action, "action");
  if (action === "overview-v1") return await storage.overview();
  if (action === "save-v1") {
    return await storage.saveDocument(
      readTelosDocumentInput(payload.input),
      requiredInteger(payload.expectedRevision, "expectedRevision")
    );
  }
  if (action === "review-pattern-v1") {
    return await storage.reviewPattern(
      requiredString(payload.patternId, "patternId"),
      readTelosPatternAction(payload.reviewAction),
      requiredInteger(payload.expectedRevision, "expectedRevision"),
      { detectDrift: payload.detectDrift !== false }
    );
  }
  if (action === "resolve-drift-v1") {
    return await storage.resolveDrift(
      requiredString(payload.driftId, "driftId"),
      readTelosDriftAction(payload.driftAction),
      requiredInteger(payload.expectedRevision, "expectedRevision")
    );
  }
  if (action === "snooze-drift-v1") {
    const until = requiredString(payload.until, "until");
    if (Number.isNaN(Date.parse(until))) throw new Error("Runtime Host TELOS snooze date is invalid.");
    return await storage.snoozeDrift(
      requiredString(payload.driftId, "driftId"),
      until,
      requiredInteger(payload.expectedRevision, "expectedRevision")
    );
  }
  throw new Error(`Unknown TELOS operation: ${action}`);
}
