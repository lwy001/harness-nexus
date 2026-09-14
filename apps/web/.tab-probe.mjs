import { io } from 'socket.io-client';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/home/ubuntu/workspace/mcp-proxy/.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');
const now=Math.floor(Date.now()/1000);
const head=b64({alg:'HS256',typ:'JWT'});
const pay=b64({role:'admin',iss:'harnessnexus',sub:'TG_03SBWFPL193r1RsW7Dw',iat:now,exp:now+1800});
const jwt=head+'.'+pay+'.'+createHmac('sha256',env.JWT_SECRET).update(head+'.'+pay).digest('base64url');
const BASE='http://127.0.0.1:15922';
const sock=io(`${BASE}/app`,{auth:{token:jwt},transports:['websocket']});
const snaps=[];
sock.on('chat:channels',(s)=>{snaps.push(JSON.stringify(s.channels.map(c=>`${c.sessionId.slice(0,6)}:${c.phase}${c.busy?'!':''}${c.deferred?'~':''}`)));});
sock.on('chat:session.closed',(p)=>console.log('[closed]',JSON.stringify(p)));
sock.on('chat:session.failed',(p)=>console.log('[failed]',JSON.stringify(p)));
await new Promise(r=>sock.on('connect',r));
console.log('[initial snapshot]', snaps[0] ?? '(none yet)');
const list=await (await fetch(`${BASE}/api/agent-instances/2nkFDn-MI_fsD9YIlWGZiw/sessions`,{headers:{authorization:'Bearer '+jwt}})).json();
const row=(list.sessions??[]).find(s=>s.title)|| (list.sessions??[])[0];
console.log('[resume]', row.sessionId.slice(0,8), row.title);
const ack=await new Promise(r=>sock.emit('chat:session.open',{agentInstanceId:'2nkFDn-MI_fsD9YIlWGZiw',resume:{sessionId:row.sessionId,cwd:row.cwd}},r));
console.log('[open ack]',JSON.stringify(ack));
for(let i=0;i<12;i++){
  await new Promise(r=>setTimeout(r,2500));
  console.log(`t=${(i+1)*2.5}s snap:`,snaps[snaps.length-1]);
}
process.exit(0);
