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
        const output = await deps.tools.execute(call.name, args);
        yield { type: 'toolFinished', id, name: call.name, output, status: 'done' };
        responseParts.push({ functionResponse: { name: call.name, response: { result: output } } });
      } catch (err) {
        const message = (err as Error).message;
        yield { type: 'toolFinished', id, name: call.name, output: message, status: 'failed' };
        responseParts.push({ functionResponse: { name: call.name, response: { error: message } } });
      }
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  yield { type: 'error', message: 'Reached the maximum number of tool-call steps for this turn.' };
  return contents;
}

export function buildSystemInstruction(workspace: string): string {
  return [
    'You are Mai, an autonomous coding agent working inside this workspace:',
    '',
    workspace,
    '',
    'Inspect the workspace before changing it. Make focused changes, preserve existing ' +
      'conventions, and verify completed work with the available tools when you can. Never ' +
      'access paths outside the workspace. Never reveal secrets or environment variables.',
    '',
    'Call tools one at a time and base each next action on the previous result. Some tool ' +
      'calls (destructive or risky shell commands, for example) require the user to approve ' +
      'them before they run and may be declined — if one is declined, adapt instead of retrying ' +
      'the same call. Do not claim a change or verification that was not actually performed. ' +
      'When the task is complete, reply with a concise plain-text summary and no further tool calls.',
  ].join('\n');
}
