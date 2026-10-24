// Central color palette so every component agrees on the same look.
// Kept deliberately distinct from Gemini/Codex/Claude's own palettes.

export const theme = {
  accent: '#7C5CFF', // violet — brand accent (logo, active elements)
  accentDim: '#5A4494',
  user: '#4FD1C5', // teal — user turns
  assistant: '#7C5CFF', // violet — agent turns
  thought: '#8B8FA3', // muted slate — model reasoning, de-emphasized on purpose
  tool: '#F0A44C', // amber — tool / shell activity
  system: '#6B7280', // gray — system notices
  error: '#F5657A', // red — errors
  success: '#4ADE80', // green — success notices
  muted: '#6B7280',
  border: '#3A3A45',
  borderFocus: '#7C5CFF',
  text: '#E5E7EB',
  dim: '#9CA3AF',
} as const;

export const symbols = {
  user: '❯',
  assistant: '◆',
  thought: '·',
  tool: '⚙',
  system: 'ℹ',
  error: '✖',
  success: '✔',
  bullet: '•',
  spinnerTip: '✳',
} as const;
