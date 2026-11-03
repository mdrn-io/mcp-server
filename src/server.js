// The MCP tools, shared by both transports: stdio (stdio.js, a token from the environment or the
// CLI profile's sign-in) and the hosted streamable HTTP Worker (worker.js, the caller's own
// OAuth bearer). Both hand handle() one JSON-RPC message and get its answer back; the server
// holds no credential of its own beyond what the transport gives it.
//
// Tool names use the console's words: a deployment is what serves an app (the API's "service"),
// a build is one entry of its history, a rollout is a build being put live (the API's
// "deployment"). Descriptions are written for the agent choosing a tool: what it does, when to
// use it, and what to do with the answer.
const str={type:'string',minLength:1};
const environment={type:'string',enum:['sandbox','production'],description:'sandbox or production.'};
const product={type:'string',enum:['sqlite','postgres','objects','mail','logs','auth']};
// SQLite and Postgres are two products, each with its own database in every environment (ADR-94);
// the database tools name the one they work on. Their scopes keep the name database:* for either.
const DATABASES=['sqlite','postgres'];
const DATABASE_NAMES={sqlite:'SQLite',postgres:'Postgres'};
const database={type:'string',enum:DATABASES,description:'Which database: sqlite or postgres.'};
const productScope=(name)=>DATABASES.includes(name)?'database':name;
// Deploy's own rule for an Idempotency-Key (deploy-worker idempotency.rs): 1-128 printable non-space ASCII.
const idempotencyKey={type:'string',minLength:1,maxLength:128,pattern:'^[!-~]+$',description:'Optional. Repeating a call with the same key never repeats the change; left out, each call gets a fresh key.'};
const scoped={projectId:str,environmentId:environment};
const deploymentId={...str,description:'The deployment, from mdrn_list_deployments.'};
// Products belong to the project (ADR-94): one switch for Sandbox and Production, so their tools
// take the project alone.
const PRODUCT_TOOLS=['mdrn_list_products','mdrn_enable_product','mdrn_disable_product'];
// The databases' management API on /v1/sqlite and /v1/postgres: a collection's name and a record's
// or an operation's id are one path segment each; a timestamp is an ISO 8601 moment with its zone.
const segmentId={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'};
const db={...scoped,database};
// A Postgres database is made the first time something uses it; until then a call that needs it
// answers 503 DATABASE_STARTING, and the same call a few seconds later goes through.
const FIRST_USE='Postgres is made the first time something uses it: a call that needs it may answer DATABASE_STARTING while it is made; call again in a few seconds with the same idempotencyKey.';
const DATABASE_CONNECTION_USE="The connectionString is in this answer only: give it to the person now; MDRN never shows the password again. An open connection keeps the database awake, and that time is billed as Postgres compute, so open connections per request.";
// The largest object mdrn_upload_object takes in one call; anything larger goes up with the CLI
// (mdrn objects upload) or the SDK.
export const UPLOAD_LIMIT=4*1024*1024;
const name63={type:'string',minLength:1,maxLength:63,pattern:'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'};
const path={type:'string',minLength:1,maxLength:256,pattern:'^/[^\\s?#]*$'};
// What the agent reads when it connects (initialize's instructions): short, and it defers to the
// CLI's help and the docs, so nothing here goes stale. No build-mode rules: MDRN's answers say them.
export const INSTRUCTIONS=[
 'MDRN hosts apps, with SQLite, Postgres, Objects, Mail, Logs and Auth built in.',
 'To deploy, use the MDRN CLI: `npx @mdrnio/cli --help` and https://mdrn.io/docs explain it. Sign in with `npx @mdrnio/cli login` (the person approves in their browser), then run `npx @mdrnio/cli deploy` in the app\'s folder; the first deploy creates the deployment.',
 'Use these tools to look at projects, deployments, builds, logs and data, and to change what this connection was allowed to change. A tool this connection may not use says so: ask the person to connect again and allow it.',
 'If MDRN refuses something because of a limit or a feature that comes with going live, tell the person instead of working around it.',
].join('\n\n');
// [name, description, properties, optional arguments, the scope it needs (when known), whether it changes anything, whether that cannot be undone, whether repeating it changes nothing more (destructive tools; true unless said)]
const definitions=[
 ['mdrn_list_workspaces','List the workspaces you can reach, with your role in each. Start here when you need a workspaceId.',{cursor:str},['cursor'],'workspace:read'],
 ['mdrn_list_projects','List the projects of a workspace. A project has two environments, sandbox and production; pass its id as projectId to the other tools.',{workspaceId:str},[],'project:read'],
 ['mdrn_create_project','Create a project in a workspace, with its sandbox and production environments and every product on. Use it when the person wants a new app and the workspace has no project for it.',{workspaceId:str,name:{type:'string',minLength:1,maxLength:100},idempotencyKey},['idempotencyKey'],'project:write',true],
 ['mdrn_list_products',"Show which products a project has on (sqlite, postgres, objects, mail, logs, auth) and each one's state in sandbox and production. A new project starts with every product on.",{projectId:str},[],'project:read'],
 ['mdrn_enable_product','Turn a product back on for a project, in sandbox and production at once (each keeps its own data). Only needed for a product someone turned off. Postgres costs nothing until its database is made at first use; code that keeps a connection open keeps it awake and billed, so open connections per request. Answers one operation per environment: follow each with mdrn_get_operation.',{projectId:str,product,idempotencyKey},['idempotencyKey'],(input)=>`${productScope(input.product)}:write`,true],
 ['mdrn_disable_product',"Turn a product off for a project, in sandbox and production at once. Its data is kept, and turning it on again brings it back. Ask the person first: the app loses the product while it is off. Answers one operation per environment: follow each with mdrn_get_operation.",{projectId:str,product,idempotencyKey},['idempotencyKey'],(input)=>`${productScope(input.product)}:write`,true],
 ['mdrn_get_operation','Check a change that takes a while (a product turned on or off): its state is accepted or running until it is succeeded or failed. Call it again while it runs; only succeeded means done.',{operationId:str},[],'operation:read'],
 ['mdrn_get_billing','Read the workspace\'s plan, whether it is in build mode, its credit and invoices. Read only: paying and changing the plan happen in the console.',{workspaceId:str},[],'billing:read'],
 ['mdrn_get_usage','Read what the workspace used this period (or periodId), per meter. A quantity MDRN does not know yet stays null.',{workspaceId:str,periodId:str},['periodId'],'usage:read'],
 ['mdrn_list_deployments','List the deployments of a project environment: each serves one app at its own address (hostname). Use a deployment\'s id as deploymentId for builds, logs, variables and sign-in.',scoped,[],'deploy:read'],
 ['mdrn_create_deployment','Create an empty deployment in a project environment. Usually not needed: the CLI\'s first `mdrn deploy` creates one. Then deploy to it with the CLI, or connect its GitHub repository in the console.',{...scoped,name:name63,idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_list_builds',"List a deployment's builds, newest first: its history. Each has a state, the commit or upload it built, and the artifact it produced (what mdrn_roll_back puts back live).",{...scoped,deploymentId,cursor:str},['cursor'],'deploy:read'],
 ['mdrn_get_build','Read one build: its steps, state and artifact. A failed build carries logTail, the end of its own output, which says why it failed.',{...scoped,buildId:str},[],'deploy:read'],
 ['mdrn_get_build_logs',"Read a build's output, while it runs or after. Pass nextCursor back as cursor to read on.",{...scoped,buildId:str,cursor:str},['cursor'],'deploy:read'],
 ['mdrn_get_rollout','Follow a build being put live (the rolloutId a build or mdrn_roll_back answers): accepted, publishing or verifying until it is ready or failed. A failed one carries logTail, the end of its log with the step that failed; the build serving before keeps serving.',{...scoped,rolloutId:str},[],'deploy:read'],
 ['mdrn_deploy_from_github',"Build and put live what a deployment's connected GitHub branch holds now, as a push would. Only for a deployment with a connected repository; to deploy files from this computer use the CLI (`npx @mdrnio/cli deploy`). Follow it with mdrn_list_builds.",{...scoped,deploymentId,idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_deploy_example',"Deploy one of MDRN's example apps into a deployment: MDRN fetches the example and builds it as an upload, a build like any other. example is its name: saas-starter, files-api or link-shortener (`npx @mdrnio/cli init --help` lists them; the CLI's `init <dir> --example <name>` gives the person its code to change). Make the deployment with mdrn_create_deployment first. Follow it with mdrn_get_build.",{...scoped,deploymentId,example:{type:'string',minLength:1,maxLength:63,pattern:'^[a-z0-9-]+$'},idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_roll_back','Put an earlier build of a deployment back live, by its artifactId from mdrn_list_builds. The current build keeps serving until the earlier one is ready. The database is not rolled back: migrations that ran stay.',{...scoped,deploymentId,artifactId:str,idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_list_variables',"List a deployment's environment variables: name, whether it is secret, whether its builds get it too, and when it was last set. A plain variable's value comes with it; a secret's value never does.",{...scoped,deploymentId},[],'deploy:read'],
 ['mdrn_set_variable',"Set an environment variable on a deployment. secret (default true) makes it write-only: its value is never shown again. build also gives it to the deployment's builds. The serving build is put live again with it.",{...scoped,deploymentId,name:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z_][A-Za-z0-9_]*$'},value:{type:'string',minLength:1,maxLength:5120},secret:{type:'boolean'},build:{type:'boolean'},idempotencyKey},['secret','build','idempotencyKey'],'deploy:write',true],
 ['mdrn_unset_variable','Remove an environment variable from a deployment; the serving build is put live again without it.',{...scoped,deploymentId,name:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z_][A-Za-z0-9_]*$'},idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_clear_build_cache',"Delete a deployment's build cache: the dependencies and compiled files its builds keep for the next one. Its next build downloads and compiles everything again, so it takes longer. Nothing serving changes. Refused while a build of the deployment is running.",{...scoped,deploymentId,idempotencyKey},['idempotencyKey'],'deploy:write',true],
 ['mdrn_list_domains',"List an environment's custom domains with their DNS records and state. Adding a domain is done in the console.",scoped,[],'deploy:read'],
 ['mdrn_list_owned_domains',"List the environment's own domains (such as example.com) and what answers under each. A domain is pending until its ownership TXT record (in records) is seen, then verified. uses lists, each with its state, the hosts under it that serve a deployment (deploymentId and its name) or the environment's downloads, and the Mail senders on it or a host under it (address is where mail leaves from). Under means the domain itself or a name ending in . and the domain. mailRead false means Mail could not be read, so senders may be missing rather than absent. Adding, verifying and choosing what answers on a domain are done in the console; mdrn_list_domains has each host's DNS records.",scoped,[],'deploy:read'],
 ['mdrn_set_mail_address',"Choose the address an environment's mail leaves from on one of its mail domains, such as orders@example.com (noreply@ until chosen). The domain must already send mail: a use mail in mdrn_list_owned_domains; adding one is done in the console. The part before the @ is 1 to 64 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit, never two dots in a row. The domain keeps its records and state, and mail already queued leaves from the new address. Ask the person which address they want.",{...scoped,address:{type:'string',minLength:3,maxLength:318,pattern:'^[a-z0-9]([a-z0-9.-]{0,62}[a-z0-9])?@[A-Za-z0-9.-]+$'},idempotencyKey},['idempotencyKey'],'mail:write',true],
 ['mdrn_open_app',"Get a link that opens a deployment's app at its own address, signed in as the person. In build mode only the person can open the app, and the link works for 15 minutes: give it to the person to open, and keep it out of anything shared.",{...scoped,deploymentId},[],'deploy:read'],
 ['mdrn_search_logs',"Search an environment's application logs (requests, console lines, errors), newest first. q matches text without regard to case; level is a comma-separated list of debug, log, info, warn and error; from and to are Unix milliseconds (the last hour when left out); deploymentId narrows to one deployment. Use it to find why an app misbehaves.",{...scoped,q:{type:'string',minLength:1,maxLength:256},level:{type:'string',pattern:'^(debug|log|info|warn|error)(,(debug|log|info|warn|error))*$'},from:{type:'integer',minimum:0},to:{type:'integer',minimum:0},deploymentId,cursor:str},['q','level','from','to','deploymentId','cursor'],'deploy:read'],
 ['mdrn_get_request_logs',"Read everything one request logged, across the environment's deployments, by its trace id (a search result's traceId); from and to are Unix milliseconds, the last hour when left out.",{...scoped,traceId:str,from:{type:'integer',minimum:0},to:{type:'integer',minimum:0}},['from','to'],'deploy:read'],
 ['mdrn_get_database_config',"Read one environment's SQLite or Postgres database: state, created (false for a Postgres database not made yet), revision, restore window and history, and the Postgres connection string's role and host (the host only for an Admin or Developer; never its password). Reading it never makes the database.",db,[],'database:read'],
 ['mdrn_list_collections',"List the database's collections (what the app stores through the SDK's records API) by name, each with its record count up to 1000.",db,[],'database:read'],
 ['mdrn_list_records',`List one page of a collection's records, by id, each with its data and version. limit is 1 to 200, 50 when left out; pass nextCursor back as cursor until it is null. Records are read here; the app writes them. ${FIRST_USE}`,{...db,collection:segmentId,limit:{type:'integer',minimum:1,maximum:200},cursor:{type:'string',minLength:1,maxLength:512}},['limit','cursor'],'database:read'],
 ['mdrn_get_record',`Read one record of a collection, with its data and version. A missing one is NOT_FOUND. ${FIRST_USE}`,{...db,collection:segmentId,recordId:segmentId},[],'database:read'],
 ['mdrn_list_database_backups',"List the snapshots the SQLite database can be restored to (taken before every restore and deletion, kept 7 days). SQLite only: Postgres restores to a moment in its restore history.",db,[],'database:read'],
 ['mdrn_get_database_operation',"Check a database restore or deletion: accepted or running until it is succeeded or failed.",{...db,operationId:segmentId},[],'database:read'],
 ['mdrn_set_database_restore_history',"Set how far back Postgres can be restored: 0 turns it off, or 1, 7 or 30 days. Turning it off or shortening it drops the older history for good; kept history is billed. Ask the person first. Postgres only.",{...db,restoreHistoryDays:{type:'integer',enum:[0,1,7,30]},idempotencyKey},['idempotencyKey'],'database:write',true,true],
 ['mdrn_run_sql',`Run one SQL statement on the environment's SQLite or Postgres database, in its dialect, and answer the rows. params binds the placeholders: at most 100 strings, numbers, booleans or nulls. Prefer reads; a statement that changes data needs a connection allowed to change data, and is not undone, so ask the person first. Read large tables in pages with LIMIT: a result over 4 MiB is refused. MDRN's own tables (named _mdrn_ or _cf_) are hidden from listings and cannot be changed; this tool does not run a statement that names them. ${FIRST_USE}`,{...db,sql:{type:'string',minLength:1,maxLength:100000},params:{type:'array',maxItems:100,items:{type:['string','number','boolean','null']}},idempotencyKey},['params','idempotencyKey'],'database:write',true,true,false],
 ['mdrn_database_connection',`Change the Postgres connection string: on turns it on and rotate makes a new one (both answer it once), off stops it for good, stop_previous stops the string a rotation replaced. on, rotate and off put every live deployment of the environment live again with the change unless redeploy is false. off, stop_previous and a rotation without redeploy leave a deployment without its database until it is deployed again, so ask the person first. ${DATABASE_CONNECTION_USE} Postgres only.`,{...db,action:{type:'string',enum:['on','rotate','off','stop_previous']},redeploy:{type:'boolean'},idempotencyKey},['redeploy','idempotencyKey'],'database:write',true,true,false],
 ['mdrn_restore_database',"Restore the environment's SQLite or Postgres database to an earlier state: timestamp (an ISO 8601 moment in the restore window) or, for SQLite, backupId (from mdrn_list_database_backups). It replaces the database in use: ask the person, then pass confirmOverwrite true. MDRN keeps a copy of what it replaces: for SQLite a snapshot kept 7 days; for Postgres until the next restore (earlier copies are not kept; to get that copy back, the person contacts support). Follow it with mdrn_get_database_operation.",{...db,timestamp:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+(Z|[+-]\\d{2}:\\d{2})$'},backupId:segmentId,confirmOverwrite:{type:'boolean'},idempotencyKey},['timestamp','backupId','idempotencyKey'],'database:write',true,true,false],
 ['mdrn_list_objects',"List an environment's stored files (Objects), newest first: id, filename, size, content type and state. limit is 1 to 200.",{...scoped,limit:{type:'integer',minimum:1,maximum:200},cursor:{type:'string',minLength:1,maxLength:512}},['limit','cursor'],'objects:read'],
 ['mdrn_get_object_link',"Get a download link for one stored file. It works for a short time: give it to the person or fetch it now, and keep it out of anything shared.",{...scoped,objectId:str},[],'objects:read'],
 ['mdrn_upload_object',`Store a file in an environment's Objects: text, or base64 for anything else, at most ${UPLOAD_LIMIT/1024/1024} MiB. For a larger file use the CLI (\`npx @mdrnio/cli objects upload <file>\`). Answers the object; it is checked against its SHA-256 before it can be downloaded.`,{...scoped,filename:{type:'string',minLength:1,maxLength:255},contentType:{type:'string',minLength:1,maxLength:255},text:{type:'string',maxLength:UPLOAD_LIMIT},base64:{type:'string',maxLength:Math.ceil(UPLOAD_LIMIT/3)*4},idempotencyKey},['contentType','text','base64','idempotencyKey'],'objects:write',true],
 ['mdrn_delete_object',"Delete a stored file. It can be restored until it is purged (the answer's purgeAt). Ask the person first.",{...scoped,objectId:str,idempotencyKey},['idempotencyKey'],'objects:write',true,true],
 ['mdrn_list_mail_messages',"List the emails an environment's app sent, newest first: id, status (queued, sending, accepted, delivered, bounced, complained, failed), recipient, subject and when. status narrows to one status.",{...scoped,status:{type:'string',enum:['queued','sending','accepted','delivered','bounced','complained','failed','unknown']},cursor:{type:'string',minLength:1,maxLength:512}},['status','cursor'],'mail:read'],
 ['mdrn_get_mail_message',"Read one sent email whole: status, why it failed or bounced, its timeline, and the body while it is still kept.",{...scoped,messageId:str},[],'mail:read'],
 ['mdrn_send_test_email',"Send one plain test email through the environment's Mail, as the app would, to see that mail works. It counts like any email the app sends: metered, and toward the hourly, daily and build-mode limits. In build mode mail goes to members of the workspace only. Follow it with mdrn_get_mail_message.",{...scoped,to:{type:'string',minLength:3,maxLength:254,pattern:'^[^@\\s]+@[^@\\s]+$'},idempotencyKey},['idempotencyKey'],'mail:send',true],
 ['mdrn_get_auth_settings',"Read who must sign in to each deployment of an environment (signIn: everyone must sign in except on its publicPaths, the app decides, or off), the account page your users manage themselves on, the sign-in session limits, and two-factor authentication (secondFactor: off, optional or required).",scoped,[],'auth:read'],
 ['mdrn_set_sign_in',"Set who must sign in to one deployment: everyone (everyone must sign in, except on publicPaths such as / or /blog/*), app_decides (the app asks MDRN who is signed in and decides), or off. Turning it on serves the sign-in pages at the deployment's address. Ask the person before protecting or opening an app.",{...scoped,deploymentId,mode:{type:'string',enum:['everyone','app_decides','off']},publicPaths:{type:'array',maxItems:50,items:path},idempotencyKey},['publicPaths','idempotencyKey'],'auth:write',true],
 ['mdrn_list_auth_users',"List the app's users (the people who signed in to it), newest first: id, email, name, whether disabled, when created and last signed in, and whether two-factor authentication is on (secondFactor). email narrows to addresses containing the text.",{...scoped,email:{type:'string',minLength:1,maxLength:256},cursor:{type:'string',minLength:1,maxLength:512}},['email','cursor'],'auth:read'],
 ['mdrn_export_auth_users',"Export the app's users a page at a time in id order, with every sign-in method and the subject ID its provider knows each by, to move them to another system. No passwords, sessions or tokens. Pass nextCursor back as cursor until it is null; limit is 1 to 1000.",{...scoped,cursor:{type:'string',minLength:1,maxLength:256},limit:{type:'integer',minimum:1,maximum:1000}},['cursor','limit'],'auth:read'],
 ['mdrn_read_api','Read an MDRN API page no other tool covers, by its path: the workspaces, projects, usage, an operation, the products, billing, the deployments, domains, a rollout or a request\'s logs. Read only.',{path:str,...scoped},['projectId','environmentId']],
];
// Reads change nothing; most writes change something but never delete what cannot be brought back.
// The destructive ones can: deleting an object and setting restore history (idempotent: the same
// again changes nothing more), and running SQL, the connection string's changes and a restore (not
// idempotent).
const annotations=(write,destructive,idempotent=true)=>destructive?{readOnlyHint:false,destructiveHint:true,idempotentHint:idempotent,openWorldHint:true}:write?{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
const TOOLS=definitions.map(([name,description,properties,optional,,write,destructive,idempotent])=>({name,description,inputSchema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties).filter(k=>!optional.includes(k))},annotations:annotations(Boolean(write),Boolean(destructive),idempotent!==false)}));
const SCOPE=new Map(definitions.map(([name,,,,scope])=>[name,scope]));
/** The scope a tool needs, as the docs name it (a product tool needs that product's write scope). */
export const scopeOf=(name)=>{const scope=SCOPE.get(name);return typeof scope==='function'?"the product's write scope":scope??null};
// The tools that change something: in Production they also need PRODUCTION_WRITE.
const WRITES=new Set(definitions.filter(([,,,,,write])=>write).map(([name])=>name));
/** The extra choice a connection needs to change anything in Production (platform/src/domain.rs). */
export const PRODUCTION_WRITE='production:write';
/** Where a connection may act at all, as the person ticked it (platform/src/domain.rs): a connection holding either
 * reaches only the environments it names, to read as to write; one holding neither (made before) reaches both. */
export const ENVIRONMENT_ACCESS={sandbox:'sandbox:access',production:'production:access'};
const ENVIRONMENT_WORDS={sandbox:'Sandbox',production:'Production'};
// A scope as the person chose it when connecting, for a refusal the agent passes on.
const SCOPE_WORDS={'database:write':'changes to your data (database:write)','deploy:write':'deploying and changing deployments (deploy:write)','objects:write':'changing stored files (objects:write)','mail:send':'sending email (mail:send)','mail:write':'changing mail settings (mail:write)','auth:write':'changing sign-in (auth:write)','project:write':'creating projects (project:write)'};
// MDRN's own tables, and the provider's, in a SQL statement or a listing: _mdrn_* and _cf_*.
const INTERNAL=/(^|[^A-Za-z0-9_])["'`\[]?_(mdrn|cf)_/i;
export const internalTable=(sql)=>INTERNAL.test(` ${sql}`);
// A SQL answer without the rows that name MDRN's own tables (sqlite_master, information_schema).
export function hideInternal(answer){
 const clean=(rows)=>Array.isArray(rows)?rows.filter(row=>!(row&&typeof row==='object'&&['name','tbl_name','table_name'].some(k=>typeof row[k]==='string'&&/^_(mdrn|cf)_/i.test(row[k])))):rows;
 if(!answer||typeof answer!=='object')return answer;
 const results=Array.isArray(answer.results)?answer.results.map(r=>r&&typeof r==='object'&&Array.isArray(r.results)?{...r,results:clean(r.results)}:r):answer.results;
 return{...answer,results:Array.isArray(results)&&results.every(r=>!r||typeof r!=='object'||!Array.isArray(r.results))?clean(results):results};
}
/** Every scope a tool can need, for the hosted server's protected resource metadata. */
export const SCOPES_SUPPORTED=[...new Set([...definitions.flatMap(([,,,,scope])=>typeof scope==='function'?product.enum.map(p=>scope({product:p})):scope?[scope]:[]),PRODUCTION_WRITE])].sort();
// Where each error code is explained: its section of the docs' Errors page (a code missing here
// links the page itself). The CLI (cli/src/help.js) keeps the same table; its test holds the two
// equal and every entry to the page's headings.
export const ERROR_SECTIONS = {
  "any-request": ["INVALID_INPUT", "INVALID_REQUEST", "INVALID_AUTHORITY", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYLOAD_TOO_LARGE", "BODY_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "PRECONDITION_REQUIRED", "RATE_LIMITED", "DEPENDENCY_UNAVAILABLE", "UNAVAILABLE"],
  "visitors-to-your-app": ["BOT_REFUSED", "CROSS_ORIGIN_SOCKET", "CALL_FROM_BACKEND", "UNSUPPORTED_FEATURE", "BAD_GATEWAY", "GATEWAY_TIMEOUT", "NOT_LIVE_YET"],
  builds: ["UPLOAD_TOO_LARGE", "SOURCE_TOO_LARGE", "BUILD_IN_PROGRESS", "NO_BUILD_MACHINE", "BUILD_REFUSED", "BUILD_FAILED", "DATABASE_CHANGED", "DATABASE_PARTIALLY_CHANGED", "DATABASE_OUTCOME_UNKNOWN"],
  releases: ["RELEASE_REFUSED", "MIGRATION_FAILED", "DEPLOYMENT_FAILED"],
  "custom-domains": ["DOMAIN_CHARGE_CONFIRMATION_REQUIRED", "DOMAIN_CHARGE_CHANGED", "DOMAIN_LIMIT_REACHED", "CUSTOM_DOMAINS_UNAVAILABLE"],
  "every-product": ["PRODUCT_ACCESS_DENIED", "PRODUCT_ENTITLEMENT_REQUIRED", "PRODUCT_DISABLED", "PRODUCT_DELETED", "PRODUCT_ARCHIVED", "PRODUCT_OPERATION_IN_PROGRESS", "RESTORE_UNAVAILABLE", "IN_PROGRESS"],
  database: ["PRODUCT_NOT_ENABLED", "DATABASE_STARTING", "DATABASE_BUSY", "RESTORE_HISTORY_OFF", "HISTORY_NOT_AVAILABLE", "CONNECTION_POSTGRES_ONLY", "CONNECTION_EXISTS", "CONNECTION_OFF", "REPLAY_WINDOW_EXPIRED", "OUTCOME_UNKNOWN", "SQL_ERROR", "QUERY_LIMIT_EXCEEDED", "COORDINATOR_BUSY", "EXPORT_IN_PROGRESS", "EXPORT_LIMIT_REACHED", "EXPORT_TOO_LARGE", "EXPORT_FAILED", "DOWNLOAD_EXPIRED", "EXPORT_EXPIRED"],
  objects: ["OBJECTS_QUOTA_EXCEEDED", "INVALID_RANGE", "TOO_MANY_OPEN_UPLOADS"],
  mail: ["RECIPIENT_SUPPRESSED", "SENDER_NOT_READY", "SENDER_WORKSPACE_LIMIT", "SENDER_LIMIT_NOT_REACHED", "SENDER_REQUIRED", "MAIL_DAILY_LIMIT", "RECIPIENT_RATE_LIMITED", "BUILD_MAIL_RECIPIENT", "MAIL_UNAVAILABLE"],
  auth: ["SIGN_IN_UNAVAILABLE"],
  tools: ["access_denied", "invalid_token", "invalid_grant", "insufficient_scope"],
  billing: ["PAYMENT_REQUIRED", "PAYMENT_OVERDUE", "SPENDING_CAP_REACHED", "BUILD_LIMIT_REACHED", "BUILD_MODE_GO_LIVE_REQUIRED", "BUILD_WORKSPACE_EXISTS", "BUILD_WORKSPACES_FULL", "WORKSPACE_BLOCKED", "PLAN_ALREADY_ACTIVE"],
  teams: ["SESSION_REQUIRED", "EMAIL_MISMATCH", "ALREADY_MEMBER", "INVITATION_PENDING", "INVITATION_LIMIT", "INVITATION_TOO_SOON", "INVITATION_SEND_LIMIT", "PLAN_REQUIRED", "RESEND_LIMIT", "LAST_ADMIN", "INVITATION_EXPIRED"],
  "tokens-and-the-account": ["ACCOUNT_DISABLED", "TERMS_NOT_AGREED", "TERMS_STALE", "EMAIL_REQUIRED", "EMAIL_NOT_ACCEPTED", "BOT_CHECK_FAILED"],
};
const DOCS_ERRORS='https://mdrn.io/docs/errors/';
export function errorDocs(code){const section=Object.keys(ERROR_SECTIONS).find(k=>ERROR_SECTIONS[k].includes(code));return section?`${DOCS_ERRORS}#${section}`:DOCS_ERRORS}
// The console of an API origin: api.mdrn.io's is console.mdrn.io, development.api.mdrn.io's development.console.mdrn.io.
export function consoleOrigin(origin){const host=new URL(origin).hostname;return /(^|\.)api\./.test(host)?`https://${host.replace(/(^|\.)api\./,'$1console.')}`:'https://console.mdrn.io'}
const PLAN_CODES=['PAYMENT_REQUIRED','PRODUCT_ENTITLEMENT_REQUIRED'];
// What to do about an error code, as steps: going live when build mode stopped it, the plan, the
// unpaid charge or the cap when billing did, and always the docs that explain the code.
function errorSteps(code,console){
 if(typeof code!=='string'||!code)return[];
 // Not a refusal: the Postgres database is being made at its first use, and the same call goes through shortly.
 if(code==='DATABASE_STARTING')return[{step:'The Postgres database is being made, the first time it is used: call the same tool again in a few seconds, with the same idempotencyKey',url:errorDocs(code)}];
 const billing=`${console}/billing`,goLive=`${console}/go-live`;
 const first=PLAN_CODES.includes(code)?[{step:"The workspace needs the $25 plan: an Admin goes live in the console",url:goLive}]
  :code==='PAYMENT_OVERDUE'?[{step:"An Admin pays the unpaid charge on the console's Billing page",url:billing}]
  :code==='BUILD_LIMIT_REACHED'?[{step:"Build mode limit reached: tell the person. Going live (an Admin, in the console) lifts it",url:goLive}]
  :code==='BUILD_MODE_GO_LIVE_REQUIRED'?[{step:"This comes with going live: tell the person instead of working around it. An Admin goes live in the console",url:goLive}]
  :code==='NOT_LIVE_YET'?[{step:"The app is in build mode and only the person can open it: get them a link with mdrn_open_app; or an Admin goes live in the console",url:goLive}]
  :code==='BUILD_WORKSPACE_EXISTS'?[{step:"Each person has one workspace in build mode, and you have yours: keep building in it, or go live with it in the console to lift build mode's limits",url:goLive}]
  :code==='BUILD_WORKSPACES_FULL'?[{step:"New workspaces in build mode are paused for now: try again later from the console",url:console}]
  :code==='WORKSPACE_BLOCKED'?[{step:"MDRN stopped this workspace: if you think this is a mistake, contact us from the console",url:console}]
  :code==='BUILD_MAIL_RECIPIENT'?[{step:"In build mode mail goes only to members of your workspace: send to one of them, or an Admin goes live in the console",url:goLive}]
  :code==='SPENDING_CAP_REACHED'?[{step:"An Admin raises the spending cap on the console's Billing page",url:billing}]:[];
 return[...first,{step:`Read what ${code} means and what to do`,url:errorDocs(code)}];
}
// How many of the last log lines a failed build or rollout carries as logTail.
const TAIL_LINES=20;
const RUNNING_OPERATION=['accepted','running','waiting'];
const RUNNING_BUILD=['queued','building'];
const RUNNING_ROLLOUT=['accepted','publishing','verifying'];
const RUNNING_DATABASE_OPERATION=['accepted','running'];
// What a CLI deploy is, for the next steps that send the agent to it.
const CLI_DEPLOY='Deploy this folder with the MDRN CLI: `npx @mdrnio/cli login`, then `npx @mdrnio/cli deploy` (the first deploy creates the deployment)';
// The next steps after a tool's answer: what the caller can do now, each a tool to call (with the
// arguments known so far) or a page to open. Only for the main flows; undefined for the rest.
function nextSteps(name,input,result,console){
 if(!result||typeof result!=='object'||Array.isArray(result))return undefined;
 const tool=(step,name,args)=>({step,tool:name,arguments:args});
 const scope={projectId:input.projectId,environmentId:input.environmentId};
 // The database tools' next steps stay on the same database.
 const dbScope={...scope,database:input.database};
 const items=Array.isArray(result.items)?result.items:[];
 const operation=()=>{
  if(RUNNING_OPERATION.includes(result.state))return[tool('The change is still running: read the operation again shortly','mdrn_get_operation',{operationId:result.id})];
  const list=tool('See the product states','mdrn_list_products',{projectId:result.projectId});
  if(result.state==='failed')return[...errorSteps(result.error?.code,console),list];
  return result.state==='succeeded'?[list]:undefined;
 };
 switch(name){
  case'mdrn_list_projects':{
   if(!items.length)return[tool('The workspace has no project: create one','mdrn_create_project',{workspaceId:input.workspaceId})];
   const args={...(items.length===1?{projectId:items[0].id}:{}),environmentId:'sandbox'};
   return[tool(items.length===1?"List the project's deployments":'Pick a project and list its deployments','mdrn_list_deployments',args),tool('See which products are on','mdrn_list_products',items.length===1?{projectId:items[0].id}:{})];
  }
  case'mdrn_create_project':return[{step:CLI_DEPLOY,url:'https://mdrn.io/docs/cli/'},tool('List its deployments once deployed','mdrn_list_deployments',{projectId:result.id,environmentId:'sandbox'})];
  case'mdrn_list_deployments':{
   if(!items.length)return[{step:`The environment has no deployment yet. ${CLI_DEPLOY}`,url:'https://mdrn.io/docs/cli/'}];
   const args={...scope,...(items.length===1?{deploymentId:items[0].id}:{})};
   return[tool("See the deployment's builds",'mdrn_list_builds',args),tool('Search its logs','mdrn_search_logs',args)];
  }
  case'mdrn_create_deployment':return[
   {step:`Deploy to it with the MDRN CLI: \`npx @mdrnio/cli deploy --project ${input.projectId} --deployment ${result.id}\`, or connect its GitHub repository in the console`,url:`${console}/?project=${encodeURIComponent(input.projectId)}`},
  ];
  case'mdrn_deploy_from_github':return[tool('Find the new build and follow it','mdrn_list_builds',{...scope,deploymentId:input.deploymentId})];
  case'mdrn_deploy_example':return result.buildId?[tool('Follow the build until it ends','mdrn_get_build',{...scope,buildId:result.buildId})]:undefined;
  case'mdrn_roll_back':return[tool('Follow it until it is ready','mdrn_get_rollout',{...scope,rolloutId:result.deploymentId})];
  case'mdrn_open_app':return result.url?[{step:result.ownerOnly?'Give the person this link to open the app within 15 minutes':'Open the app',url:result.url}]:undefined;
  case'mdrn_enable_product':case'mdrn_disable_product':{
   // One operation per environment the workspace may use now; the rest follow at go-live.
   const operations=Array.isArray(result.operations)?result.operations:[];
   const steps=[];
   for(const op of operations){
    if(RUNNING_OPERATION.includes(op.state))steps.push(tool(`${op.environment??'The environment'} is still changing: read its operation again shortly`,'mdrn_get_operation',{operationId:op.id}));
    else if(op.state==='failed')steps.push(...errorSteps(op.error?.code,console));
   }
   steps.push(tool('See the product states','mdrn_list_products',{projectId:input.projectId}));
   return steps;
  }
  case'mdrn_get_operation':return operation();
  case'mdrn_list_products':{
   const off=items.filter(p=>p.state==='never_enabled'||p.state==='disabled').map(p=>p.product);
   const steps=[];
   for(const p of items)for(const [name,env]of Object.entries(p.environments??{}))if(env?.state==='provisioning'&&env.operationId)steps.push(tool(`${p.product} is being switched on in ${name}: follow its operation`,'mdrn_get_operation',{operationId:env.operationId}));
   if(off.length)steps.push(tool(`Switch a product on (off now: ${off.join(', ')})`,'mdrn_enable_product',{projectId:input.projectId}));
   return steps.length?steps:undefined;
  }
  case'mdrn_get_build':{
   const args={...scope,buildId:result.id};
   if(RUNNING_BUILD.includes(result.state))return[tool('Read its output so far','mdrn_get_build_logs',args),tool('Read the build again until it ends','mdrn_get_build',args)];
   if(result.state==='failed')return[tool('logTail is the end of its own output, which says why it failed; read all of it from the start','mdrn_get_build_logs',args),...errorSteps(result.errorCode,console)];
   if(result.state!=='succeeded')return undefined;
   return result.deploymentId?[tool('Follow it being put live until it is ready','mdrn_get_rollout',{...scope,rolloutId:result.deploymentId})]:[tool('Read the build again: it is put live once its bundle is stored','mdrn_get_build',args)];
  }
  case'mdrn_get_database_config':return result.created===false?[tool('The Postgres database is made the first time something uses it: run a statement to make it now, or let the app make it','mdrn_run_sql',dbScope)]:undefined;
  case'mdrn_list_collections':return items.length?[tool("Read a collection's records",'mdrn_list_records',{...dbScope,...(items.length===1?{collection:items[0].name}:{})})]:undefined;
  case'mdrn_list_records':return result.nextCursor?[tool('Read the next page','mdrn_list_records',{...dbScope,collection:input.collection,...(input.limit?{limit:input.limit}:{}),cursor:result.nextCursor})]:undefined;
  case'mdrn_restore_database':case'mdrn_get_database_operation':{
   if(RUNNING_DATABASE_OPERATION.includes(result.state))return[tool('The restore is still running: read the operation again shortly','mdrn_get_database_operation',{...dbScope,operationId:result.id})];
   if(result.state==='failed')return[...errorSteps(result.error?.code,console),tool("See the database's state",'mdrn_get_database_config',dbScope)];
   return result.state==='succeeded'?[tool("See the database's state",'mdrn_get_database_config',dbScope)]:undefined;
  }
  case'mdrn_database_connection':{
   const steps=[tool('See the connection and its previous string','mdrn_get_database_config',dbScope)];
   if(result.previous?.state==='kept')steps.push(tool('Once every deployment that uses it is live with the new string, stop the previous one (ask the person first)','mdrn_database_connection',{...dbScope,action:'stop_previous'}));
   for(const s of result.redeploy?.services??[])if(s.outcome==='redeploying'&&s.deploymentId)steps.push(tool(`Follow ${s.name} being put live again until it is ready`,'mdrn_get_rollout',{...scope,rolloutId:s.deploymentId}));
   return steps;
  }
  case'mdrn_get_rollout':{
   if(RUNNING_ROLLOUT.includes(result.state))return[tool('Read it again until it ends','mdrn_get_rollout',{...scope,rolloutId:result.id})];
   if(result.state==='ready')return[tool('Get a link to open the app','mdrn_open_app',{...scope,deploymentId:result.serviceId})];
   if(result.state==='failed')return[...errorSteps(result.errorCode,console),tool('logTail is the end of its log, with the step that failed. The build serving before keeps serving; to put an earlier build back, pick one from the history','mdrn_list_builds',{...scope,deploymentId:result.serviceId})];
   return undefined;
  }
  case'mdrn_upload_object':return result.id?[tool('Get a link to download it','mdrn_get_object_link',{...scope,objectId:result.id})]:undefined;
  case'mdrn_send_test_email':return result.id?[tool('See what became of it','mdrn_get_mail_message',{...scope,messageId:result.id})]:undefined;
  case'mdrn_set_sign_in':return[tool("See every deployment's sign-in",'mdrn_get_auth_settings',scope)];
 }
 return undefined;
}
/** An API answer of 401: the token is unknown, expired or revoked. */
export class ApiUnauthorized extends Error{}
function segment(value){if(typeof value!=='string'||!value)throw Error('Required identifier is missing');return encodeURIComponent(value)}
// A host's error as Deploy words it (deploy-worker domains.rs), passed on as it is. Anything else
// in that field (a provider's own text, kept on an older host) is never answered: the host's
// state says where it stands, in our words, and the raw text stays in Deploy's logs. The CLI
// (cli/src/domains.js) keeps the same words.
const DEPLOY_WORDS=new Set([
 'This hostname is already connected to another account elsewhere.',
 'This hostname cannot be used as a custom domain. Check that it is spelled right and is a domain you own, then delete it and add it again.',
 "The hostname was removed from MDRN's network, so it is not served and not charged. Delete it and add it again.",
 'This hostname could not be verified, so it is not served and not charged. Check its DNS records, then delete it and add it again.',
 'The certificate is not issued yet. Check the certificate records below; the hostname is checked again on its own, or use Check now.',
 'The hostname does not point to MDRN yet. Check the CNAME record below; the hostname is checked again on its own, or use Check now.',
 'This hostname no longer points to MDRN, so it is not served and not charged, and the generated name serves the app again. Delete it and add it again once its CNAME points here.',
 'The CNAME points to MDRN, but this workspace has not yet proved it controls the hostname. Add the ownership TXT record below; the hostname is checked again on its own, or use Check now.',
]);
const STATE_WORDS={
 ownership_pending:'The hostname does not point to MDRN yet. Check its DNS records; the hostname is checked again on its own, or use Check now.',
 ssl_pending:'The certificate is not issued yet. Check its certificate records; the hostname is checked again on its own, or use Check now.',
 failed:'This hostname could not be set up, so it is not served and not charged. Check its DNS records, then delete it and add it again.',
 active:'MDRN is checking this hostname again; it keeps serving meanwhile.',
};
/** A host's error in our words: Deploy's own sentence, or one for its state; null when it has none. */
export function hostError(host){
 const error=host?.error;
 if(typeof error!=='string'||!error)return null;
 if(DEPLOY_WORDS.has(error))return error;
 // An older host kept the provider's view of a CNAME it saw: the same sentence, in our words.
 if(/has verified the CNAME, but this workspace has not yet proved/.test(error))return 'The CNAME points to MDRN, but this workspace has not yet proved it controls the hostname. Add the ownership TXT record below; the hostname is checked again on its own, or use Check now.';
 return STATE_WORDS[host.state]??null;
}
/** Deploy's answer about hosts (one host, or a page of them) with each error in our words. */
export function withHostErrors(answer){
 if(!answer||typeof answer!=='object')return answer;
 const one=h=>h&&typeof h==='object'&&'error' in h?{...h,error:hostError(h)}:h;
 return Array.isArray(answer.items)?{...answer,items:answer.items.map(one)}:one(answer);
}
function checkArgument(key,schema,value){
 const bad=()=>{throw Error(`Invalid argument ${key}`)};
 // A scalar of one of several types (an SQL param): a finite number, a string, a boolean or null.
 if(Array.isArray(schema.type)){const type=value===null?'null':typeof value;if(!schema.type.includes(type)||(type==='number'&&!Number.isFinite(value)))bad()}
 else if(schema.type==='string'){if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity))bad();if(schema.enum&&!schema.enum.includes(value))bad();if(schema.pattern&&!new RegExp(schema.pattern).test(value))bad()}
 else if(schema.type==='boolean'){if(typeof value!=='boolean')bad()}
 else if(schema.type==='integer'){if(!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))bad();if(schema.enum&&!schema.enum.includes(value))bad()}
 // At most maxItems, each item checked against `items` when the schema names it (publicPaths), else
 // a scalar (SQL params).
 else if(schema.type==='array'){if(!Array.isArray(value)||value.length>(schema.maxItems??Infinity))bad();if(schema.items)for(const item of value)checkArgument(key,schema.items,item);else if(!value.every(item=>item===null||typeof item==='string'||typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item))))bad()}
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
 const route=/^\/v1\/platform\/(projects|usage|workspaces)$/.test(url.pathname)||new RegExp(`^/v1/platform/operations/${id}$`).test(url.pathname)||new RegExp(`^/v1/platform/projects/${id}/products$`).test(url.pathname)||new RegExp(`^/v1/platform/projects/${id}/environments/${id}/identity/origins$`).test(url.pathname)||new RegExp(`^/v1/platform/workspaces/${id}/billing$`).test(url.pathname)||new RegExp(`^/v1/deploy/(services|domains|domains/${id}|deployments/${id}|logs/trace/${id})$`).test(url.pathname);
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
 constructor({token,version='0.0.0',origin='https://api.mdrn.io',fetcher=globalThis.fetch,scopes,rethrowUnauthorized=false,sleep=(ms)=>new Promise(r=>setTimeout(r,ms))}){
  // The token is a bearer credential: https only, except a development server on this machine.
  const url=new URL(origin),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw Error('MDRN_API_ORIGIN must be an https origin');
  this.sleep=sleep;this.token=token;this.version=version;this.origin=origin.replace(/\/$/,'');this.fetcher=fetcher;this.scopes=scopes;this.rethrowUnauthorized=rethrowUnauthorized;
  // Where the next steps send a person: the console of this API origin.
  this.console=consoleOrigin(this.origin);
  // Every bearer a tool call has sent, redacted from its answer.
  this.seen=new Set();}
 // The bearer to send: the string as it is, or what the getter answers (force: renewed).
 async bearer(force=false){
  const held=this.token;
  const value=typeof held==='string'?held:held?await(force?held.refresh():held.get()):undefined;
  if(value)this.seen.add(value);
  return value;
 }
 // ndjson: the answer is NDJSON (the users export), read as {items, nextCursor}, the cursor from
 // its MDRN-Next-Cursor header.
 async request(method,path,{projectId,environmentId,body,idempotencyKey,ifMatch,ndjson=false,withEtag=false}={}){
  if(!this.token)throw Error('MDRN_API_TOKEN is not configured');
  const bearer=await this.bearer();if(!bearer)throw Error('MDRN_API_TOKEN is not configured');
  const send=(value)=>{
   const headers=new Headers({Accept:ndjson?'application/x-ndjson':'application/json',Authorization:`Bearer ${value}`});if(projectId)headers.set('MDRN-Project',projectId);if(environmentId)headers.set('MDRN-Environment',environmentId);
   if(body!==undefined)headers.set('Content-Type','application/json');if(idempotencyKey)headers.set('Idempotency-Key',idempotencyKey);if(ifMatch!==undefined)headers.set('If-Match',String(ifMatch));
   return this.fetcher(this.origin+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(10_000)});
  };
  let response=await send(bearer);
  // A getter's bearer the API refused is renewed once, and the request sent again only when the
  // renewal gave another token; a string token is what it is.
  if(response.status===401&&typeof this.token!=='string'){const renewed=await this.bearer(true);if(renewed&&renewed!==bearer){await response.text().catch(()=>{});response=await send(renewed)}}
  const raw=await response.text();
  // A page whose last line has no newline was cut short on its way.
  if(ndjson&&response.ok){if(raw&&!raw.endsWith('\n'))throw Error('The export was cut short. Call it again.');try{return{items:raw.split('\n').filter(Boolean).map(line=>JSON.parse(line)),nextCursor:response.headers.get('MDRN-Next-Cursor')}}catch{throw Error('Invalid NDJSON API response')}}
  let parsed;try{parsed=raw?JSON.parse(raw):null}catch{throw Error('Invalid JSON API response')}
  if(!response.ok){const e=parsed?.error??{};const message=`${e.code??`HTTP_${response.status}`}: ${e.message??response.statusText}`;throw Object.assign(response.status===401?new ApiUnauthorized(message):Error(message),{code:typeof e.code==='string'?e.code:undefined})}
  // A read whose answer is changed under If-Match (the Auth settings) keeps its ETag.
  return withEtag?{body:parsed,etag:response.headers.get('ETag')}:parsed;
 }
 async api(path,projectId,environmentId){
  safePath(path);if(!this.token)throw Error('MDRN_API_TOKEN is not configured');
  if(path.startsWith('/v1/deploy/')&&(!projectId||!environmentId))throw Error('Deploy inspection requires projectId and environmentId');
  return this.request('GET',path,{projectId,environmentId});
 }
 // A tool's answer, with nextSteps added for the main flows (nextSteps above).
 async call(name,input={}){
  const result=await this.answer(name,input);
  const steps=nextSteps(name,input,result,this.console);
  return steps?{...result,nextSteps:steps}:result;
 }
 // The last TAIL_LINES lines of a build's or deployment's log, read page by page from the start
 // (at most 20 pages); null when the log cannot be read, so the answer still comes back.
 async logTail(path,scope,line){
  const lines=[];
  try{
   let cursor='0';
   for(let pages=0;pages<20;pages++){
    const page=await this.request('GET',`${path}${query({cursor})}`,scope);
    for(const item of page?.items??[])lines.push(line(item));
    if(!page?.items?.length||page.nextCursor===undefined||page.nextCursor===null||String(page.nextCursor)===cursor)break;
    cursor=String(page.nextCursor);
   }
  }catch(e){if(e instanceof ApiUnauthorized&&this.rethrowUnauthorized)throw e;return null}
  return lines.slice(-TAIL_LINES);
 }
 async answer(name,input={}){
  const definition=TOOLS.find(t=>t.name===name);if(!definition)throw Error('Unknown tool');
  const properties=definition.inputSchema.properties;
  if(PRODUCT_TOOLS.includes(name)&&input&&typeof input==='object'&&'environmentId' in input)throw Error('Products belong to the project, in Sandbox and Production at once: leave out environmentId');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!(k in properties)))throw Error('Invalid tool arguments');
  for(const key of definition.inputSchema.required)if(properties[key].type==='string'&&!properties[key].enum&&!properties[key].pattern)segment(input[key]);else if(input[key]===undefined)throw Error('Required identifier is missing');
  if(input.environmentId!==undefined&&!['sandbox','production'].includes(input.environmentId))throw Error('environmentId must be sandbox or production');
  for(const [key,value]of Object.entries(input))if(value!==undefined)checkArgument(key,properties[key],value);
  const needed=SCOPE.get(name),scope=typeof needed==='function'?needed(input):needed;
  if(this.scopes&&scope&&!this.scopes.includes(scope))throw Error(`insufficient_scope: this connection was not allowed ${SCOPE_WORDS[scope]??scope}. Ask the person to connect MDRN again and allow it.`);
  // Read only in Production unless the person ticked it when connecting: a change there (or to a
  // product, which changes both environments) needs production:write as well.
  // Where: an environment the person left unticked is out of reach, and a product change needs both.
  const limited=this.scopes&&Object.values(ENVIRONMENT_ACCESS).some(scope=>this.scopes.includes(scope));
  const out=limited?(PRODUCT_TOOLS.includes(name)&&WRITES.has(name)?Object.keys(ENVIRONMENT_ACCESS):input.environmentId?[input.environmentId]:[]).find(kind=>!this.scopes.includes(ENVIRONMENT_ACCESS[kind])):undefined;
  if(out)throw Error(`insufficient_scope: this connection may not use ${ENVIRONMENT_WORDS[out]}. Ask the person to connect MDRN again and tick ${ENVIRONMENT_WORDS[out]}.`);
  if(this.scopes&&WRITES.has(name)&&(input.environmentId==='production'||PRODUCT_TOOLS.includes(name))&&!this.scopes.includes(PRODUCTION_WRITE))throw Error(`insufficient_scope: this connection may only read Production. Ask the person to connect MDRN again and allow changes in Production.`);
  const base=()=>`/v1/platform/projects/${segment(input.projectId)}/environments/${segment(input.environmentId)}`;
  const deploy={projectId:input.projectId,environmentId:input.environmentId};
  const write={...deploy,idempotencyKey:input.idempotencyKey??globalThis.crypto.randomUUID()};
  const service=()=>`/v1/deploy/services/${segment(input.deploymentId)}`;
  const products=()=>`/v1/platform/projects/${segment(input.projectId)}/products`;
  const dbBase=()=>`/v1/${input.database}`;
  // A tool only one database has, asked of the other, is refused before any request.
  const only=(which,why)=>{if(input.database!==which)throw Error(`${why}: call it with database ${which}`)};
  switch(name){
   case'mdrn_list_workspaces':return this.api(`/v1/platform/workspaces${query({cursor:input.cursor})}`);
   case'mdrn_list_projects':return this.api(`/v1/platform/projects?workspaceId=${segment(input.workspaceId)}`);
   case'mdrn_create_project':return this.request('POST','/v1/platform/projects',{idempotencyKey:write.idempotencyKey,body:{workspaceId:input.workspaceId,name:input.name}});
   case'mdrn_list_products':return this.api(products());
   case'mdrn_get_operation':return this.api(`/v1/platform/operations/${segment(input.operationId)}`);
   case'mdrn_get_billing':return this.api(`/v1/platform/workspaces/${segment(input.workspaceId)}/billing`);
   case'mdrn_get_usage':return this.api(`/v1/platform/usage?workspaceId=${segment(input.workspaceId)}${input.periodId?`&periodId=${segment(input.periodId)}`:''}`);
   case'mdrn_list_deployments':return this.api('/v1/deploy/services',input.projectId,input.environmentId);
   case'mdrn_list_domains':return withHostErrors(await this.api('/v1/deploy/domains',input.projectId,input.environmentId));
   case'mdrn_get_rollout':{
    // A failed rollout carries the end of its own log (logTail), with the step that failed.
    const rollout=await this.api(`/v1/deploy/deployments/${segment(input.rolloutId)}`,input.projectId,input.environmentId);
    if(rollout?.state!=='failed')return rollout;
    return{...rollout,logTail:await this.logTail(`/v1/deploy/deployments/${segment(input.rolloutId)}/logs`,deploy,item=>`[${item.stage??'-'}] ${item.message??''}`)};
   }
   case'mdrn_open_app':{
    // A link Platform makes for the deployment's generated hostname: in build mode the app serves
    // its owner only, and opening the link signs that browser in to it.
    const {hostname}=await this.request('GET',service(),deploy)??{};
    if(!hostname)throw Error('NO_ADDRESS: this deployment has no address yet. Deploy it first with the MDRN CLI.');
    const grant=await this.request('POST',`${base()}/preview-grants`,{body:{hostname}});
    const note=grant?.ownerOnly?'The app is in build mode and only the person can open it. The link works for 15 minutes; the browser that opens it stays signed in to the app for 8 hours.':`The app is public: https://${hostname} opens it too. The link works for 15 minutes.`;
    return{...grant,hostname,note};
   }
   case'mdrn_read_api':{
    const answer=await this.api(input.path,input.projectId,input.environmentId);
    return /^\/v1\/deploy\/domains(\/|$)/.test(new URL(input.path,'https://api.invalid').pathname)?withHostErrors(answer):answer;
   }
   case'mdrn_list_builds':return this.request('GET',`/v1/deploy/builds${query({serviceId:input.deploymentId,cursor:input.cursor})}`,deploy);
   case'mdrn_get_build':{
    // A failed build carries the end of its own output (logTail): the app's error as it printed it.
    const build=await this.request('GET',`/v1/deploy/builds/${segment(input.buildId)}`,deploy);
    if(build?.state!=='failed')return build;
    return{...build,logTail:await this.logTail(`/v1/deploy/builds/${segment(input.buildId)}/logs`,deploy,item=>String(item.message??''))};
   }
   case'mdrn_get_build_logs':return this.request('GET',`/v1/deploy/builds/${segment(input.buildId)}/logs${query({cursor:input.cursor})}`,deploy);
   case'mdrn_search_logs':return this.request('GET',`/v1/deploy/logs${query({from:input.from,to:input.to,q:input.q,level:input.level,service:input.deploymentId,cursor:input.cursor})}`,deploy);
   case'mdrn_get_request_logs':return this.api(`/v1/deploy/logs/trace/${segment(input.traceId)}${query({from:input.from,to:input.to})}`,input.projectId,input.environmentId);
   case'mdrn_deploy_from_github':{
    // Connecting again with what is connected builds the branch's head (deploy-worker github.rs, connect).
    const connection=await this.request('GET',`${service()}/github`,deploy);
    if(!connection?.installationId||!connection?.repositoryId)throw Error('NOT_CONNECTED: this deployment has no connected repository. Deploy from this computer with the MDRN CLI (`npx @mdrnio/cli deploy`), or connect a repository in the console.');
    if(!connection.autoDeploy)throw Error('MANUAL: this deployment builds only from uploads, not from its connected branch. Deploy with the MDRN CLI, or turn on automatic deploys in the console.');
    const started=await this.request('PUT',`${service()}/github`,{...write,body:{installationId:String(connection.installationId),repositoryId:String(connection.repositoryId),branch:connection.branch,autoDeploy:true}});
    return{...started,building:true};
   }
   case'mdrn_deploy_example':return this.request('POST','/v1/deploy/builds',{...write,body:{serviceId:input.deploymentId,example:input.example}});
   case'mdrn_roll_back':return this.request('POST','/v1/deploy/deployments',{...write,body:{serviceId:input.deploymentId,artifactId:input.artifactId}});
   case'mdrn_enable_product':return this.request('POST',`${products()}/${segment(input.product)}/enable`,{idempotencyKey:write.idempotencyKey,body:{}});
   case'mdrn_disable_product':return this.request('POST',`${products()}/${segment(input.product)}/disable`,{idempotencyKey:write.idempotencyKey,body:{}});
   case'mdrn_list_variables':{
    // Deploy never answers a secret's value (deploy-worker variables.rs, list); a value on any
    // variable not marked plain is dropped here too, so this tool cannot hand a secret back.
    const answer=await this.request('GET',`${service()}/variables`,deploy);
    const plain=v=>v.secret===false||v.secret===0;
    const item=v=>{if(!v||typeof v!=='object'||plain(v))return v;const{value:_,...rest}=v;return rest};
    return answer&&Array.isArray(answer.items)?{...answer,items:answer.items.map(item)}:answer;
   }
   case'mdrn_set_variable':return this.request('PUT',`${service()}/variables/${segment(input.name)}`,{...write,body:{value:input.value,...(input.secret!==undefined?{secret:input.secret}:{}),...(input.build!==undefined?{build:input.build}:{})}});
   case'mdrn_unset_variable':return this.request('DELETE',`${service()}/variables/${segment(input.name)}`,write);
   case'mdrn_clear_build_cache':return this.request('DELETE',`${service()}/build-cache`,write);
   case'mdrn_create_deployment':return this.request('POST','/v1/deploy/services',{...write,body:{name:input.name}});
   // The databases' management API, /v1/sqlite or /v1/postgres: the project and environment go
   // as MDRN-Project and MDRN-Environment, and every change with an Idempotency-Key.
   case'mdrn_get_database_config':return this.request('GET',`${dbBase()}/configuration`,deploy);
   case'mdrn_list_collections':return this.request('GET',`${dbBase()}/collections`,deploy);
   case'mdrn_list_records':return this.request('GET',`${dbBase()}/collections/${segment(input.collection)}/records${query({limit:input.limit,cursor:input.cursor})}`,deploy);
   case'mdrn_get_record':return this.request('GET',`${dbBase()}/collections/${segment(input.collection)}/records/${segment(input.recordId)}`,deploy);
   case'mdrn_list_database_backups':only('sqlite','Snapshots are SQLite\'s; Postgres restores to a moment in its restore history (mdrn_get_database_config shows the window)');return this.request('GET','/v1/sqlite/backups',deploy);
   case'mdrn_get_database_operation':return this.request('GET',`${dbBase()}/operations/${segment(input.operationId)}`,deploy);
   case'mdrn_set_database_restore_history':only('postgres','Restore history is Postgres\'s; SQLite keeps 30 days always');return this.request('PATCH','/v1/postgres/configuration',{...write,body:{restoreHistoryDays:input.restoreHistoryDays}});
   case'mdrn_run_sql':{
    // MDRN's own tables (and the provider's) are neither queried nor shown here. This is the
    // tool's own courtesy, not a guarantee: Database itself lets a SELECT read them and refuses
    // only a change (database core sql.rs).
    if(internalTable(input.sql))throw Error('INTERNAL_TABLE: tables named _mdrn_ or _cf_ are MDRN\'s own: hidden from listings and cannot be changed, and this tool does not run a statement that names them. Read the app\'s records with mdrn_list_records instead.');
    return hideInternal(await this.request('POST',`${dbBase()}/sql`,{...write,body:{sql:input.sql,...(input.params!==undefined?{params:input.params}:{})}}));
   }
   case'mdrn_database_connection':{
    only('postgres','The connection string is Postgres\'s');
    if(input.action==='stop_previous'&&input.redeploy!==undefined)throw Error('redeploy does not apply to stop_previous, which redeploys nothing');
    const [method,path]={on:['POST','/v1/postgres/connection'],rotate:['POST','/v1/postgres/connection/rotate'],off:['DELETE','/v1/postgres/connection'],stop_previous:['DELETE','/v1/postgres/connection/previous']}[input.action];
    const answer=await this.request(method,path,{...write,...(input.action==='stop_previous'?{}:{body:input.redeploy===false?{redeploy:false}:{}})});
    if(input.action==='stop_previous')return{...answer,note:'The previous string is stopped.'};
    return answer?.connectionString?{...answer,note:DATABASE_CONNECTION_USE}:answer;
   }
   case'mdrn_restore_database':{
    // Exactly one target, and the person's go-ahead; the revision read now is what the restore checks.
    if((input.timestamp===undefined)===(input.backupId===undefined))throw Error('Pass either timestamp or backupId, not both');
    if(input.backupId!==undefined)only('sqlite','Snapshots are SQLite\'s; restore Postgres to a timestamp in its restore history');
    if(input.confirmOverwrite!==true)throw Error('A restore replaces the database in use: ask the person, then call again with confirmOverwrite true');
    if(input.timestamp!==undefined&&!Number.isFinite(Date.parse(input.timestamp)))throw Error('Invalid argument timestamp');
    const configuration=await this.request('GET',`${dbBase()}/configuration`,deploy);
    if(!Number.isSafeInteger(configuration?.revision))throw Error(`MDRN answered the ${DATABASE_NAMES[input.database]} configuration without its revision; nothing was restored`);
    return this.request('POST',`${dbBase()}/restores`,{...write,ifMatch:configuration.revision,body:{...(input.timestamp!==undefined?{timestamp:new Date(Date.parse(input.timestamp)).toISOString()}:{backupId:input.backupId}),confirmOverwrite:true}});
   }
   // Objects, through the Platform's relay to Storage, as the console uses it.
   case'mdrn_list_objects':return this.request('GET',`${base()}/objects${query({limit:input.limit,cursor:input.cursor})}`);
   case'mdrn_get_object_link':{
    const grant=await this.request('POST',`${base()}/objects/${segment(input.objectId)}/download-grants`,{idempotencyKey:write.idempotencyKey,body:{}});
    return{...grant,note:'The link works for a short time; keep it out of anything shared.'};
   }
   case'mdrn_delete_object':return this.request('DELETE',`${base()}/objects/${segment(input.objectId)}`,{idempotencyKey:write.idempotencyKey});
   case'mdrn_upload_object':return this.upload(base(),input,write.idempotencyKey);
   // Mail: what was sent (the Platform's relay), and one test message through the app's own Mail API.
   case'mdrn_list_mail_messages':return this.request('GET',`${base()}/mail/messages${query({status:input.status,cursor:input.cursor})}`);
   case'mdrn_get_mail_message':return this.request('GET',`${base()}/mail/messages/${segment(input.messageId)}`);
   case'mdrn_send_test_email':return this.request('POST','/v1/mail/messages',{...write,body:{recipient:input.to,subject:'A test email from MDRN',text:'This is a test email sent by an AI assistant through MDRN. If you can read it, your app can send mail.'}});
   // Auth: the environment's settings, with one row per deployment, and its users.
   case'mdrn_get_auth_settings':{
    const [settings,deployments]=await Promise.all([this.request('GET',`${base()}/auth/configuration`),this.request('GET','/v1/deploy/services',deploy)]);
    const policies=new Map((settings?.routePolicies??[]).map(p=>[p.serviceId,p]));
    return{
     deployments:(deployments?.items??[]).map(d=>{const p=policies.get(d.id);return{deploymentId:d.id,name:d.name,hostname:d.hostname??null,signIn:!p?'off':p.mode==='require_sign_in'?'everyone':'app_decides',publicPaths:p?.mode==='require_sign_in'?p.publicPaths??[]:[]}}),
     accountPage:{enabled:settings?.settingsUi?.enabled??false,path:settings?.settingsUi?.path??null},
     loginPath:settings?.loginPath??null,sessionLimits:settings?.sessionLimits??null,
     // Absent is off for an app (Identity second_factor.rs).
     secondFactor:settings?.secondFactor??'off',
    };
   }
   case'mdrn_set_sign_in':return this.setSignIn(base(),input,write.idempotencyKey,deploy);
   case'mdrn_list_auth_users':return this.request('GET',`${base()}/auth/users${query({email:input.email,cursor:input.cursor})}`);
   case'mdrn_export_auth_users':return this.request('GET',`${base()}/auth/users/export${query({cursor:input.cursor,limit:input.limit??100})}`,{ndjson:true});
   case'mdrn_list_owned_domains':return this.ownedDomains(base(),deploy);
   case'mdrn_set_mail_address':{
    // Mail's rule for the part before the @ (shared/sender_local.rs); the pattern holds the rest.
    const at=input.address.indexOf('@'),local=input.address.slice(0,at),domain=input.address.slice(at+1).toLowerCase();
    if(local.includes('..'))throw Error('Invalid argument address: the part before the @ never has two dots in a row');
    const senders=await this.request('GET',`${base()}/mail/senders`);
    const sender=(senders?.items??[]).find(s=>s.domain===domain&&s.state!=='disabled');
    if(!sender)throw Error(`NO_MAIL_SENDER: ${domain} sends no mail yet. Ask the person to add it as a mail host under its domain in the console (Domains), then choose its address.`);
    return this.request('PATCH',`${base()}/mail/senders/${segment(sender.id)}`,{idempotencyKey:write.idempotencyKey,body:{local}});
   }
  }
 }
 // The environment's own domains, each with what answers under it, joined as the console and
 // `mdrn domains` join them (cli/src/domains.js): the hosts Deploy filed under it, or filed under
 // none but under its name, and the Mail senders on it or below it. The deployments' names and
 // the senders are read on the side: either failing leaves the domains answered, and Mail that
 // cannot be read (or that this connection may not read) is said in mailRead.
 async ownedDomains(base,deploy){
  const aside=(promise)=>promise.catch(e=>{if(e instanceof ApiUnauthorized&&this.rethrowUnauthorized)throw e;return null});
  const mailAllowed=!this.scopes||this.scopes.includes('mail:read');
  const [owned,hosts,services,senders]=await Promise.all([
   this.request('GET','/v1/deploy/owned-domains',deploy),
   this.request('GET','/v1/deploy/domains',deploy),
   aside(this.request('GET','/v1/deploy/services',deploy)),
   mailAllowed?aside(this.request('GET',`${base}/mail/senders`)):null,
  ]);
  const under=(host,domain)=>typeof host==='string'&&(host===domain||host.endsWith(`.${domain}`));
  const names=new Map((services?.items??[]).map(s=>[s.id,s.name]));
  const mailRead=Array.isArray(senders?.items);
  const items=(owned?.items??[]).map(d=>({
   id:d.id,name:d.name,state:d.state,verifiedAt:d.verifiedAt??null,records:d.records??[],
   uses:[
    ...(hosts?.items??[]).filter(h=>h.ownedDomainId===d.id||(!h.ownedDomainId&&under(h.hostname,d.name))).map(h=>h.use==='downloads'
     ?{use:'downloads',id:h.id,hostname:h.hostname,state:h.state}
     :{use:'deployment',id:h.id,hostname:h.hostname,deploymentId:h.serviceId??null,deployment:(h.serviceId&&names.get(h.serviceId))||null,state:h.state}),
    ...(senders?.items??[]).filter(s=>s.state!=='disabled'&&under(s.domain,d.name)).map(s=>({use:'mail',id:s.id,address:typeof s.address==='string'&&s.address?s.address:`noreply@${s.domain}`,domain:s.domain,state:s.state})),
   ],
  }));
  return{items,mailRead,...(mailRead?{}:{mailNote:mailAllowed?'Mail could not be read just now, so the mail senders are missing. Call this again in a moment.':'This connection was not allowed to read mail, so the mail senders are missing.'})};
 }
 // A file up as an object: create the upload, wait for it to open (a part asked for before is
 // refused), send each part to its own grant (never with the bearer), complete. Anything failing
 // before completion aborts the upload.
 async upload(base,input,key){
  if((input.text===undefined)===(input.base64===undefined))throw Error('Pass the content as text or as base64, not both');
  let bytes;
  if(input.text!==undefined)bytes=new TextEncoder().encode(input.text);
  else{if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))throw Error('Invalid argument base64');try{bytes=Uint8Array.from(atob(input.base64),c=>c.charCodeAt(0))}catch{throw Error('Invalid argument base64')}}
  if(bytes.length>UPLOAD_LIMIT)throw Error(`The file is larger than ${UPLOAD_LIMIT/1024/1024} MiB: upload it with the CLI (npx @mdrnio/cli objects upload <file>)`);
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const contentType=input.contentType??(input.text!==undefined?'text/plain; charset=utf-8':'application/octet-stream');
  let upload=await this.request('POST',`${base}/objects/uploads`,{idempotencyKey:key,body:{filename:input.filename,contentType,bytes:bytes.length,sha256}});
  let completed=false;
  try{
   for(let attempt=0;upload?.state!=='uploading';attempt++){
    if(['aborted','expired','rejected','complete'].includes(upload?.state)||attempt>=20)throw Error('The upload did not open. Call the tool again.');
    await this.sleep(Math.min(1000,200*2**attempt));
    upload=await this.request('GET',`${base}/objects/uploads/${segment(upload.id)}`);
   }
   const parts=[];
   for(let offset=0,partNumber=1;offset<bytes.length;offset+=upload.partBytes,partNumber++){
    const slice=bytes.subarray(offset,Math.min(bytes.length,offset+upload.partBytes));
    const grant=await this.request('POST',`${base}/objects/uploads/${segment(upload.id)}/parts`,{body:{partNumber,bytes:slice.length}});
    let url;try{url=new URL(grant?.url)}catch{}
    if(!url||url.protocol!=='https:')throw Error('MDRN answered without a usable upload link');
    const response=await this.fetcher(url.href,{method:grant.method||'PUT',headers:grant.headers??{},body:slice,redirect:'manual',signal:AbortSignal.timeout(30_000)});
    const answer=await response.json().catch(()=>null);
    if(!response.ok||!answer?.etag)throw Error(`Part ${partNumber} could not be sent. Call the tool again.`);
    parts.push({partNumber,etag:answer.etag});
   }
   const done=await this.request('POST',`${base}/objects/uploads/${segment(upload.id)}/complete`,{body:{parts}});
   completed=true;
   return{id:done?.id||upload.objectId,filename:input.filename,bytes:bytes.length,sha256,state:done?.state??'verifying',note:'Stored; Objects checks it against its SHA-256 before it can be downloaded.'};
  }catch(e){
   if(!completed&&upload?.id)await this.request('DELETE',`${base}/objects/uploads/${segment(upload.id)}`).catch(()=>{});
   throw e;
  }
 }
 // Who must sign in to one deployment: sign-in served at its address (an activation), then its
 // route policy in the Auth settings, saved under If-Match so a change made meanwhile is kept.
 async setSignIn(base,input,key,deploy){
  if(input.mode!=='everyone'&&input.publicPaths!==undefined)throw Error('publicPaths apply to mode everyone only');
  const target=await this.request('GET',`/v1/deploy/services/${segment(input.deploymentId)}`,deploy);
  if(input.mode!=='off'){
   if(!target?.hostname)throw Error('NO_ADDRESS: this deployment has no address yet. Deploy it first with the MDRN CLI.');
   await this.request('POST','/v1/platform/identity/activations',{idempotencyKey:`${key.slice(0,100)}-on`,body:{origin:`https://${target.hostname}`,projectId:input.projectId,environmentId:input.environmentId}});
  }
  const {body:settings,etag}=await this.request('GET',`${base}/auth/configuration`,{withEtag:true});
  if(!etag)throw Error('MDRN answered the Auth settings without their version; nothing was changed. Call the tool again.');
  const others=(settings?.routePolicies??[]).filter(p=>p.serviceId!==input.deploymentId);
  const before=(settings?.routePolicies??[]).find(p=>p.serviceId===input.deploymentId);
  const policy=input.mode==='everyone'?{serviceId:input.deploymentId,mode:'require_sign_in',publicPaths:input.publicPaths??(before?.mode==='require_sign_in'?before.publicPaths??[]:[])}:input.mode==='app_decides'?{serviceId:input.deploymentId,mode:'mixed'}:null;
  await this.request('PATCH',`${base}/auth/configuration`,{idempotencyKey:key,ifMatch:etag,body:{routePolicies:policy?[...others,policy]:others}});
  return{deploymentId:input.deploymentId,signIn:input.mode,publicPaths:policy?.publicPaths??[]};
 }
 async handle(message){
  if(message.method==='initialize')return{jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mdrn',version:this.version},instructions:INSTRUCTIONS}};
  if(message.method==='ping')return{jsonrpc:'2.0',id:message.id,result:{}};
  if(message.method==='tools/list')return{jsonrpc:'2.0',id:message.id,result:{tools:TOOLS}};
  if(message.method==='tools/call'){
   // The bearers this call sends (a string token, or what the getter answered, renewed or not) are redacted from its answer.
   this.seen=new Set(typeof this.token==='string'?[this.token]:[]);
   let result,isError=false;try{result=await this.call(message.params?.name,message.params?.arguments)}catch(e){if(e instanceof ApiUnauthorized&&this.rethrowUnauthorized)throw e;result=e instanceof Error?e.message:String(e);isError=true;
    // A refusal with a code ends with what to do next: the plan when billing refused it, and the docs.
    const steps=errorSteps(e?.code,this.console);for(const s of steps)result+=`\nNext: ${s.step}: ${s.url}`}
   let text=typeof result==='string'?result:JSON.stringify(result,null,2);for(const bearer of this.seen)text=text.replaceAll(bearer,'[REDACTED]');
   return{jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text}],isError}}}
  if(message.method?.startsWith('notifications/'))return null;
  return{jsonrpc:'2.0',id:message.id??null,error:{code:-32601,message:'Method not found'}};
 }
}
