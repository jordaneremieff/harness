import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Machine configuration for the web UI: the `ui` section of the harness document and its `PI_UI_*` overrides. */
export const settings = {
  slice: 'ui',
  fields: {
    userStylesheet: {
      type: 'path',
      env: 'PI_UI_USER_STYLESHEET',
      description: 'Stylesheet served after the base styles on each page load. A relative path resolves against the agent directory.',
    },
  },
} as const;

const DOCUMENT_MAX_BYTES = 131072;
export type Environment = Readonly<Record<string, string | undefined>>;
export type ReadOptions = {agentDir: string; env?: Environment};
export type Origin = 'env' | 'file' | 'default';
export type Diagnostic = {field: string; source: Origin; code: 'document' | 'unknown' | 'invalid'};
export type Snapshot = {
  /** Absolute stylesheet path, or undefined when the setting is unset or its selected input is invalid. */
  userStylesheet: string | undefined;
  origin: Origin;
  status: 'valid' | 'unset' | 'invalid';
  diagnostics: Diagnostic[];
};

function textValid(value: unknown): value is string {
  return typeof value === 'string' && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function documentPath({agentDir, env = process.env}: ReadOptions): string | undefined {
  if (!isAbsolute(agentDir)) return undefined;
  const override = env.PI_HARNESS_FILE;
  if (override !== undefined && (!textValid(override) || !override.length || override.length > 4096)) return undefined;
  return resolve(agentDir, override ?? 'harness.json');
}
function readDocumentBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('nonregular');
    const bytes = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > DOCUMENT_MAX_BYTES) throw new Error('oversized');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
function readSection(options: ReadOptions, diagnostics: Diagnostic[]): Record<string, unknown> {
  const path = documentPath(options);
  if (!path) {diagnostics.push({field: 'PI_HARNESS_FILE', source: 'env', code: 'document'}); return {};}
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(readDocumentBytes(path)));
    if (!object(value) || value.version !== 1) throw new Error('envelope');
    const section = Object.hasOwn(value, settings.slice) ? value[settings.slice] : undefined;
    if (section === undefined) return {};
    if (!object(section)) {diagnostics.push({field: settings.slice, source: 'file', code: 'invalid'}); return {};}
    return section;
  } catch (error) {
    if (!(object(error) && error.code === 'ENOENT')) diagnostics.push({field: 'document', source: 'file', code: 'document'});
    return {};
  }
}
function checkedPath(value: unknown, agentDir: string): string {
  if (!textValid(value) || !value.length || value.length > 4096) throw new Error('invalid path');
  const path = resolve(agentDir, value);
  if (path.length > 4096) throw new Error('invalid path');
  return path;
}
/** Present environment value > document field > unset. Invalid selected input leaves the setting unset. */
export function readSettings(options: ReadOptions): Snapshot {
  const diagnostics: Diagnostic[] = [];
  const section = readSection(options, diagnostics);
  for (const key of Object.keys(section)) {
    if (!Object.hasOwn(settings.fields, key) && diagnostics.length < 256) diagnostics.push({field: `${settings.slice}.${textValid(key) ? key.slice(0, 64) : '<invalid-key>'}`, source: 'file', code: 'unknown'});
  }
  const field = settings.fields.userStylesheet, name = `${settings.slice}.userStylesheet`, env = options.env ?? process.env;
  const origin: Origin = env[field.env] !== undefined ? 'env' : Object.hasOwn(section, 'userStylesheet') ? 'file' : 'default';
  if (origin === 'default') return {userStylesheet: undefined, origin, status: 'unset', diagnostics};
  try {
    return {userStylesheet: checkedPath(origin === 'env' ? env[field.env] : section.userStylesheet, options.agentDir), origin, status: 'valid', diagnostics};
  } catch {
    diagnostics.push({field: name, source: origin, code: 'invalid'});
    return {userStylesheet: undefined, origin: 'default', status: 'invalid', diagnostics};
  }
}
