// Invented tool-free helper protocol. No provider, credential-store or repository access.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1)
  ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const record = (fields) => fs.appendFileSync(process.env.GRAM_HELPER_EVIDENCE, JSON.stringify(fields) + '\n');
record({ apiEnvironment: Object.keys(process.env).filter((key) => /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|LLM_API_KEY|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/i.test(key) && process.env[key]), path: process.env.PATH, tools: flag('--tools'), strict: args.includes('--strict-mcp-config'), persist: !args.includes('--no-session-persistence'), safe: args.includes('--safe-mode'), settings: flag('--settings'), model: flag('--model'), effort: flag('--effort'), outputCap: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, cwd: process.cwd() });
const models = [{value:'haiku',resolvedModel:'claude-haiku-5-5',displayName:'Haiku 5.5',description:'Synthetic helper model',supportsEffort:true,supportsFastMode:true,supportedEffortLevels:['low','medium','high']}];
require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    const request = msg.request;
    const response = request.subtype === 'initialize' ? {models,commands:[],agents:[],account:{},fast_mode_state:process.env.GRAM_HELPER_FAST?'on':'off'}
      : request.subtype === 'mcp_status' ? {mcpServers: process.env.GRAM_HELPER_UNSAFE ? [{name:'excluded',status:'connected'}] : []} : {};
    write({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response}});
  } else if (msg.type === 'user') {
    record({userSent:true});
    if (process.env.GRAM_HELPER_WAIT) return;
    write({type:'system',subtype:'init',tools:[],mcp_servers:[],model:process.env.GRAM_HELPER_DIFFERENT_MODEL ? 'claude-opus-5-5' : 'claude-haiku-5-5',session_id:randomUUID(),uuid:randomUUID()});
    const prompt = String(msg.message.content);
    const result = !process.env.GRAM_HELPER_FEATURES ? '{"goal":"synthetic"}'
      : prompt.endsWith('Title:') ? 'Synthetic helper title'
      : prompt.endsWith('Recap JSON:') ? '{"recap":"Synthetic work is ready for review.","next":null,"replies":["Review the change"]}'
      : prompt.endsWith('Replies JSON:') ? '{"replies":["Review the change"]}'
      : '{"goal":"synthetic","steps":[{"id":null,"text":"Review the change","status":"todo","pr":null,"evidence":null}],"next":null}';
    write({type:'result',subtype:'success',is_error:false,result,usage:{input_tokens:5,output_tokens:3},session_id:randomUUID(),uuid:randomUUID(),num_turns:1,duration_ms:1,duration_api_ms:1,total_cost_usd:0,modelUsage:{}});
  }
});
