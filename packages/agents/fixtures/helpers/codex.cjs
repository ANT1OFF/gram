// Invented app-server, never contacts a provider or reads credentials.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('codex-cli ' + (process.env.GRAM_HELPER_VERSION || '0.162.1')); process.exit(0); }
const record = (row) => fs.appendFileSync(process.env.GRAM_HELPER_EVIDENCE, JSON.stringify(row) + '\n');
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
record({start:true, pid:process.pid, cwd:process.cwd(), args:process.argv.slice(2), path:process.env.PATH, apiEnvironment:Object.keys(process.env).filter((name)=> /^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|LLM_API_KEY)$/i.test(name) && process.env[name])});
process.on('SIGTERM',()=>{ record({stopped:true,pid:process.pid}); process.exit(0); });
let thread;
require('node:readline').createInterface({input:process.stdin}).on('line',(line)=>{
 const {id,method,params,result} = JSON.parse(line);
 if (!method) { record({answer:true,result}); return; }
 if (id === undefined) return;
 const respond = (reply) => write({id,result:reply});
 record({method,...(method==='thread/start'?{params}:{}),...(method==='turn/start'?{model:params.model,effort:params.effort,serviceTier:params.serviceTier,environments:params.environments,approvalPolicy:params.approvalPolicy,sandboxPolicy:params.sandboxPolicy}: {})});
 switch(method) {
 case 'initialize': respond({userAgent:'synthetic',platformFamily:'unix',platformOs:'macos'}); break;
 case 'account/read': respond({requiresOpenaiAuth:true,account:process.env.GRAM_HELPER_AUTH==='off'?null:{type:process.env.GRAM_HELPER_AUTH==='api'?'apiKey':'chatgpt',email:'invented@example.invalid',planType:'plus'}}); break;
 case 'model/list': respond({data:[{id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6 Luna',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}); break;
 case 'config/read': {
  const features={};const args=process.argv.slice(2);
  for(const arg of args) if(arg.startsWith('features.')&&arg.endsWith('=false')) features[arg.slice(9,-6)]=false;
  if(process.env.GRAM_HELPER_UNSAFE_CONFIG) features.stable_environment_tools=true;
  const forcedBase=process.env.GRAM_HELPER_RETURNED_BASE_URL;
  const pinnedBase=args.find((arg)=>arg.startsWith('openai_base_url='));
  const baseUrl=forcedBase || (pinnedBase?JSON.parse(pinnedBase.slice('openai_base_url='.length)):process.env.GRAM_HELPER_TOML_BASE_URL);
  record({effectiveBaseUrl:baseUrl});
  respond({config:{openai_base_url:baseUrl,model_provider:'openai',web_search:'disabled',agents:{enabled:false},features,mcp_servers:{private_connector:{enabled:true}},apps:{private_app:{enabled:true}}},origins:{},layers:null}); break; }
 case 'thread/start':
   thread={id:randomUUID(),ephemeral:true,environments:[]};
   respond({thread,model:process.env.GRAM_HELPER_MODEL_SUBSTITUTE?'gpt-6-sol':params.model,modelProvider:'openai',reasoningEffort:params.config.model_reasoning_effort,serviceTier:params.serviceTier,approvalPolicy:params.approvalPolicy,sandbox:{type:'readOnly',networkAccess:false}}); break;
 case 'mcpServerStatus/list': respond({data:process.env.GRAM_HELPER_UNSAFE?[{runtimeStatus:'connected'}]:[],nextCursor:null}); break;
 case 'turn/start': {
   const turnId=randomUUID();
   const turn={id:turnId,status:'inProgress',items:[],error:null};
   record({userSent:true});
   write({method:'turn/started',params:{threadId:thread.id,turn}});
   respond({turn});
   if(process.env.GRAM_HELPER_WAIT) break;
   if(process.env.GRAM_HELPER_INTERACTIVE) { write({id:'interactive',method:'item/tool/requestUserInput',params:{threadId:thread.id,turnId,questions:[]}}); break; }
   const prompt=params.input[0].text;
   const text=!process.env.GRAM_HELPER_FEATURES?'{"goal":"synthetic"}':prompt.endsWith('Title:')?'Synthetic helper title':prompt.endsWith('Recap JSON:')?'{"recap":"Synthetic work is ready for review.","next":null,"replies":["Review the change"]}':prompt.endsWith('Replies JSON:')?'{"replies":["Review the change"]}':'{"goal":"synthetic","steps":[{"id":null,"text":"Review the change","status":"todo","pr":null,"evidence":null}],"next":null}';
   const items=process.env.GRAM_HELPER_TOOL?[{type:'commandExecution',id:'unexpected'}]:[{type:'agentMessage',id:'answer',phase:'final_answer',text}];
   write({method:'turn/completed',params:{threadId:thread.id,turn:{...turn,status:'completed',items}}});break;
 }
 case 'turn/interrupt': respond({}); record({interrupted:true}); break;
 default: write({id,error:{message:'Unknown synthetic request '+method}});
 }
});
