export type ApprovalMode = 'auto' | 'safe' | 'manual';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Role = 'user' | 'assistant' | 'thought' | 'tool' | 'system' | 'error';
export type ToolStatus = 'pending_approval' | 'running' | 'done' | 'failed' | 'declined';

export interface ToolCallInfo {
  name: string;
  args?: string;
  output?: string;
  status: ToolStatus;
}

export interface CitationInfo {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
  continuation?: boolean;
  continues?: boolean;
  startsInCode?: boolean;
  tool?: ToolCallInfo;
  citations?: CitationInfo[];
  timestamp: number;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'hostedTool';
      id: string;
      name: string;
      stage: 'started' | 'running' | 'completed';
    }
  | {
      type: 'citation';
      citation: { url: string; title?: string; startIndex?: number; endIndex?: number };
    }
  | { type: 'toolStart'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'toolApprovalNeeded';
      id: string;
      name: string;
      args: Record<string, unknown>;
      risk: RiskLevel;
      reason: string;
    }
  | {
      type: 'toolFinished';
      id: string;
      name: string;
      output: string;
      status: 'done' | 'failed' | 'declined';
    }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type DaemonEvent =
  | {
      type: 'ready';
      workspace: string;
      provider: string;
      model: string;
      baseUrl: string;
      hasApiKey: boolean;
      sandbox: string | null;
      approvalMode: ApprovalMode;
      resumedMessages: Message[];
      mcpIssues: Array<{ server: string; message: string }>;
    }
  | { type: 'fatal'; message: string }
  | { type: 'handoffWritten' }
  | { type: 'handoffFailed'; message: string }
  | { type: 'providersListed'; providers: string[]; current: string }
  | { type: 'modelsListed'; models: string[]; current: string }
  | { type: 'modelsError'; message: string }
  | { type: 'modelChanged'; provider: string; model: string; baseUrl: string }
  | { type: 'approvalModeChanged'; mode: ApprovalMode }
  | { type: 'authStatus'; configured: boolean; mode: string | null; expiresAt?: string; accountId?: string }
  | { type: 'authOutput'; message: string }
  | { type: 'authError'; message: string }
  | { type: 'queueChanged'; waiting: number }
  | { type: 'turnStarted'; text: string }
  | AgentEvent;

export type DaemonCommand =
  | { type: 'send'; text: string }
  | { type: 'approve'; approved: boolean }
  | { type: 'clear' }
  | { type: 'interrupt' }
  | { type: 'handoff'; uiMessages: Message[] }
  | { type: 'listProviders' }
  | { type: 'listModels'; provider: string }
  | { type: 'setModel'; provider: string; model: string }
  | { type: 'getAuthStatus' }
  | { type: 'loginOpenAi'; method: 'browser' | 'device' | 'api-key' | 'access-token' | 'reuse' }
  | { type: 'logoutOpenAi' }
  | { type: 'setApprovalMode'; mode: ApprovalMode };
