import type { RiskLevel } from './approval.js';
import type { ToolRegistry } from './tools.js';
import type { Content, FunctionCall, LlmClient, Part } from '../llm/types.js';

const MAX_STEPS = 25;

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'toolStart'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'toolApprovalNeeded';
      id: string;
      name: string;
      args: Record<string, unknown>;
      risk: RiskLevel;
      reason: string;
    }
  | { type: 'toolFinished'; id: string; name: string; output: string; status: 'done' | 'failed' | 'declined' }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason: string;
}

export interface AgentLoopDeps {
  client: LlmClient;
  tools: ToolRegistry;
  systemInstruction: string;
  /** Resolves to true if the user approves a review-gated tool call. */
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  /** Lets the caller cancel an in-flight model request (e.g. Esc to interrupt). */
  signal?: AbortSignal;
  /** Guidance queued by an external controller, consumed at tool boundaries. */
  takeSteering?: () => string[];
}

let toolCallCounter = 0;
function nextToolCallId(): string {
  toolCallCounter += 1;
  return `tc${toolCallCounter}`;
}

/**
 * Runs one user turn to completion: streams model text, executes any
 * function calls the model requests (subject to the approval gate),
 * feeds results back, and repeats until the model stops calling tools.
 * Returns the updated conversation history for the caller to persist.
 */
export async function* runAgentTurn(
  deps: AgentLoopDeps,
  history: Content[],
  userText: string,
): AsyncGenerator<AgentEvent, Content[], unknown> {
  const contents: Content[] = [...history, { role: 'user', parts: [{ text: userText }] }];
  const toolDeclarations = deps.tools.definitions();

  for (let step = 0; step < MAX_STEPS; step++) {
    const modelParts: Part[] = [];
    const functionCalls: FunctionCall[] = [];

    try {
      for await (const event of deps.client.streamTurn(
        deps.systemInstruction,
        contents,
        toolDeclarations,
        deps.signal,
      )) {
        if (event.type === 'functionCall') {
          modelParts.push({ functionCall: event.call });
          functionCalls.push(event.call);
        } else {
          modelParts.push({ text: event.text, ...(event.thought ? { thought: true } : {}) });
          yield event.thought ? { type: 'thought', text: event.text } : { type: 'text', text: event.text };
        }
      }
    } catch (err) {
      yield { type: 'error', message: (err as Error).message };
      return contents;
    }

    contents.push({ role: 'model', parts: modelParts });

    if (functionCalls.length === 0) {
      yield { type: 'done' };
      return contents;
    }

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      const id = nextToolCallId();
      const args = (call.args ?? {}) as Record<string, unknown>;
      const requirement = deps.tools.approvalRequirement(call.name, args);

      if (requirement.decision === 'forbidden') {
        yield { type: 'toolFinished', id, name: call.name, output: requirement.reason, status: 'declined' };
        responseParts.push({
          functionResponse: { name: call.name, response: { error: `Forbidden: ${requirement.reason}` } },
        });
        continue;
      }

      if (requirement.decision === 'review') {
        yield {
          type: 'toolApprovalNeeded',
          id,
          name: call.name,
          args,
          risk: requirement.risk,
          reason: requirement.reason,
        };
        const approved = await deps.requestApproval({
          tool: call.name,
          args,
          risk: requirement.risk,
          reason: requirement.reason,
        });
        if (!approved) {
          yield { type: 'toolFinished', id, name: call.name, output: 'Declined by user', status: 'declined' };
          responseParts.push({
            functionResponse: { name: call.name, response: { error: 'User declined to run this tool call' } },
          });
          continue;
        }
      }

      yield { type: 'toolStart', id, name: call.name, args };
      try {
        const output = await deps.tools.execute(call.name, args, deps.signal);
        yield { type: 'toolFinished', id, name: call.name, output, status: 'done' };
        responseParts.push({ functionResponse: { name: call.name, response: { result: output } } });
      } catch (err) {
        const message = (err as Error).message;
        yield { type: 'toolFinished', id, name: call.name, output: message, status: 'failed' };
        responseParts.push({ functionResponse: { name: call.name, response: { error: message } } });
      }
    }
    contents.push({ role: 'user', parts: responseParts });
    const steering = deps.takeSteering?.() ?? [];
    if (steering.length) {
      contents.push({
        role: 'user',
        parts: [{ text: `Additional user guidance received while the run was active:\n${steering.join('\n')}` }],
      });
    }
  }

  yield { type: 'error', message: 'Reached the maximum number of tool-call steps for this turn.' };
  return contents;
}

/**
 * `skillCatalog` is a pre-formatted "- name: description" listing (see
 * `ToolRegistry.skillCatalog` / `formatSkillCatalog`) — passed in rather
 * than a `Skill[]` so this module doesn't need to import skills.ts just to
 * re-derive text it's handed either way.
 */
export function buildSystemInstruction(workspace: string, skillCatalog = ''): string {
  const lines = [
    'You are Mai, an autonomous coding agent working inside this workspace:',
    '',
    workspace,
    '',
    'Inspect the workspace before changing it. You may inspect readable absolute paths outside ' +
      'the workspace when they are relevant to system-level diagnosis, but file writes remain ' +
      'workspace-only. Make focused changes, preserve existing conventions, and verify completed ' +
      'work with the available tools when you can. Never reveal secrets or environment variables.',
    '',
    'Call tools one at a time and base each next action on the previous result. Some tool ' +
      'calls (destructive or risky shell commands, for example) require the user to approve ' +
      'them before they run and may be declined — if one is declined, adapt instead of retrying ' +
      'the same call. Do not claim a change or verification that was not actually performed. ' +
      'When the task is complete, reply with a concise plain-text summary and no further tool calls.',
  ];

  if (skillCatalog) {
    lines.push(
      '',
      'Available skills — each is packaged instructions for a specific kind of task. When one ' +
        "matches what the user is asking, call load_skill with its exact name to fetch the full " +
        'instructions before proceeding, and follow them in place of your own default approach:',
      skillCatalog,
    );
  }

  return lines.join('\n');
}
