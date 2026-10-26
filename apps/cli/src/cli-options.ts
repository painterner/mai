export interface CliOptions {
  resume?: string;
  keyTest: boolean;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const keyTest = argv.includes('--key-test');
  const index = argv.findIndex((arg) => arg === '--resume' || arg === '--continue' || arg === '-r');
  if (index === -1) return { keyTest };
  const candidate = argv[index + 1];
  return {
    keyTest,
    resume: candidate && !candidate.startsWith('-') ? candidate : 'last',
  };
}
