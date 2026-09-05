/**
 * Faithful TypeScript port of mail-cli-rust's src/agent/approval.rs — a
 * conservative rule engine that classifies a tool call (in particular a
 * shell command) as auto-allowed, needing human review, or outright
 * forbidden, *before* it ever reaches the sandbox. Kept in lockstep with
 * the Rust version on purpose: this is a safety net, and the two CLIs
 * sharing the exact same rules means a gap found in one gets fixed in both.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RuleDecision = 'allow' | 'review' | 'forbidden';

export interface ApprovalRequirement {
  decision: RuleDecision;
  risk: RiskLevel;
  reason: string;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const DECISION_ORDER: Record<RuleDecision, number> = { allow: 0, review: 1, forbidden: 2 };

function allow(reason: string): ApprovalRequirement {
  return { decision: 'allow', risk: 'low', reason };
}
function review(risk: RiskLevel, reason: string): ApprovalRequirement {
  return { decision: 'review', risk, reason };
}
function forbidden(reason: string): ApprovalRequirement {
  return { decision: 'forbidden', risk: 'critical', reason };
}

/** Picks the strictest requirement, matching Rust's `max_by_key((decision, risk))`. */
function strictest(requirements: ApprovalRequirement[]): ApprovalRequirement {
  return requirements.reduce((worst, current) => {
    const a = [DECISION_ORDER[worst.decision], RISK_ORDER[worst.risk]];
    const b = [DECISION_ORDER[current.decision], RISK_ORDER[current.risk]];
    return b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? current : worst;
  });
}

export function classifyTool(tool: string, args: unknown): ApprovalRequirement {
  switch (tool) {
    case 'list_files':
    case 'read_file':
    case 'search_files':
    case 'load_skill':
      return allow('Read-only filesystem tool');
    case 'write_file':
    case 'replace_in_file':
      return allow('Write is constrained to the workspace, including for absolute paths');
    case 'run_command': {
      const command = (args as { command?: unknown } | null)?.command;
      if (typeof command === 'string' && command.trim().length > 0) {
        return classifyCommand(command);
      }
      return forbidden('run_command requires a non-empty command');
    }
    default:
      return forbidden(`Unknown tool: ${tool}`);
  }
}

function classifyCommand(script: string): ApprovalRequirement {
  const commands = splitSimpleScript(script);
  if (!commands || commands.length === 0) {
    return review('high', 'Complex shell syntax cannot be safely split by the rule engine');
  }
  return strictest(commands.map(classifySimpleCommand));
}

const FORBIDDEN_EXECUTABLES = new Set([
  'sudo',
  'su',
  'doas',
  'mount',
  'umount',
  'umount2',
  'pivot_root',
  'reboot',
  'shutdown',
  'poweroff',
  'halt',
  'fdisk',
  'parted',
]);

const NESTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'eval', 'exec']);
const NETWORK_TOOLS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'socat', 'telnet']);
const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'rg']);

function classifySimpleCommand(argv: string[]): ApprovalRequirement {
  const executable = argv[0]?.split('/').pop() ?? '';

  if (FORBIDDEN_EXECUTABLES.has(executable) || executable.startsWith('mkfs')) {
    return forbidden(`Privilege, host-control, or disk-management command is forbidden: ${executable}`);
  }

  if (containsSensitiveTarget(argv)) {
    return forbidden('Command targets credentials, secrets, or protected agent metadata');
  }

  if (executable === 'rm' && isCatastrophicRm(argv)) {
    return forbidden('Catastrophic recursive deletion is forbidden');
  }

  if (executable === 'rm' && argv.slice(1).some((v) => ['-r', '-rf', '-fr', '--recursive'].includes(v))) {
    return review('high', 'Recursive deletion can destroy workspace data');
  }

  if (NESTED_SHELLS.has(executable)) {
    return review('high', 'Nested shell execution can hide additional actions');
  }

  if (NETWORK_TOOLS.has(executable)) {
    return review('high', 'Network or remote-access command requires review');
  }

  if (executable === 'git') return classifyGit(argv);

  if (executable === 'cargo') {
    return ['check', 'test', 'build', 'clippy', 'fmt', 'metadata'].includes(argv[1] ?? '')
      ? allow('Known project-local Cargo workflow')
      : review('medium', 'Cargo subcommand may execute code or modify external state');
  }

  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn') {
    return ['install', 'ci', 'run', 'test', 'build', 'typecheck', 'lint'].includes(argv[1] ?? '')
      ? allow('Known project-local Node workflow')
      : review('medium', 'Package-manager subcommand may execute arbitrary scripts');
  }

  if (['pwd', 'true', 'false'].includes(executable)) {
    return allow('Known side-effect-free command');
  }

  if (executable === 'rg' && argv.some((a) => a === '--pre' || a.startsWith('--pre='))) {
    return review('high', 'ripgrep --pre can execute an arbitrary preprocessing command');
  }

  if (READ_ONLY_COMMANDS.has(executable) && argv.slice(1).every(safeLocalArgument)) {
    return allow('Known read-only command with workspace-relative arguments');
  }

  return review('medium', `Command is not covered by a narrow allow rule: ${executable}`);
}

function classifyGit(argv: string[]): ApprovalRequirement {
  if (argv.some((v) => v === '--ext-diff' || v === '--textconv')) {
    return review('high', 'Git external diff or text conversion can execute configured programs');
  }
  switch (argv[1]) {
    case 'status':
    case 'diff':
    case 'log':
    case 'show':
      return allow('Known read-only Git command');
    case 'clean':
      return argv.some((v) => v.includes('f'))
        ? review('high', 'Forced git clean can delete untracked work')
        : review('medium', 'Git command may mutate the repository or contact a remote');
    case 'reset':
    case 'checkout':
    case 'restore':
      return review('high', 'Git command can overwrite or discard workspace changes');
    default:
      return review('medium', 'Git command may mutate the repository or contact a remote');
  }
}

function safeLocalArgument(argument: string): boolean {
  return (
    argument.startsWith('-') ||
    (!argument.startsWith('/') &&
      argument !== '..' &&
      !argument.startsWith('../') &&
      !argument.includes('/../'))
  );
}

function containsSensitiveTarget(argv: string[]): boolean {
  return argv.some((argument) => {
    const n = argument.toLowerCase();
    return (
      n === '.env' ||
      n.endsWith('/.env') ||
      n.includes('/.ssh/') ||
      n.endsWith('/.ssh') ||
      n.includes('/.aws/') ||
      n.endsWith('/.aws') ||
      n.includes('/.gnupg/') ||
      n.endsWith('/.gnupg') ||
      n.includes('/.codex/') ||
      n.includes('/.agents/')
    );
  });
}

function isCatastrophicRm(argv: string[]): boolean {
  const rest = argv.slice(1);
  const recursive = rest.some((v) => ['-r', '-rf', '-fr', '--recursive'].includes(v));
  return (
    recursive &&
    rest.some((v) => ['/', '/*', '.', './', '..', '../'].includes(v) || v === '--no-preserve-root')
  );
}

/**
 * Splits only the deliberately small, safe subset of shell syntax the rule
 * engine understands (quoting, `;`/`|`/`||`/`&&`/newline separators).
 * Anything ambiguous (subshells, redirection, globs, `$`/backticks,
 * backgrounding with a bare `&`, var assignments, control-flow keywords)
 * returns `null` and the caller sends the whole thing to human review.
 */
function splitSimpleScript(script: string): string[][] | null {
  const DISALLOWED = new Set(['$', '`', '<', '>', '*', '?', '#', '(', ')', '{', '}']);
  const commands: string[][] = [];
  let command: string[] = [];
  let word = '';
  let quote: 'none' | 'single' | 'double' = 'none';
  let escaped = false;
  const chars = Array.from(script);

  const pushWord = () => {
    if (word.length > 0) {
      command.push(word);
      word = '';
    }
  };

  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index];

    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }

    if (quote === 'single') {
      if (ch === "'") quote = 'none';
      else word += ch;
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') quote = 'none';
      else if (ch === '\\') escaped = true;
      else if (ch === '$' || ch === '`') return null;
      else word += ch;
      continue;
    }

    // quote === 'none'
    if (ch === "'") {
      quote = 'single';
    } else if (ch === '"') {
      quote = 'double';
    } else if (ch === '\\') {
      escaped = true;
    } else if (DISALLOWED.has(ch)) {
      return null;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      pushWord();
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      pushWord();
      if (ch === '&' && chars[index + 1] !== '&') return null;
      if ((ch === '|' || ch === '&') && chars[index + 1] === ch) index += 1;
      if (command.length === 0) return null;
      if (looksLikeAssignment(command[0]) || isControlFlow(command[0])) return null;
      commands.push(command);
      command = [];
    } else {
      word += ch;
    }
  }

  if (quote !== 'none' || escaped) return null;
  pushWord();
  if (command.length > 0) {
    if (looksLikeAssignment(command[0]) || isControlFlow(command[0])) return null;
    commands.push(command);
  }
  return commands;
}

function looksLikeAssignment(word: string): boolean {
  const eq = word.indexOf('=');
  if (eq <= 0) return false;
  const name = word.slice(0, eq);
  return /^[A-Za-z0-9_]+$/.test(name);
}

const CONTROL_FLOW = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'case',
  'esac',
  'do',
  'done',
  'function',
]);

function isControlFlow(word: string): boolean {
  return CONTROL_FLOW.has(word);
}
