/**
 * Coarse, non-sensitive error classification shared by the interactive
 * monitors and the autonomous runtime. Raw transport errors (for example ccxt
 * exceptions) can echo request details, URLs and authenticated payloads, so
 * they must never be written to stderr, TUI output or persisted logs. Every
 * reporting surface uses this coarse code instead of the raw message.
 */
export function failureCode(error: unknown): string {
	if (error instanceof Error) {
		if (/timeout|timed out/i.test(error.message)) return "timeout";
		if (/429|rate.?limit/i.test(error.message)) return "rate-limited";
		if (/auth|401|403/i.test(error.message)) return "authentication-failed";
		if (/network|socket|disconnect|ECONN/i.test(error.message)) return "disconnected";
	}
	return "operation-failed";
}
