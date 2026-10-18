import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { resolve } from 'node:path';
import type { UserStylesheetState } from '../shared/health.ts';
import { readSettings, type Environment } from './settings.mts';

export const USER_STYLESHEET_BYTES = 256 * 1024;
export type UserStylesheet = {state: 'applied'; data: Buffer} | {state: Exclude<UserStylesheetState, 'applied'>; data?: undefined};
export type UserStylesheetSource = () => Promise<UserStylesheet>;

/** Reads the configured stylesheet fresh: at most one byte over the bound is read, and only a regular UTF-8 file qualifies. */
export async function readUserStylesheet(options: {agentDir?: string; env?: Environment} = {}): Promise<UserStylesheet> {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const snapshot = readSettings({agentDir, ...(options.env ? {env: options.env} : {})});
  if (snapshot.status === 'invalid') return {state: 'invalid'};
  if (!snapshot.userStylesheet) return {state: 'none'};
  let file: FileHandle;
  try {
    // A nonblocking open keeps a special file from waiting for a writer.
    file = await open(snapshot.userStylesheet, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return {state: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unreadable'};
  }
  try {
    if (!(await file.stat()).isFile()) return {state: 'unreadable'};
    const buffer = Buffer.alloc(USER_STYLESHEET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > USER_STYLESHEET_BYTES) return {state: 'too-large'};
    const data = buffer.subarray(0, length);
    new TextDecoder('utf-8', {fatal: true}).decode(data);
    return {state: 'applied', data: Buffer.from(data)};
  } catch {
    return {state: 'unreadable'};
  } finally {
    await file.close();
  }
}
