import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Content } from './llm/types.js';
import type { Message } from './types.js';

/**
 * Lets a CLI (Ink) session and a GUI (Tauri) session hand a conversation
 * off to each other: whichever one is exiting writes this file, whichever
 * one starts up next reads (and deletes) it. Keyed by workspace so running
 * `mai` in two different project directories doesn't cross-contaminate.
 */
export interface HandoffPayload {
  workspace: string;
  /** Optional for compatibility with handoffs written before persistent sessions. */
  sessionId?: string;
  uiMessages: Message[];
  modelContents: Content[];
  inputHistory: string[];
  createdAt: number;
}

function handoffPath(workspace: string): string {
  const key = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `mai-handoff-${key}.json`);
}

export async function writeHandoff(payload: Omit<HandoffPayload, 'createdAt'>): Promise<void> {
  const file = handoffPath(payload.workspace);
  await fs.writeFile(file, JSON.stringify({ ...payload, createdAt: Date.now() }), 'utf8');
}

/** Reads and deletes the handoff file for a workspace, if one exists. */
export async function readAndClearHandoff(workspace: string): Promise<HandoffPayload | null> {
  const file = handoffPath(workspace);
  try {
    const raw = await fs.readFile(file, 'utf8');
    await fs.rm(file, { force: true });
    return JSON.parse(raw) as HandoffPayload;
  } catch {
    return null;
  }
}
