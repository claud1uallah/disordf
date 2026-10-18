import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuration,createRelay}from './server.mjs';
const secret='test-secret-'.repeat(5),webhook='https://discord.com/api/webhooks/123/test_token';
test('configuration rejects arbitrary destinations',()=>{assert.throws(()=>configuration({RELAY_SECRET:secret,DISCORD_WEBHOOKS_JSON:'{"connect":"https://example.com/"}'}));});
test('authentication, allowlist, confirmed delivery, mentions and deduplication',async()=>{
 let calls=0,body;const server=createRelay(configuration({RELAY_SECRET:secret,DISCORD_WEBHOOKS_JSON:JSON.stringify({connect:webhook})}),{fetcher:async(url,options)=>{assert.equal(url,webhook);calls++;body=JSON.parse(options.body);return new Response(null,{status:204});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/health')).status,200);
  assert.equal((await fetch(base+'/relay',{method:'POST',body:'{}'})).status,401);
  const post=row=>fetch(base+'/relay',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(row)});
  assert.equal((await post({route:'unknown',payload:{content:'test'}})).status,400);
  const row={route:'connect',id:'event-1',payload:{content:'test',allowed_mentions:{parse:['everyone']}}};
  assert.equal((await post(row)).status,200);assert.deepEqual(body.allowed_mentions,{parse:[]});
  assert.equal((await post(row)).status,200);assert.equal(calls,1);
 }finally{await new Promise(r=>server.close(r));}
});
test('rate limit respected without issuing another Discord request',async()=>{
 let calls=0;const server=createRelay(configuration({RELAY_SECRET:secret,DISCORD_WEBHOOKS_JSON:JSON.stringify({connect:webhook})}),{fetcher:async()=>{calls++;return Response.json({retry_after:1337,global:true},{status:429});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{for(let i=0;i<2;i++){const response=await fetch(base+'/relay',{method:'POST',headers:{authorization:'Bearer '+secret},body:JSON.stringify({route:'123',payload:{content:'test'}})});assert.equal(response.status,429);assert((await response.json()).retry_after>=1338);}assert.equal(calls,1);}finally{await new Promise(r=>server.close(r));}
});

test('only the explicitly approved sanctions destination can be supplied',async()=>{
 let received;const server=createRelay(configuration({RELAY_SECRET:secret,DISCORD_WEBHOOKS_JSON:JSON.stringify({connect:webhook})}),{fetcher:async(url)=>{received=url;return new Response(null,{status:204});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const post=destination=>fetch(base+'/relay',{method:'POST',headers:{authorization:'Bearer '+secret},body:JSON.stringify({route:'1561465296584179864',destination,payload:{content:'test'}})});
  assert.equal((await post('https://example.com/')).status,400);
  assert.equal((await post('https://discord.com/api/webhooks/999/wrong')).status,400);
  assert.equal((await post('https://discord.com/api/webhooks/1561465296584179864/test_token')).status,200);
  assert.equal(received,'https://discord.com/api/webhooks/1561465296584179864/test_token');
 }finally{await new Promise(r=>server.close(r));}
});

test('status creates once then edits the persisted message',async()=>{
 const requests=[];const server=createRelay(configuration({RELAY_SECRET:secret,DISCORD_WEBHOOKS_JSON:JSON.stringify({connect:webhook})}),{fetcher:async(url,options)=>{requests.push({url,method:options.method});return Response.json({id:'123456789012345678'},{status:200});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
 const row={route:'1434184566284882012',destination:'https://discord.com/api/webhooks/1434184566284882012/test_token',operation:'status',payload:{embeds:[{title:'Storm Status'}]}};
 const post=()=>fetch(base+'/relay',{method:'POST',headers:{authorization:'Bearer '+secret},body:JSON.stringify(row)});
 let response=await post();assert.equal(response.status,200);row.message_id=(await response.json()).message_id;assert.equal(row.message_id,'123456789012345678');
 response=await post();assert.equal(response.status,200);assert.equal(requests[0].method,'POST');assert(requests[0].url.endsWith('?wait=true'));assert.equal(requests[1].method,'PATCH');assert(requests[1].url.endsWith('/messages/'+row.message_id));
 }finally{await new Promise(r=>server.close(r));}
});
