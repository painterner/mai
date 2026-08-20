import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

/**
 * Very small renderer: splits on fenced ``` code blocks and renders those in
 * a bordered box, while plain paragraphs get lightweight **bold** / `code`
 * inline handling. Not a full markdown parser — just enough to make agent
 * replies (prose + snippets) read well in a terminal.
 */
export function Markdown({ content, color }: { content: string; color?: string }) {
  const blocks = splitCodeBlocks(content);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <Box
            key={i}
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.border}
            paddingX={1}
            marginY={0}
          >
            {block.lang ? (
              <Text color={theme.dim}>{block.lang}</Text>
            ) : null}
            {block.text.split('\n').map((line, j) => (
              <Text key={j} color={theme.success}>
                {line.length ? line : ' '}
              </Text>
            ))}
          </Box>
        ) : (
          <Box key={i} flexDirection="column">
            {block.text.split('\n').map((line, j) => (
              <Text key={j} color={color}>
                {renderInline(line)}
              </Text>
            ))}
          </Box>
        ),
      )}
    </Box>
  );
}

type Block = { type: 'text' | 'code'; text: string; lang?: string };

/** A whole line that is nothing but a fence, e.g. "```" or "```ts". */
const FENCE = /^\s*```(\w*)\s*$/;

/**
 * Walks the content line by line, toggling in/out of a fenced block. An
 * earlier version split on the fence regex and relied on the resulting
 * array alternating text/code, which quietly mis-parsed the *closing*
 * fence of a block as the opening fence of the next one — so any prose
 * after a code block was rendered as code.
 *
 * A block left open at the end of the content stays a code block on
 * purpose: while a reply is streaming in, the closing fence simply hasn't
 * arrived yet.
 */
function splitCodeBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let lang = '';

  const flush = () => {
    if (inCode) {
      if (buffer.length) blocks.push({ type: 'code', text: buffer.join('\n'), lang });
    } else {
      const text = buffer.join('\n').replace(/^\n+|\n+$/g, '');
      if (text) blocks.push({ type: 'text', text });
    }
    buffer = [];
  };

  for (const line of content.split('\n')) {
    const fence = FENCE.exec(line);
    if (!fence) {
      buffer.push(line);
      continue;
    }
    flush();
    if (inCode) {
      inCode = false;
      lang = '';
    } else {
      inCode = true;
      lang = fence[1] ?? '';
    }
  }
  flush();

  return blocks.length ? blocks : [{ type: 'text', text: content }];
}

function renderInline(line: string): React.ReactNode {
  const tokens = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((t) => t.length);
  if (tokens.length <= 1) return line;
  return tokens.map((tok, idx) => {
    if (tok.startsWith('**') && tok.endsWith('**')) {
      return (
        <Text key={idx} bold>
          {tok.slice(2, -2)}
        </Text>
      );
    }
    if (tok.startsWith('`') && tok.endsWith('`')) {
      return (
        <Text key={idx} color={theme.tool}>
          {tok.slice(1, -1)}
        </Text>
      );
    }
    return tok;
  });
}
