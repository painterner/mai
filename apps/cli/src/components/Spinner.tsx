import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <Text color={theme.accent}>
      {FRAMES[frame]}
      {label ? <Text color={theme.dim}> {label}</Text> : null}
    </Text>
  );
}
