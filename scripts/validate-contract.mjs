import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const spec=JSON.parse(readFileSync(new URL('../contracts/client.openapi.json',import.meta.url)));
const resolve=ref=>ref.slice(2).split('/').reduce((x,key)=>x?.[key],spec);
const scan=x=>{if(!x||typeof x!=='object')return;for(const [key,value]of Object.entries(x)){if(key==='$ref')assert.ok(resolve(value),`Unresolved ${value}`);else scan(value)}};scan(spec);
// A security requirement names a scheme of components.securitySchemes, or a client generator fails on it and Swagger UI shows no padlock.
const schemes=new Set(Object.keys(spec.components.securitySchemes??{}));
for(const [path,item]of Object.entries(spec.paths))for(const [method,op]of Object.entries(item))for(const requirement of op?.security??[])for(const scheme of Object.keys(requirement))assert.ok(schemes.has(scheme),`${method.toUpperCase()} ${path} requires the undeclared security scheme ${scheme}`);
const name=spec.info.title;if(name.includes('sdk')){for(const engine of ['sqlite','postgres']){const item=spec.paths[`/_mdrn/v1/${engine}/collections/{collection}/records/{recordId}`];assert.ok(item.patch);assert.equal(item.put,undefined)}assert.equal(spec.paths['/v1/objects/data'],undefined)}
// MCP writes are bounded: no product delete or restore, no domain change, no deleting a
// database's data; the PATCHes set restore history, the sign-in configuration and a mail sender's
// address, and the DELETEs unset a service variable, turn the Postgres connection string (or its
// previous one) off, delete a stored file (restorable until purged) or drop an unfinished upload.
// The database writes and the file delete are annotated destructive in src/server.js (owner
// decision 2026-10-24).
if(name.includes('mcp')){assert.ok(spec.paths['/v1/platform/operations/{operationId}']);for(const engine of ['sqlite','postgres','database'])assert.equal(spec.paths[`/v1/${engine}/data`],undefined);for(const [path,item] of Object.entries(spec.paths)){if(item.patch)assert.ok(['/v1/postgres/configuration','/v1/platform/projects/{projectId}/environments/{environmentId}/auth/configuration','/v1/platform/projects/{projectId}/environments/{environmentId}/mail/senders/{senderId}'].includes(path),path);if(item.delete)assert.ok(['/v1/deploy/services/{serviceId}/variables/{name}','/v1/postgres/connection','/v1/postgres/connection/previous','/v1/platform/projects/{projectId}/environments/{environmentId}/objects/{objectId}','/v1/platform/projects/{projectId}/environments/{environmentId}/objects/uploads/{uploadId}'].includes(path),path);assert.ok(!/\/(delete|restore)$/.test(path),path);if(path.startsWith('/v1/deploy/domains'))for(const method of ['post','put','delete'])assert.equal(item[method],undefined,path)}}
console.log('Contract references and client operation bounds verified');
