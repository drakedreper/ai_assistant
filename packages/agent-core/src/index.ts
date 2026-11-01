/**
 * Public surface of @ai-assistant/agent-core. The daemon codes against the five factories below and the interfaces
 * in @ai-assistant/shared (agent.ts):
 *
 *   createFakeBackend(opts?)    zero-token scripted backend (tests, e2e, offline demos)
 *   createSdkBackend(opts?)     the real Claude Agent SDK backend
 *   createSecretaryLane(deps)   chat + tools + approvals + avatar events on top of any backend
 *   createBudgetGuard(opts)     per-lane daily budgets and a global daily cap
 *   createMockToolBindings()    fixture-backed handlers for the whole TOOL_SURFACE
 *
 * Pure logic: no HTTP, no database, no globals.
 */
export { createFakeBackend, chunkSentence } from './fake-backend'
export type { FakeBackend, FakeBackendOptions } from './fake-backend'

export { createSdkBackend, buildMcpToolEntries, buildSdkEnv, createSdkMapState, mapSdkMessage, mcpToolName } from './sdk-backend'
export type { McpToolEntry, SdkBackendOptions, SdkEnvInput, SdkMapState, SdkQueryFn } from './sdk-backend'

export { createSecretaryLane } from './lane'
export type { LaneOptions, LaneTimers, SecretaryLaneImpl } from './lane'

export { createBudgetGuard } from './budget'
export type { BudgetGuardImpl, BudgetGuardOptions, BudgetRestore } from './budget'

export { createMockToolBindings } from './tools-mock'
export type { MockToolOptions } from './tools-mock'

export { EMOTION_TAGS, EmotionStreamParser, isEmotion, parseEmotionText, parseSentences, stripEmotionTags } from './emotion'
export type { EmotionEvent, EmotionParserOptions, EmotionSegment } from './emotion'

export { buildDynamicBlock, buildStablePrompt, buildSystemPrompt, isQuietHours, localDate } from './persona'
export type { PersonaContext } from './persona'

export { assessRisk, assessRiskDetailed, auditTarget, createPermissionBroker, hasPrivateInput, isOutside } from './permissions'
export type { BrokerDeps, BrokerOutcome, PermissionBroker, PermissionRequestEvent, RiskAssessment } from './permissions'

export { cloudNote, toolLabel } from './tool-labels'
export { BackendError, redactSecrets } from './util'
