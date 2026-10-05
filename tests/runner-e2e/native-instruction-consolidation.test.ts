import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runnerSuites, buildRunnerMatrix } from "./catalog.js";
import { gradeNativeDefault, NATIVE_MASTER_DEFAULT_SHA256 } from "./native-completion-defaults.js";
import { nativeCompletionTasks } from "./native-completion-cases.js";
import { assertNativeInstructionLineage, assertNativeInstructionSelection, nativeInstructionVariant, validateNativeInstructionMeasurement, NATIVE_INSTRUCTION_BASE_SHA, NATIVE_INSTRUCTION_DEFAULT_SHA256, NATIVE_INSTRUCTION_SUITE, NATIVE_INSTRUCTION_VARIANTS } from "./native-instruction-consolidation.js";

describe("native instruction comparison admission", () => {
  it("hydrates bounded hosted history and still requires exact HEAD and real base ancestry", () => {
    const head = "a".repeat(40);
    for (const scenario of ["valid", "changed-head", "no-base", "local", "not-shallow"]) {
      let hydrated = false;
      const calls: string[][] = [];
      const run = (...args: string[]) => {
        calls.push(args);
        if (args[0] === "merge-base") {
          if (!hydrated || scenario === "no-base") throw new Error("no declared ancestor");
          return "";
        }
        if (args[1] === "--is-shallow-repository") return scenario === "not-shallow" ? "false" : "true";
        if (args.includes("fetch")) { hydrated = true; return ""; }
        return scenario === "changed-head" ? "b".repeat(40) : head;
      };
      if (scenario === "valid") expect(() => assertNativeInstructionLineage(head, run, true)).not.toThrow();
      else expect(() => assertNativeInstructionLineage(head, run, scenario !== "local")).toThrow();
      const fetch = calls.find(args => args.includes("fetch"));
      if (["local", "not-shallow"].includes(scenario)) expect(fetch).toBeUndefined();
      else expect(fetch).toEqual(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--depth=8",
        "https://github.com/paperclipai/paperclip.git", head]);
    }
  });
  it("accepts each complete source variant and rejects a mixed variant", () => {
    const files = Object.keys(NATIVE_INSTRUCTION_VARIANTS.baseline);
    const baseline = new Map(files.map(file => [file, execFileSync("git", ["show", `${NATIVE_INSTRUCTION_BASE_SHA}:${file}`])]));
    expect(nativeInstructionVariant(file => baseline.get(file)!)).toBe("baseline");
    const candidate = new Map(files.map(file => [file, readFileSync(new URL(`../../${file}`, import.meta.url))]));
    const currentVariant = nativeInstructionVariant(file => candidate.get(file)!);
    expect(["baseline", "candidate", "corrected", "feedback"]).toContain(currentVariant);
    candidate.set(files[0]!, currentVariant === "candidate" ? baseline.get(files[0]!)! : Buffer.from("unknown source"));
    expect(() => nativeInstructionVariant(file => candidate.get(file)!)).toThrow("Mixed or unknown");
    baseline.set(files[0]!, Buffer.from("unknown source"));
    expect(() => nativeInstructionVariant(file => baseline.get(file)!)).toThrow("Mixed or unknown");
  });

  it("declares six explicit single-attempt cells with the original task prompts and oracle", () => {
    const suite = runnerSuites.find(value => value.id === NATIVE_INSTRUCTION_SUITE)!;
    expect(suite.tasks).toEqual(nativeCompletionTasks);
    expect(suite.manualOnly).toBe(true);
    expect(suite.environments.map(value => value.id)).toEqual(["local"]);
    const executions = buildRunnerMatrix([suite]);
    expect(executions).toHaveLength(6);
    expect(() => assertNativeInstructionSelection(executions)).not.toThrow();
    for (const execution of executions) {
      expect(execution.task.expectedRunCount).toBe(1);
      expect(execution.task.automaticRetryPolicy).toBe("single_attempt");
      expect(() => assertNativeInstructionSelection([{ ...execution, environment: { ...execution.environment, id: "daytona" } }])).toThrow();
      expect(() => assertNativeInstructionSelection([{ ...execution, task: { ...execution.task, automaticRetryPolicy: undefined } }])).toThrow();
    }
  });

  it("uses the new common production default without qualifying old default evidence", () => {
    const receipt = { schema: "paperclip.native-completion-default.v1" as const, companyId: "company", agentId: "agent", entryFile: "AGENTS.md",
      files: [{ path: "AGENTS.md", sha256: NATIVE_INSTRUCTION_DEFAULT_SHA256, bytes: 40 }], budgets: { company: 1000, agent: 1000 } };
    expect(gradeNativeDefault(receipt, NATIVE_INSTRUCTION_DEFAULT_SHA256).passed).toBe(true);
    expect(gradeNativeDefault(receipt).passed).toBe(false);
    receipt.files[0]!.sha256 = NATIVE_MASTER_DEFAULT_SHA256;
    expect(gradeNativeDefault(receipt, NATIVE_INSTRUCTION_DEFAULT_SHA256).passed).toBe(false);
    receipt.files[0]!.sha256 = NATIVE_INSTRUCTION_DEFAULT_SHA256;
    receipt.budgets.company = 0;
    expect(gradeNativeDefault(receipt, NATIVE_INSTRUCTION_DEFAULT_SHA256).passed).toBe(false);
  });

  it("rejects duplicate or incomplete capture, dirty or paid source, and stale fixture evidence", () => {
    const measurement = {
      schema: "paperclip.native-instruction-measurement.v2", sourceSha: "frozen", sourceDirty: false, providerCalls: 0,
      fixtureSha256: createHash("sha256").update(readFileSync(new URL("../../packages/paperclip-runner/src/backends/native-instruction-measurement.test.ts", import.meta.url))).digest("hex"),
      sourceHashes: Object.fromEntries(Object.entries(NATIVE_INSTRUCTION_VARIANTS.baseline).map(([file, digest]) => [file.split('/').at(-1)!, digest])),
      directOpenCodeReceipts: ["v4", "v5"].flatMap(schema => ["start", "resume", "continuation"].map(phase => ({ provider: "opencode", schema, phase }))),
      receipts: ['codex', 'acpx', 'opencode'].flatMap(provider => ['v4', 'v5'].flatMap(schema => ['start', 'resume', 'continuation'].map(phase => ({ provider, schema, phase })))),
    };
    const source = { sourceSha: "frozen", variant: "baseline" };
    expect(() => validateNativeInstructionMeasurement(measurement, source)).not.toThrow();
    for (const invalid of [
      { ...measurement, receipts: measurement.receipts.slice(1) },
      { ...measurement, directOpenCodeReceipts: undefined },
      { ...measurement, directOpenCodeReceipts: measurement.directOpenCodeReceipts.slice(1) },
      { ...measurement, directOpenCodeReceipts: measurement.directOpenCodeReceipts.map(() => measurement.directOpenCodeReceipts[0]!) },
      { ...measurement, receipts: measurement.receipts.map(() => measurement.receipts[0]!) },
      { ...measurement, sourceDirty: true }, { ...measurement, providerCalls: 1 },
      { ...measurement, sourceSha: "other" }, { ...measurement, fixtureSha256: "stale" },
      { ...measurement, sourceHashes: { ...measurement.sourceHashes, "runtime-context.ts": "wrong" } },
    ]) expect(() => validateNativeInstructionMeasurement(invalid, source)).toThrow();
  });
});
