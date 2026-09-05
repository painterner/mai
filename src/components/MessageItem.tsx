import React from 'react';
import { Box, Text } from 'ink';
import { theme, symbols } from '../theme.js';
import type { Message, ToolStatus } from '../types.js';
import { Markdown } from './Markdown.js';

const ROLE_META: Record<Message['role'], { symbol: string; color: string; label: string }> = {
  user: { symbol: symbols.user, color: theme.user, label: 'you' },
  assistant: { symbol: symbols.assistant, color: theme.assistant, label: 'mai' },
  thought: { symbol: symbols.thought, color: theme.thought, label: 'thinking' },
  tool: { symbol: symbols.tool, color: theme.tool, label: 'tool' },
  system: { symbol: symbols.system, color: theme.system, label: 'system' },
  error: { symbol: symbols.error, color: theme.error, label: 'error' },
};

const TOOL_STATUS_META: Record<ToolStatus, { color: string; label: string }> = {
  pending_approval: { color: theme.tool, label: 'needs approval' },
  running: { color: theme.tool, label: 'running' },
  done: { color: theme.success, label: 'done' },
  failed: { color: theme.error, label: 'failed' },
  declined: { color: theme.error, label: 'declined' },
};

export function MessageItem({ message }: { message: Message }) {
  const meta = ROLE_META[message.role];
  const dimmed = message.role === 'thought';

  return (
    <Box flexDirection="column" marginBottom={message.continues ? 0 : 1}>
      {!message.continuation ? (
        <Box>
          <Text color={meta.color} bold={!dimmed} dimColor={dimmed}>
            {meta.symbol} {meta.label}
          </Text>
          <Text color={theme.dim}>  {formatTime(message.timestamp)}</Text>
        </Box>
      ) : null}

      {message.tool ? <ToolCallBlock message={message} /> : null}

      {message.content || message.streaming ? (
        <Box paddingLeft={2} flexDirection="column">
          <Markdown
            content={message.content + (message.streaming ? '▍' : '')}
            color={dimmed ? theme.thought : undefined}
            startsInCode={message.startsInCode}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function ToolCallBlock({ message }: { message: Message }) {
  const tool = message.tool!;
  const status = TOOL_STATUS_META[tool.status];

  return (
    <Box paddingLeft={2} flexDirection="column" marginBottom={message.content ? 1 : 0}>
      <Text color={theme.tool}>
        {symbols.tool} {tool.name}
        {tool.args ? <Text color={theme.dim}>  ({tool.args})</Text> : null}
        <Text color={status.color}>  [{status.label}]</Text>
      </Text>
      {tool.output ? <ToolOutput output={tool.output} /> : null}
    </Box>
  );
}

// The model always receives a tool's full output; these caps are purely
// about what gets painted. `read_file` on a large file or a chatty
// `run_command` can be tens of thousands of characters, and a single one
// of those turns into thousands of wrapped terminal rows — enough to blow
// past the scrollback and, while a turn is still live, to push Ink into
// repainting the whole screen every frame.
const MAX_OUTPUT_LINES = 20;
const MAX_OUTPUT_LINE_CHARS = 300;

function ToolOutput({ output }: { output: string }) {
  const lines = output.split('\n');
  const shown = lines.slice(0, MAX_OUTPUT_LINES);
  const hidden = lines.length - shown.length;

  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column" marginTop={0}>
      {shown.map((line, i) => (
        <Text key={i} color={theme.dim}>
          {clip(line) || ' '}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text color={theme.dim} dimColor>
          … {hidden} more line{hidden === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Box>
  );
}

function clip(line: string): string {
  return line.length > MAX_OUTPUT_LINE_CHARS ? `${line.slice(0, MAX_OUTPUT_LINE_CHARS)}…` : line;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
