/**
 * Policy-as-code: public surface (Master Plan §8).
 */

export * from "./types.js";
export { PolicyEngine, DEFAULT_BUNDLE, POLICY_BUNDLE_VERSION, getDefaultPolicyEngine } from "./engine.js";
export {
  loadExceptions,
  validateExceptions,
  type ExceptionRecord,
  type ExceptionValidation,
  type ExceptionProblem,
} from "./exceptions.js";
