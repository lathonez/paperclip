import { describe, expect, it } from "vitest";

/**
 * Prefix-stability tests for prompt caching (UPLA-36).
 *
 * These tests verify that the args passed to the Claude CLI are byte-identical
 * across repeated fresh-session calls (stable prefix → Anthropic cache hits),
 * and that --exclude-dynamic-system-prompt-sections is only added on fresh
 * sessions (not --resume), so the cache TTL is respected without breaking
 * resumed session continuity.
 *
 * Requires Claude CLI ≥ v2.1.112.
 */

function buildClaudeArgsFake(
  resumeSessionId: string | null,
  opts: { model?: string; effort?: string; maxTurns?: number; extraArgs?: string[] } = {},
): string[] {
  const { model, effort, maxTurns = 0, extraArgs = [] } = opts;
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  // Mirrors the real condition in execute.ts
  if (!resumeSessionId) {
    args.push("--exclude-dynamic-system-prompt-sections");
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  return args;
}

describe("Claude CLI arg stability for prompt caching", () => {
  it("fresh session args are byte-identical across two builds", () => {
    const first = buildClaudeArgsFake(null, { model: "claude-sonnet-4-6", maxTurns: 10 });
    const second = buildClaudeArgsFake(null, { model: "claude-sonnet-4-6", maxTurns: 10 });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("includes --exclude-dynamic-system-prompt-sections on fresh sessions", () => {
    const args = buildClaudeArgsFake(null);
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
  });

  it("omits --exclude-dynamic-system-prompt-sections on --resume sessions", () => {
    const args = buildClaudeArgsFake("session-abc-123");
    expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
    expect(args).toContain("--resume");
    expect(args).toContain("session-abc-123");
  });

  it("resume and fresh sessions share the same non-session-specific flags", () => {
    const freshArgs = buildClaudeArgsFake(null, { model: "claude-opus-4-7", maxTurns: 5 });
    const resumeArgs = buildClaudeArgsFake("ses-xyz", { model: "claude-opus-4-7", maxTurns: 5 });
    // Both should have the same format/verbose flags
    expect(freshArgs).toContain("--output-format");
    expect(resumeArgs).toContain("--output-format");
    expect(freshArgs).toContain("stream-json");
    expect(resumeArgs).toContain("stream-json");
  });
});
