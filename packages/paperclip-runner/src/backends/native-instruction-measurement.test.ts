import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { PAPERCLIP_SEMANTIC_ACTION_CATALOG } from "../catalog/semantic-action-catalog.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInput } from "../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest } from "../contracts/runtime-context.js";
import { PRP_BLOCK_TOOL_DESCRIPTION, PRP_COMPLETION_TOOL_DESCRIPTION } from "../contracts/completion-result.js";
import { FakeCodexTransport, WORKSPACE } from "../drivers/codex/codex-app-server-driver.test-support.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { createRunnerdNativeSessionBackend } from "./codex-native-backend.js";
import { inspectNativeCompletionSourceMetadata } from "../../../../tests/runner-e2e/native-completion-git-source.mjs";

// This captures Paperclip's real runnerd RPC boundary with a scripted transport.
// It measures complete Paperclip-supplied instruction/tool/message projections,
// not provider-owned stock prompts, tokenization, billing or model behavior.
const tools = PAPERCLIP_SEMANTIC_ACTION_CATALOG
  .filter(tool => tool.placement === "core")
  .map(tool => ({ name: tool.operationId, description: tool.description, inputSchema: tool.inputSchema }));
const identity = { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", sessionId: "session" };
const { qualificationModel: _qualificationModel, reportedModelId: _reportedModelId, permissionPolicy: _permissionPolicy, ...profile } = resolveQualifiedAcpxProfile("claude", "claude-sonnet-5");
const providers: NativeExecutionInput["provider"][] = [
  { kind: "codex", model: "gpt-5.6-sol", approvalPolicy: "never" },
  { kind: "acpx", agent: "claude", model: "claude-sonnet-5", permissionMode: "approve-all", profile },
  { kind: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731", permissionMode: "allow" },
];
const receipts: unknown[] = [];
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function execution(provider: NativeExecutionInput["provider"], schema: "v4" | "v5"): NativeExecutionInput {
  const rootPath = WORKSPACE;
  const entry = readFileSync(new URL("../../../../server/src/onboarding-assets/default/AGENTS.md", import.meta.url), "utf8");
  writeFileSync(`${rootPath}/AGENTS.md`, entry);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, rootPath, digest: sha256(entry), manifestDigest: sha256(entry), fileCount: 1, totalBytes: Buffer.byteLength(entry) } },
    skills: [], mcp: { assignmentSetId: "none", digest: "0".repeat(64), bindingId: null },
  };
  return parseNativeExecutionInput({
    schema: `paperclip.native-execution-input.${schema}`,
    binding: { companyId: identity.companyId, agentId: identity.agentId, issueId: identity.issueId, runId: identity.runId, executionWorkspaceId: "workspace" },
    task: { identifier: "TASK-1", title: "Save the requested document", description: "Save the requested document", prompt: "Save the requested document.", workMode: "standard" },
    workspace: { cwd: rootPath, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: "session", driverKind: provider.kind === "acpx" ? "acpx_runtime" : provider.kind === "opencode" ? "opencode_server" : "codex_app_server", protocolVersion: 1 },
    provider,
    executionMode: "default",
    planningContext: null,
    completionContract: { id: "contract", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Save the requested document", criteria: [{ id: "objective", requirement: "Document saved" }] } },
    interactionResponses: [], credentialBindings: [],
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
  });
}

function transport(provider: NativeExecutionInput["provider"]) {
  return new FakeCodexTransport("thread-1", "provider-session-1", provider.kind === "acpx" ? {
    kind: "acpx", normalizedSessionId: "session", acpxRecordId: "fixture-record", backendSessionId: "fixture-backend",
    agentSessionId: "fixture-agent", profileDigest: `sha256:${"a".repeat(64)}`, workspaceDigest: `sha256:${"b".repeat(64)}`,
    requestedModel: provider.model, effectiveModel: provider.model, permissionMode: "approve-all",
    providerLifetimeFenceCandidates: [60001, 60002, 60003],
  } : undefined);
}

function measure(value: unknown) {
  // Temporary fixture workspace names must not create false before/after deltas.
  const json = JSON.stringify(value).replaceAll(WORKSPACE, "/workspace");
  return { utf8Bytes: Buffer.byteLength(json), characters: json.length, sha256: sha256(json) };
}

describe("native instruction payload measurement", () => {
  for (const provider of providers) for (const schema of ["v4", "v5"] as const) {
    it(`captures ${provider.kind} ${schema} instructions and tools on start, resume and continuation`, async () => {
      const input = execution(provider, schema);
      const fresh = transport(provider), resumed = transport(provider), continued = transport(provider);
      const backend = createRunnerdNativeSessionBackend(input, {
        transportFactory: () => fresh, dynamicTools: tools,
        environment: { PAPERCLIP_WORKSPACE_CWD: WORKSPACE },
      });
      const session = await backend.openSession({ identity, workingDirectory: WORKSPACE });
      const checkpoint = await session.snapshot();
      const envelope = buildNativeModelEnvelope(input);
      if ("requestedSkills" in envelope && backend.preparedTaskConstraints) envelope.constraints = [...backend.preparedTaskConstraints];
      await session.startTurn({ message: { role: "user", text: JSON.stringify(envelope) } });
      await session.close({ reason: "measurement" });

      resumed.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE, turns: [] } };
      const resumeBackend = createRunnerdNativeSessionBackend(input, {
        transportFactory: () => resumed, dynamicTools: tools,
        environment: { PAPERCLIP_WORKSPACE_CWD: WORKSPACE },
      });
      const recovery = await resumeBackend.recoverSession!(checkpoint, { signal: new AbortController().signal });
      expect(recovery.recovered).toBe(true);
      await recovery.session!.startTurn({ message: { role: "user", text: JSON.stringify(envelope) } });
      await recovery.session!.close({ reason: "measurement" });

      continued.readResponse = resumed.readResponse;
      const continuationInput = parseNativeExecutionInput({ ...input, continuationPrompt: "User update: retain the existing document and finish." });
      const continuationBackend = createRunnerdNativeSessionBackend(continuationInput, {
        transportFactory: () => continued, dynamicTools: tools,
        environment: { PAPERCLIP_WORKSPACE_CWD: WORKSPACE },
      });
      const continuationRecovery = await continuationBackend.recoverSession!(checkpoint, { signal: new AbortController().signal });
      expect(continuationRecovery.recovered).toBe(true);
      const continuationEnvelope = buildNativeModelEnvelope(continuationInput, { resumedSession: true });
      expect(continuationEnvelope.schema).toBe("paperclip.native-continuation.v1");
      await continuationRecovery.session!.startTurn({ message: { role: "user", text: JSON.stringify(continuationEnvelope) } });
      await continuationRecovery.session!.close({ reason: "measurement" });

      for (const [phase, captured, method] of [["start", fresh, "thread/start"], ["resume", resumed, "thread/resume"], ["continuation", continued, "thread/resume"]] as const) {
        const setup = captured.calls.find(call => call.method === method)!.params;
        const turn = captured.calls.find(call => call.method === "turn/start")!.params;
        const instructions = setup.developerInstructions ?? setup.baseInstructions;
        expect(instructions).toContain(PAPERCLIP_EXECUTION_PROMPT);
        expect(instructions).toContain("You are an agent in a Paperclip company.");
        const deliveredTools = setup.dynamicTools as Array<{ name: string; description: string }>;
        expect(deliveredTools.filter(tool => tool.name === "paperclip_finish")).toEqual([
          expect.objectContaining({ description: PRP_COMPLETION_TOOL_DESCRIPTION }),
        ]);
        expect(deliveredTools.filter(tool => tool.name === "paperclip_block")).toEqual([
          expect.objectContaining({ description: PRP_BLOCK_TOOL_DESCRIPTION }),
        ]);
        expect(deliveredTools).toHaveLength(tools.length + 2);
        if (phase === "continuation") {
          expect(JSON.stringify(turn.input)).toContain("User update: retain the existing document and finish.");
          const delivered = JSON.parse((turn.input as Array<{ text: string }>)[0]!.text);
          expect(schema === "v4" ? JSON.parse(delivered.message) : delivered).toEqual(continuationEnvelope);
          if (schema === "v5") {
            expect(JSON.stringify(turn.input)).not.toContain("constraints");
            expect(JSON.stringify(turn.input)).not.toContain("Document saved");
          } else {
            // v4's task-mode driver still wraps the compact message in its task envelope.
            expect(JSON.stringify(turn.input)).toContain("Obtain one accepted result");
            expect(JSON.stringify(turn.input)).toContain("Document saved");
          }
          expect(JSON.stringify(turn.input)).toContain("objective");
        } else {
          expect(JSON.stringify(turn.input)).toContain("Obtain one accepted result");
          expect(JSON.stringify(turn.input)).toContain("Document saved");
          expect(JSON.stringify(turn.input)).toContain("write_document");
          expect(JSON.stringify(turn.input)).toContain("register_deliverable");
        }
        expect(setup.approvalPolicy).toBe("never");
        receipts.push({ provider: provider.kind, schema, phase,
          instructions: measure(instructions), tools: measure(setup.dynamicTools), input: measure(turn.input),
          fullProjection: measure({ instructions, tools: setup.dynamicTools, input: turn.input }),
          deliveredToolCount: deliveredTools.length,
        });
      }
      const start = fresh.calls.find(call => call.method === "thread/start")!.params;
      const resume = resumed.calls.find(call => call.method === "thread/resume")!.params;
      expect(resume.dynamicTools).toEqual(start.dynamicTools);
      expect(resume.developerInstructions ?? resume.baseInstructions).toEqual(start.developerInstructions ?? start.baseInstructions);
    });
  }
});

afterAll(() => {
  const output = process.env.PAPERCLIP_NATIVE_INSTRUCTION_REPORT;
  if (!output) return;
  if (receipts.length !== 18) throw new Error("Incomplete native instruction measurement; refusing a partial receipt");
  const repositoryRoot = new URL("../../../../", import.meta.url);
  const sourcePaths = ["runtime-context.ts", "codex-native-backend.ts", "opencode-native-backend.ts"].map(file => `packages/paperclip-runner/src/backends/${file}`);
  sourcePaths.push("server/src/services/native-runtime/paperclip-runner-tool-authority.ts");
  const source = inspectNativeCompletionSourceMetadata({ repositoryRoot: repositoryRoot.pathname,
    sourceFiles: sourcePaths,
    baseSha: "2a8a99e4a5f69aa803b3f10b982f583e75a87042", variant: "measurement" });
  writeFileSync(output, `${JSON.stringify({
    schema: "paperclip.native-instruction-measurement.v1",
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDirty: !source.immutable,
    sourceMetadata: source.sourceMetadata,
    sourceHashes: Object.fromEntries(sourcePaths.map(file => [file.split("/").at(-1)!, sha256(readFileSync(new URL(file, repositoryRoot)))])),
    fixtureSha256: sha256(readFileSync(new URL(import.meta.url))),
    boundary: "scripted runnerd RPC; complete Paperclip instructions, fixture core tool schemas and turn input",
    providerCalls: 0, tokenCount: null, vendorStockPrompt: "unavailable", modelBehavior: "not_measured",
    receipts,
  }, null, 2)}\n`);
});
