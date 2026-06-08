import type { CustomMessage } from "../session/messages";
import { containsOrchestrate, ORCHESTRATE_NOTICE } from "./orchestrate";
import { parseTurnBudget, type TurnBudget } from "./turn-budget";
import { containsUltrathink, ULTRATHINK_NOTICE } from "./ultrathink";
import { containsWorkflow, WORKFLOW_NOTICE } from "./workflow";

/**
 * Result of {@link scanMagicKeywords}: the hidden system notices to append
 * after the user's message and the parsed turn-budget directive (or `null`
 * when absent).
 */
export interface MagicKeywordScan {
	notices: CustomMessage[];
	turnBudget: TurnBudget | null;
}

/**
 * Scan user-typed prose for the magic keywords (`ultrathink`, `orchestrate`,
 * `workflowz`) and a `+Nk`-style turn-budget directive. Returns the custom
 * notices to inject after the user's message and the parsed budget. Stateless:
 * the caller is responsible for actually starting the budget via
 * {@link SessionManager.beginTurnBudget}.
 *
 * Two entry points feed this helper today:
 *
 * - `AgentSession.prompt()` for plain user prompts;
 * - `AgentSession.promptCustomMessage({...}, { keywordText })` for skill
 *   invocations (`/skill:<name> …`) — the user-typed args are scanned so a
 *   highlighted `workflowz`/`orchestrate`/`ultrathink`/`+500k` inside a skill
 *   line takes effect, matching what the editor's gradient implies (#2126).
 *
 * Notices are flagged `attribution: "user"` because they encode user intent,
 * not agent-side state.
 */
export function scanMagicKeywords(text: string): MagicKeywordScan {
	const notices: CustomMessage[] = [];
	const timestamp = Date.now();
	if (containsUltrathink(text)) {
		notices.push({
			role: "custom",
			customType: "ultrathink-notice",
			content: ULTRATHINK_NOTICE,
			display: false,
			attribution: "user",
			timestamp,
		});
	}
	if (containsOrchestrate(text)) {
		notices.push({
			role: "custom",
			customType: "orchestrate-notice",
			content: ORCHESTRATE_NOTICE,
			display: false,
			attribution: "user",
			timestamp,
		});
	}
	if (containsWorkflow(text)) {
		notices.push({
			role: "custom",
			customType: "workflow-notice",
			content: WORKFLOW_NOTICE,
			display: false,
			attribution: "user",
			timestamp,
		});
	}
	return { notices, turnBudget: parseTurnBudget(text) };
}
