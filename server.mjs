import http from 'node:http';
import {timingSafeEqual,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function configuration(env=process.env){
  if(typeof env.RELAY_SECRET!=='string'||env.RELAY_SECRET.length<32)throw Error('RELAY_SECRET must have at least 32 characters');
  const channels=JSON.parse(env.DISCORD_WEBHOOKS_JSON||'{}');
  if(!Object.keys(channels).length)throw Error('DISCORD_WEBHOOKS_JSON must configure at least one channel');
  const routes=new Map();
  for(const [channel,value]of Object.entries(channels)){
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='discord.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))throw Error('Invalid webhook configuration for '+channel);
    routes.set(channel,url.href);routes.set(url.pathname.split('/')[3],url.href);
  }
  return {secret:env.RELAY_SECRET,routes};
}
const digest=s=>createHash('sha256').update(s).digest();
const numeric=v=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):0;
export function createRelay(config,{fetcher=fetch,clock=Date.now}={}){
  let globalUntil=0,tail=Promise.resolve(),pending=0;const cooldowns=new Map(),receipts=new Map();
  const answer=(res,status,data,headers={})=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers}).end(JSON.stringify(data));};
  return http.createServer(async(req,res)=>{
    if(req.method==='GET'&&(req.url==='/health'||req.url==='/'))return answer(res,200,{ok:true,service:'storm-discord-relay',log_batch_files:true});
    if(req.method!=='POST'||req.url!=='/relay')return answer(res,404,{error:'not_found'});
    const auth=req.headers.authorization||'';
    if(!timingSafeEqual(digest(auth),digest('Bearer '+config.secret)))return answer(res,401,{error:'unauthorized'});
    if(pending>=100)return answer(res,503,{error:'busy'});
    let raw='',row;
    try{for await(const part of req){raw+=part.toString('utf8');if(Buffer.byteLength(raw)>4*1024*1024)return answer(res,413,{error:'payload_too_large'});}row=JSON.parse(raw);}catch{return answer(res,400,{error:'invalid_json'});}
    if(!row||typeof row!=='object'||!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||(!config.routes.has(String(row.route))&&!['1561465296584179864','1434184566284882012'].includes(String(row.route))))return answer(res,400,{error:'invalid_route_or_payload'});
    if(row.payload.content===undefined&&!Array.isArray(row.payload.embeds))return answer(res,400,{error:'empty_message'});
    let url=config.routes.get(String(row.route));
    if(!url&&['1561465296584179864','1434184566284882012'].includes(String(row.route))){
      try{
        const destination=new URL(row.destination);
        if(destination.protocol!=='https:'||destination.host!=='discord.com'||destination.username||destination.password||destination.search||destination.hash||!new RegExp('^/api/webhooks/'+String(row.route)+'/[A-Za-z0-9_-]+$').test(destination.pathname))throw Error('invalid');
        url=destination.href;
      }catch{return answer(res,400,{error:'invalid_sanctions_destination'});}
    }
    const statusMessage=row.operation==='status';
    if(statusMessage&&String(row.route)!=='1434184566284882012')return answer(res,400,{error:'status_route_only'});
    if(statusMessage&&row.message_id&&!/^\d{15,24}$/.test(String(row.message_id)))return answer(res,400,{error:'invalid_message_id'});
    const requestUrl=statusMessage?(row.message_id?url+'/messages/'+row.message_id:url+'?wait=true'):url;
    const payload={...row.payload,allowed_mentions:{parse:[]}};
    const logFile=payload.storm_log_file;delete payload.storm_log_file;
    if(logFile&&(statusMessage||typeof logFile.text!=='string'||Buffer.byteLength(logFile.text)>1024*1024||!/^storm-logs-[0-9]+\.jsonl$/.test(logFile.name)))return answer(res,400,{error:'invalid_log_file'});
    const body=JSON.stringify(payload),key=createHash('sha256').update(url+'\n'+String(row.id||'')+'\n'+body+'\n'+(logFile?logFile.text:'')).digest('hex');
    if(!statusMessage&&row.id&&receipts.get(key)>clock())return answer(res,200,{ok:true,duplicate:true});
    const deadline=clock()+20000;pending++;
    const operation=tail.then(async()=>{
      if(res.destroyed)return;
      if(clock()>deadline)return answer(res,503,{error:'busy_retry'});
      if(!statusMessage&&row.id&&receipts.get(key)>clock())return answer(res,200,{ok:true,duplicate:true});
      const remaining=Math.max(globalUntil,cooldowns.get(url)||0)-clock();
      if(remaining>0){const seconds=Math.ceil(remaining/1000);return answer(res,429,{retry_after:seconds,global:true},{'retry-after':String(seconds)});}
      let response;
      let requestBody=body;const requestHeaders={'User-Agent':'Storm-Discord-Relay/1.0'};
      if(logFile){
        const form=new FormData();
        form.set('payload_json',JSON.stringify({...payload,attachments:[{id:0,filename:logFile.name}]}));
        form.set('files[0]',new Blob([logFile.text],{type:'application/x-ndjson'}),logFile.name);requestBody=form;
      }else requestHeaders['Content-Type']='application/json';
      try{response=await fetcher(requestUrl,{method:statusMessage&&row.message_id?'PATCH':'POST',headers:requestHeaders,body:requestBody,signal:AbortSignal.timeout(15000)});}catch{return answer(res,503,{error:'discord_unreachable'});}
      if(response.status===429){
        let detail={};try{detail=await response.json();}catch{}
        const wait=Math.max(numeric(detail.retry_after),numeric(response.headers.get('retry-after')),numeric(response.headers.get('x-ratelimit-reset-after')));
        const seconds=(wait||300)+2;
        if(detail.global===true||response.headers.get('x-ratelimit-global')==='true'||!wait)globalUntil=clock()+seconds*1000;
        else cooldowns.set(url,clock()+seconds*1000);
        console.warn('Discord rate limit; waiting',seconds,'seconds');
        return answer(res,429,{retry_after:seconds,global:detail.global===true||!wait},{'retry-after':String(seconds)});
      }
      if(response.status>=200&&response.status<300){
        if(!statusMessage&&row.id){receipts.set(key,clock()+86400000);if(receipts.size>10000)receipts.delete(receipts.keys().next().value);}
        if(response.headers.get('x-ratelimit-remaining')==='0')cooldowns.set(url,clock()+(numeric(response.headers.get('x-ratelimit-reset-after'))+1)*1000);
        console.info('Delivered channel',String(row.route),'HTTP',response.status);
        let messageId;
        if(statusMessage){try{messageId=(await response.json()).id;}catch{}if(!messageId)return answer(res,502,{error:'missing_discord_message_id'});}
        return answer(res,200,{ok:true,discord_status:response.status,...(messageId?{message_id:messageId}:{})});
      }
      console.warn('Discord rejected delivery; HTTP',response.status);
      return answer(res,502,{error:'discord_rejected',discord_status:response.status});
    });
    tail=operation.catch(()=>{});
    try{await operation;}catch{answer(res,500,{error:'internal_error'});}finally{pending--;}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const server=createRelay(configuration());server.requestTimeout=25000;server.headersTimeout=10000;server.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('Storm Discord relay listening'));process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),20000).unref();});}catch(error){console.error('Relay configuration failed:',error.message);process.exit(1);}
}
