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

function splitCodeBlocks(content: string): Block[] {
  const parts = content.split(/```(\w*)\n?/);
  // parts alternates: text, lang, code, lang, code, ... but the regex
  // captures lang as its own group, so structure is:
  // [text0, lang1, code1, text1?, lang2, code2, ...] — walk it manually.
  const blocks: Block[] = [];
  let i = 0;
  let inCode = false;
  let pendingLang = '';
  for (const part of parts) {
    if (!inCode) {
      if (i % 2 === 0) {
        if (part) blocks.push({ type: 'text', text: part.replace(/\n$/, '') });
      } else {
        pendingLang = part;
        inCode = true;
      }
    } else {
      blocks.push({ type: 'code', text: part.replace(/\n$/, ''), lang: pendingLang });
      inCode = false;
    }
    i++;
  }
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
