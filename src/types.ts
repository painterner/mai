export type Role = 'user' | 'assistant' | 'thought' | 'tool' | 'system' | 'error';

export type ToolStatus = 'pending_approval' | 'running' | 'done' | 'failed' | 'declined';

export interface ToolCallInfo {
  name: string;
  args?: string;
  /** Free-form textual result/output shown under the call. */
  output?: string;
  status: ToolStatus;
}

export interface Message {
  id: string;
  role: Role;
  /** Rendered markdown-ish text; may still be growing while streaming. */
  content: string;
  /** True while an assistant/thought message is actively streaming in. */
  streaming?: boolean;
  /** UI-only fragment flags used when a live reply is committed incrementally. */
  continuation?: boolean;
  continues?: boolean;
  startsInCode?: boolean;
  tool?: ToolCallInfo;
  timestamp: number;
}

export interface SlashCommand {
  name: string;
  description: string;
}
