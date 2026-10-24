export type { Message, Role, ToolCallInfo, ToolStatus } from '@mai/protocol';

export interface SlashCommand {
  name: string;
  description: string;
}
