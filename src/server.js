// The MCP tools, shared by both transports: stdio (stdio.js, a token from the environment or the
// CLI profile's sign-in) and the hosted streamable HTTP Worker (worker.js, the caller's own
// OAuth bearer). Both hand handle() one JSON-RPC message and get its answer back; the server
// holds no credential of its own beyond what the transport gives it.
const str={type:'string',minLength:1};
const environment={type:'string',enum:['sandbox','production']};
const product={type:'string',enum:['database','storage','mail','logs','auth']};
// Deploy's own rule for an Idempotency-Key (deploy-worker idempotency.rs): 1-128 printable non-space ASCII.
const idempotencyKey={type:'string',minLength:1,maxLength:128,pattern:'^[!-~]+$',description:'Optional. Repeating a call with the same key never repeats the change; left out, each call gets a fresh key.'};
const scoped={projectId:str,environmentId:environment};
// [name, description, properties, optional arguments, the scope it needs (when known), whether it changes anything]
const definitions=[
 ['mdrn_list_workspaces','List the workspaces this credential reaches, with your role in each; their ids are what the other tools take as workspaceId.',{cursor:str},['cursor'],'workspace:read'],
 ['mdrn_list_projects','List authorized workspace projects.',{workspaceId:str},[],'project:read'],
 ['mdrn_list_products','Inspect product state in one project environment.',scoped,[],'project:read'],
 ['mdrn_list_identity_origins','List the app hostnames of one project environment that have sign-in registered, and whether it is on.',scoped,[],'auth:read'],
 ['mdrn_get_operation','Inspect a durable project operation; pending is not success.',{operationId:str},[],'operation:read'],
 ['mdrn_get_billing','Read workspace billing state without opening checkout or publishing invoices.',{workspaceId:str},[],'billing:read'],
 ['mdrn_get_usage','Read raw and normalized usage, optionally one period statement. Unknown quantities remain unknown.',{workspaceId:str,periodId:str},['periodId'],'usage:read'],
 ['mdrn_list_deploy_services','List scoped deployment services.',scoped,[],'deploy:read'],
 ['mdrn_get_deployment','Inspect one scoped deployment.',{...scoped,deploymentId:str},[],'deploy:read'],
 ['mdrn_list_domains',"List an environment's custom domains with their DNS records and state, and the workspace quota: 5 included, then a monthly price per extra hostname. Adding one is not available here.",scoped,[],'deploy:read'],
 ['mdrn_get','Read an exact allowlisted inspection route. Internal, login, download, checkout and mutation routes are excluded.',{path:str,...scoped},['projectId','environmentId']],
 ['mdrn_list_builds',"List a service's builds, newest first, with their state and the artifact each produced.",{...scoped,serviceId:str,cursor:str},['cursor'],'deploy:read'],
 ['mdrn_get_build','Read one build: its progress, revision and the artifact it produced.',{...scoped,buildId:str},[],'deploy:read'],
 ['mdrn_get_build_logs',"Read a build's output, while it runs or after. Pass the answer's nextCursor to read on.",{...scoped,buildId:str,cursor:str},['cursor'],'deploy:read'],
 ['mdrn_list_releases',"List a service's immutable releases; a release's artifactId is what mdrn_rollback publishes again.",{...scoped,serviceId:str,cursor:str},['cursor'],'deploy:read'],
 ['mdrn_list_deployments','List every release attempt for a service, with its state.',{...scoped,serviceId:str,cursor:str},['cursor'],'deploy:read'],
 ['mdrn_search_logs',"Search the project environment's application logs: q matches text without regard to case, level is a comma-separated list of debug, log, info, warn and error, from and to are Unix milliseconds, service narrows to one service.",{...scoped,q:{type:'string',minLength:1,maxLength:256},level:{type:'string',pattern:'^(debug|log|info|warn|error)(,(debug|log|info|warn|error))*$'},from:{type:'integer',minimum:0},to:{type:'integer',minimum:0},service:str,cursor:str},['q','level','from','to','service','cursor'],'deploy:read'],
 ['mdrn_get_logs_trace',"Read every log item of one request across the environment's services, joined on the trace id Proxy forwards (or the invocation id); from and to are Unix milliseconds, the last hour when omitted.",{...scoped,traceId:str,from:{type:'integer',minimum:0},to:{type:'integer',minimum:0}},['from','to'],'deploy:read'],
 ['mdrn_deploy_connected_repo',"Build and release what a service's connected GitHub branch holds now, as a push would. A commit already built is not built again. Follow it with mdrn_list_builds.",{...scoped,serviceId:str,idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_rollback','Release an earlier artifact of a service again (from mdrn_list_releases or mdrn_list_builds); the current release stays until the new one is live.',{...scoped,serviceId:str,artifactId:str,idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_enable_product','Turn a product on in one project environment. Needs a workspace Admin and the product on the plan. Database may choose its engine (sqlite by default) when first enabled. Answers an operation; follow it with mdrn_get_operation.',{...scoped,product,engine:{type:'string',enum:['sqlite','postgres']},idempotencyKey},['engine','idempotencyKey'],(input)=>`${input.product}:write`,true],
 ['mdrn_disable_product',"Turn a product off in one project environment. Its data is kept, and enabling it again brings it back; deleting is not available here. Answers an operation; follow it with mdrn_get_operation.",{...scoped,product,idempotencyKey},['idempotencyKey'],(input)=>`${input.product}:write`,true],
 ['mdrn_set_variable',"Set a variable on a service. The value is never shown again; secret (default true) records whether it is treated as one, build also gives it to the service's builds. A serving release is published again with it.",{...scoped,serviceId:str,name:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z_][A-Za-z0-9_]*$'},value:{type:'string',minLength:1,maxLength:4096},secret:{type:'boolean'},build:{type:'boolean'},idempotencyKey},['secret','build','idempotencyKey'],'deploy:write',true],
 ['mdrn_unset_variable','Remove a variable from a service; a serving release is published again without it.',{...scoped,serviceId:str,name:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z_][A-Za-z0-9_]*$'},idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_create_service','Create a deployment service in one project environment. Connect its repository in the console.',{...scoped,name:{type:'string',minLength:1,maxLength:63,pattern:'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'},idempotencyKey},['idempotencyKey'],'deploy:write',true],
];
// Reads change nothing; writes change something but never delete what cannot be brought back.
const annotations=(write)=>write?{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
const TOOLS=definitions.map(([name,description,properties,optional,,write])=>({name,description,inputSchema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties).filter(k=>!optional.includes(k))},annotations:annotations(Boolean(write))}));
const SCOPE=new Map(definitions.map(([name,,,,scope])=>[name,scope]));
/** Every scope a tool can need, for the hosted server's protected resource metadata. */
export const SCOPES_SUPPORTED=[...new Set(definitions.flatMap(([,,,,scope])=>typeof scope==='function'?product.enum.map(p=>scope({product:p})):scope?[scope]:[]))].sort();
/** An API answer of 401: the token is unknown, expired or revoked. */
export class ApiUnauthorized extends Error{}
function segment(value){if(typeof value!=='string'||!value)throw Error('Required identifier is missing');return encodeURIComponent(value)}
function checkArgument(key,schema,value){
 const bad=()=>{throw Error(`Invalid argument ${key}`)};
 if(schema.type==='string'){if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity))bad();if(schema.enum&&!schema.enum.includes(value))bad();if(schema.pattern&&!new RegExp(schema.pattern).test(value))bad()}
 else if(schema.type==='boolean'){if(typeof value!=='boolean')bad()}
 else if(schema.type==='integer'){if(!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity))bad()}
}
// A raw API path stays on the API origin under /v1/: no backslash (raw or encoded), fragment, dot
// segment or encoded slash (%2f, which a server may decode into another route), and no malformed
// percent escape, which decodeURIComponent cannot read. The CLI (cli/src/client.js) holds this
// function byte for byte; both packages test it against cli/test/api-paths.json, and the
// CLI's test fails when the two copies differ.
export function safeApiPath(path, origin) {
  if (typeof path !== "string" || !path.startsWith("/v1/") || path.includes("\\") || path.includes("#")) return false;
  let parsed, decoded;
  try {
    parsed = new URL(path, origin);
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  return parsed.origin === new URL(origin).origin && parsed.pathname === path.split("?")[0] && !/%2f/i.test(parsed.pathname)
    && !decoded.includes("\\") && !decoded.split("/").some((part) => part === "." || part === "..");
}
function safePath(path){
 // A path the shared rule refuses (a malformed percent escape too) is outside the allowlist.
 if(!safeApiPath(path,'https://mdrn.invalid'))throw Error('Path outside read-only allowlist');
 const url=new URL(path,'https://mdrn.invalid');
 const id='[A-Za-z0-9_-]+';
 const route=/^\/v1\/platform\/(projects|usage|workspaces)$/.test(url.pathname)||new RegExp(`^/v1/platform/operations/${id}$`).test(url.pathname)||new RegExp(`^/v1/platform/projects/${id}/environments/${id}/(products|identity/origins)$`).test(url.pathname)||new RegExp(`^/v1/platform/workspaces/${id}/billing$`).test(url.pathname)||new RegExp(`^/v1/deploy/(services|domains|domains/${id}|deployments/${id}|logs/trace/${id})$`).test(url.pathname);
 if(!route)throw Error('Path outside read-only allowlist');
 const keys=url.pathname==='/v1/platform/projects'?['workspaceId']:url.pathname==='/v1/platform/usage'?['workspaceId','periodId']:url.pathname==='/v1/platform/workspaces'?['cursor']:url.pathname.startsWith('/v1/deploy/logs/trace/')?['from','to']:[];
 for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw Error('Unsupported inspection query');
 return path;
}
const query=(values)=>{const q=new URLSearchParams();for(const [k,v]of Object.entries(values))if(v!==undefined)q.set(k,String(v));const s=q.toString();return s?`?${s}`:''};
export class MdrnMcpServer{
 // token: the bearer as a string (a management token, or the hosted server's checked bearer), or
 // a getter {get(), refresh()} the stdio transport builds on the CLI profile: get() answers the
 // bearer to send now, refresh() one renewed after the API refused it. version: what initialize
 // reports as serverInfo.version (each transport reads package.json). scopes: what the caller's
 // token was granted, when the transport knows it (the hosted server asks Platform); a tool
 // needing another scope is refused before any request. Without it the API alone decides.
 // rethrowUnauthorized: a 401 from the API is thrown out of handle() rather than answered as a
 // tool error, so the hosted server can answer the HTTP request with its OAuth challenge.
 constructor({token,version='0.0.0',origin='https://api.mdrn.io',fetcher=globalThis.fetch,scopes,rethrowUnauthorized=false}){
  // The token is a bearer credential: https only, except a development server on this machine.
  const url=new URL(origin),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw Error('MDRN_API_ORIGIN must be an https origin');
  this.token=token;this.version=version;this.origin=origin.replace(/\/$/,'');this.fetcher=fetcher;this.scopes=scopes;this.rethrowUnauthorized=rethrowUnauthorized;
  // Every bearer a tool call has sent, redacted from its answer.
  this.seen=new Set();}
 // The bearer to send: the string as it is, or what the getter answers (force: renewed).
 async bearer(force=false){
  const held=this.token;
  const value=typeof held==='string'?held:held?await(force?held.refresh():held.get()):undefined;
  if(value)this.seen.add(value);
  return value;
 }
 async request(method,path,{projectId,environmentId,body,idempotencyKey}={}){
  if(!this.token)throw Error('MDRN_API_TOKEN is not configured');
  const bearer=await this.bearer();if(!bearer)throw Error('MDRN_API_TOKEN is not configured');
  const send=(value)=>{
   const headers=new Headers({Accept:'application/json',Authorization:`Bearer ${value}`});if(projectId)headers.set('MDRN-Project',projectId);if(environmentId)headers.set('MDRN-Environment',environmentId);
   if(body!==undefined)headers.set('Content-Type','application/json');if(idempotencyKey)headers.set('Idempotency-Key',idempotencyKey);
   return this.fetcher(this.origin+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10_000)});
  };
  let response=await send(bearer);
  // A getter's bearer the API refused is renewed once, and the request sent again only when the
  // renewal gave another token; a string token is what it is.
  if(response.status===401&&typeof this.token!=='string'){const renewed=await this.bearer(true);if(renewed&&renewed!==bearer){await response.text().catch(()=>{});response=await send(renewed)}}
  const raw=await response.text();let parsed;try{parsed=raw?JSON.parse(raw):null}catch{throw Error('Invalid JSON API response')}
  if(!response.ok){const e=parsed?.error??{};const message=`${e.code??`HTTP_${response.status}`}: ${e.message??response.statusText}`;throw response.status===401?new ApiUnauthorized(message):Error(message)}return parsed;
 }
 async api(path,projectId,environmentId){
  safePath(path);if(!this.token)throw Error('MDRN_API_TOKEN is not configured');
  if(path.startsWith('/v1/deploy/')&&(!projectId||!environmentId))throw Error('Deploy inspection requires projectId and environmentId');
  return this.request('GET',path,{projectId,environmentId});
 }
 async call(name,input={}){
  const definition=TOOLS.find(t=>t.name===name);if(!definition)throw Error('Unknown tool');
  const properties=definition.inputSchema.properties;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!(k in properties)))throw Error('Invalid tool arguments');
  for(const key of definition.inputSchema.required)if(properties[key].type==='string'&&!properties[key].enum&&!properties[key].pattern)segment(input[key]);else if(input[key]===undefined)throw Error('Required identifier is missing');
  if(input.environmentId!==undefined&&!['sandbox','production'].includes(input.environmentId))throw Error('environmentId must be sandbox or production');
  for(const [key,value]of Object.entries(input))if(value!==undefined)checkArgument(key,properties[key],value);
  const needed=SCOPE.get(name),scope=typeof needed==='function'?needed(input):needed;
  if(this.scopes&&scope&&!this.scopes.includes(scope))throw Error(`insufficient_scope: this connection was not granted ${scope}. Connect MDRN again and allow it.`);
  const base=()=>`/v1/platform/projects/${segment(input.projectId)}/environments/${segment(input.environmentId)}`;
  const deploy={projectId:input.projectId,environmentId:input.environmentId};
  const write={...deploy,idempotencyKey:input.idempotencyKey??globalThis.crypto.randomUUID()};
  const service=()=>`/v1/deploy/services/${segment(input.serviceId)}`;
  switch(name){
   case'mdrn_list_workspaces':return this.api(`/v1/platform/workspaces${query({cursor:input.cursor})}`);
   case'mdrn_list_projects':return this.api(`/v1/platform/projects?workspaceId=${segment(input.workspaceId)}`);
   case'mdrn_list_products':return this.api(`${base()}/products`);
   case'mdrn_list_identity_origins':return this.api(`${base()}/identity/origins`);
   case'mdrn_get_operation':return this.api(`/v1/platform/operations/${segment(input.operationId)}`);
   case'mdrn_get_billing':return this.api(`/v1/platform/workspaces/${segment(input.workspaceId)}/billing`);
   case'mdrn_get_usage':return this.api(`/v1/platform/usage?workspaceId=${segment(input.workspaceId)}${input.periodId?`&periodId=${segment(input.periodId)}`:''}`);
   case'mdrn_list_deploy_services':return this.api('/v1/deploy/services',input.projectId,input.environmentId);
   case'mdrn_list_domains':return this.api('/v1/deploy/domains',input.projectId,input.environmentId);
   case'mdrn_get_deployment':return this.api(`/v1/deploy/deployments/${segment(input.deploymentId)}`,input.projectId,input.environmentId);
   case'mdrn_get':return this.api(input.path,input.projectId,input.environmentId);
   case'mdrn_list_builds':return this.request('GET',`/v1/deploy/builds${query({serviceId:input.serviceId,cursor:input.cursor})}`,deploy);
   case'mdrn_get_build':return this.request('GET',`/v1/deploy/builds/${segment(input.buildId)}`,deploy);
   case'mdrn_get_build_logs':return this.request('GET',`/v1/deploy/builds/${segment(input.buildId)}/logs${query({cursor:input.cursor})}`,deploy);
   case'mdrn_list_releases':return this.request('GET',`/v1/deploy/releases${query({serviceId:input.serviceId,cursor:input.cursor})}`,deploy);
   case'mdrn_list_deployments':return this.request('GET',`/v1/deploy/deployments${query({serviceId:input.serviceId,cursor:input.cursor})}`,deploy);
   case'mdrn_search_logs':return this.request('GET',`/v1/deploy/logs${query({from:input.from,to:input.to,q:input.q,level:input.level,service:input.service,cursor:input.cursor})}`,deploy);
   case'mdrn_get_logs_trace':return this.api(`/v1/deploy/logs/trace/${segment(input.traceId)}${query({from:input.from,to:input.to})}`,input.projectId,input.environmentId);
   case'mdrn_deploy_connected_repo':{
    // Connecting again with what is connected builds the branch's head (deploy-worker github.rs, connect).
    const connection=await this.request('GET',`${service()}/github`,deploy);
    if(!connection?.installationId||!connection?.repositoryId)throw Error('NOT_CONNECTED: this service has no connected repository. Connect one in the console first.');
    if(!connection.autoDeploy)throw Error('MANUAL: this service builds only from uploads, not from its connected branch. Turn on automatic deploys for it in the console first.');
    const started=await this.request('PUT',`${service()}/github`,{...write,body:{installationId:String(connection.installationId),repositoryId:String(connection.repositoryId),branch:connection.branch,autoDeploy:true}});
    return{...started,building:true,next:'MDRN builds the commit the branch points at now; follow it with mdrn_list_builds.'};
   }
   case'mdrn_rollback':return this.request('POST','/v1/deploy/deployments',{...write,body:{serviceId:input.serviceId,artifactId:input.artifactId}});
   case'mdrn_enable_product':
    if(input.engine!==undefined&&input.product!=='database')throw Error('engine is for database only');
    return this.request('POST',`${base()}/products/${segment(input.product)}/enable`,{idempotencyKey:write.idempotencyKey,body:input.engine?{engine:input.engine}:{}});
   case'mdrn_disable_product':return this.request('POST',`${base()}/products/${segment(input.product)}/disable`,{idempotencyKey:write.idempotencyKey,body:{}});
   case'mdrn_set_variable':return this.request('PUT',`${service()}/variables/${segment(input.name)}`,{...write,body:{value:input.value,...(input.secret!==undefined?{secret:input.secret}:{}),...(input.build!==undefined?{build:input.build}:{})}});
   case'mdrn_unset_variable':return this.request('DELETE',`${service()}/variables/${segment(input.name)}`,write);
   case'mdrn_create_service':return this.request('POST','/v1/deploy/services',{...write,body:{name:input.name}});
  }
 }
 async handle(message){
  if(message.method==='initialize')return{jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mdrn',version:this.version}}};
  if(message.method==='ping')return{jsonrpc:'2.0',id:message.id,result:{}};
  if(message.method==='tools/list')return{jsonrpc:'2.0',id:message.id,result:{tools:TOOLS}};
  if(message.method==='tools/call'){
   // The bearers this call sends (a string token, or what the getter answered, renewed or not) are redacted from its answer.
   this.seen=new Set(typeof this.token==='string'?[this.token]:[]);
   let result,isError=false;try{result=await this.call(message.params?.name,message.params?.arguments)}catch(e){if(e instanceof ApiUnauthorized&&this.rethrowUnauthorized)throw e;result=e instanceof Error?e.message:String(e);isError=true}
   let text=typeof result==='string'?result:JSON.stringify(result,null,2);for(const bearer of this.seen)text=text.replaceAll(bearer,'[REDACTED]');
   return{jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text}],isError}}}
  if(message.method?.startsWith('notifications/'))return null;
  return{jsonrpc:'2.0',id:message.id??null,error:{code:-32601,message:'Method not found'}};
 }
}
