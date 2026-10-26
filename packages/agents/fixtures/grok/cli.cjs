// Invented offline official-Grok-shaped ACP peer. No accounts, network or host config reads.
const { createInterface } = require('node:readline');
const { readFileSync, appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const scenario = process.argv[2];
const log = process.argv[3];
const control = process.argv[4];
process.on('exit', () => appendFileSync(log, JSON.stringify({ pid: process.pid, exited: true }) + '\n'));
const sessionId = '11111111-1111-4111-8111-111111111111';
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const result = (id, value) => send({ id, result: value });
let promptId;
let authenticated = false;
const state = { currentModelId: 'synthetic-grok', availableModels: [{ modelId: 'synthetic-grok', name: 'Synthetic Grok' }, { modelId: 'synthetic-other', name: 'Synthetic other' }] };
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
 const m = JSON.parse(line);
 appendFileSync(log, JSON.stringify({ pid: process.pid, ...m }) + '\n');
 if (m.method === 'initialize') {
  // Read ONLY the invented Gram-owned fixture config, never an auth path/file.
  const requirements = readFileSync(join(process.env.GROK_HOME, 'requirements.toml'), 'utf8');
  if (!requirements.includes('preferred_method = "oidc"') || !requirements.includes('tool = "any"') || process.env.GROK_DISABLE_API_KEY_AUTH !== '1' || process.env.GROK_MANAGED_CONFIG !== '0' || process.env.XAI_API_KEY || process.env.X_AI_API_KEY || process.env.GROK_AUTH || process.env.OPENAI_API_KEY || process.env.GROK_CONFIG) process.exit(91);
  result(m.id, { protocolVersion: 1, authMethods: scenario === 'signed-out' ? [{ id: 'grok.com' }] : scenario === 'api-key' ? [{ id: 'cached_token' }, { id: 'xai.api_key' }] : [{ id: 'cached_token' }], agentCapabilities: { loadSession: scenario !== 'no-resume', mcpCapabilities: { http: scenario !== 'no-mcp' } }, _meta: { agentVersion: scenario === 'unknown-version' ? '99.0.0' : '1.0.45', modelState: state } });
 } else if (m.method === 'authenticate') {
  if (m.params.methodId !== 'cached_token') process.exit(92);
  if (scenario === 'expired' || (scenario === 'lifecycle' && existsSync(join(control, 'refuse-auth')))) send({ id: m.id, error: { code: -32000, message: 'synthetic-secret-never-expose', data: { token: 'synthetic-auth' } } });
  else { authenticated = true; result(m.id, {}); }
 } else if (m.method === 'x.ai/models/list') { result(m.id, { result: state });
 } else if (m.method === 'session/new' || m.method === 'session/load') {
  if (!authenticated) process.exit(93);
  result(m.id, { ...(m.method === 'session/new' ? { sessionId } : {}), models: state });
 } else if (m.method === 'session/set_model') result(m.id, {});
 else if (m.method === 'session/prompt') {
  promptId = m.id;
  if (scenario === 'error') { send({ id: m.id, error: { code: -32000, message: 'synthetic-secret-never-expose' } }); return; }
  if (scenario === 'exit') { process.exit(7); return; }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  // A foreign session must never add text to this Gram thread.
  send({ method: 'session/update', params: { sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREIGN' } } } });
  if (scenario === 'cancel' || scenario === 'hang-cancel' || (scenario === 'lifecycle' && m.params.prompt[0].text.includes('hold'))) return;
  if (scenario === 'served-model') {
    send({ method: 'x.ai/session_notification', params: { sessionId, update: { sessionUpdate: 'model_changed', model_id: 'synthetic-other' } } });
    for (const display_name of ['Synthetic served one', 'Synthetic served two']) send({ method: 'x.ai/session_notification', params: { sessionId, update: { sessionUpdate: 'served_model', display_name } } });
  }
  if (scenario === 'tool' || scenario === 'persistent-only') {
   update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'run_terminal_command', rawInput: { command: 'echo synthetic' }, status: 'pending' });
   send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'tool-1', title: 'run_terminal_command', rawInput: { command: 'echo synthetic' } }, options: scenario === 'persistent-only' ? [{ optionId: 'always', kind: 'allow_always' }] : [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }, { optionId: 'always', kind: 'allow_always' }] } });
   return;
  }
  if (scenario === 'reverse') {
   send({ id: 'file', method: 'fs/write_text_file', params: { sessionId, path: '/synthetic/forbidden', content: 'forbidden' } }); return;
  }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
  result(m.id, { stopReason: 'end_turn' });
 } else if (m.id === 'permission-1') {
  if (m.result?.outcome?.optionId === 'always') process.exit(94);
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: m.result?.outcome?.optionId === 'yes' ? 'synthetic output' : 'denied' });
  result(promptId, { stopReason: 'end_turn' });
 } else if (m.id === 'file') { result(promptId, { stopReason: m.error?.code === -32601 ? 'end_turn' : 'unsafe' }); }
 else if (m.method === 'session/cancel' && scenario !== 'hang-cancel' && !(scenario === 'lifecycle' && existsSync(join(control, 'ignore-cancel')))) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE' } }); result(promptId, { stopReason: 'cancelled' }); }
});
lines.on('close', () => scenario === 'lifecycle' ? setTimeout(() => process.exit(0), 75) : process.exit(0));
