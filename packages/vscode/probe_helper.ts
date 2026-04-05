import { createSoundscriptBridgeClient } from './src/soundscript_bridge_client.ts';

interface ProbeEvent {
  count?: number;
  hover?: unknown;
  message?: string;
  t: number;
  type: string;
  uri?: string;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env var ${name}.`);
  }
  return value;
}

const filePath = requiredEnv('SOUNDSCRIPT_PROBE_FILE');
const workspaceRoot = requiredEnv('SOUNDSCRIPT_PROBE_WORKSPACE');
const command = requiredEnv('SOUNDSCRIPT_PROBE_COMMAND');
const argsPrefix = requiredEnv('SOUNDSCRIPT_PROBE_ARGS_PREFIX').split('\n').filter((part) =>
  part.length > 0
);
const line = Number(Deno.env.get('SOUNDSCRIPT_PROBE_LINE') ?? '0');
const character = Number(Deno.env.get('SOUNDSCRIPT_PROBE_CHARACTER') ?? '0');
const diagnosticsWaitTimeoutMs = Number(Deno.env.get('SOUNDSCRIPT_PROBE_DIAGNOSTICS_WAIT_MS') ?? '12000');
const requestTimeoutMs = Number(Deno.env.get('SOUNDSCRIPT_PROBE_REQUEST_TIMEOUT_MS') ?? '4000');

const documentUri = new URL(`file://${filePath}`).toString();
const rootUri = new URL(`file://${workspaceRoot}`).toString();
const text = await Deno.readTextFile(filePath);
const startedAt = Date.now();
const events: ProbeEvent[] = [];

const client = createSoundscriptBridgeClient({
  command,
  argsPrefix,
  cwd: workspaceRoot,
  diagnosticsWaitTimeoutMs,
  requestTimeoutMs,
  rootUri,
  onLog(message) {
    events.push({ t: Date.now() - startedAt, type: 'log', message });
  },
  onPublishDiagnostics(params) {
    events.push({
      t: Date.now() - startedAt,
      type: 'diagnostics',
      uri: params.uri,
      count: params.diagnostics.length,
    });
  },
});

try {
  const document = {
    languageId: 'soundscript',
    text,
    uri: documentUri,
    version: 1,
  };

  await client.syncDocument(document);
  events.push({ t: Date.now() - startedAt, type: 'synced' });

  try {
    const hover = await client.hover(document, { line, character });
    events.push({ t: Date.now() - startedAt, type: 'hover', hover });
  } catch (error) {
    events.push({
      t: Date.now() - startedAt,
      type: 'hover_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
} finally {
  client.dispose();
}

console.log(JSON.stringify(events, null, 2));
