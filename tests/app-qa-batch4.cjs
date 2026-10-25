const test=require('node:test'),assert=require('node:assert/strict');
test('AI errors expose useful guidance rather than raw server payloads',async()=>{
 const {requestAI,friendlyError}=await import('../app/js/ai-request.js');const old=global.fetch;
 try{for(const [status,code,expected] of [[401,'invalid_api_key',/key was rejected/],[429,'rate_limit_exceeded',/too many requests/],[429,'insufficient_quota',/no available credit/]]){global.fetch=async()=>new Response(JSON.stringify({error:{code,message:'private server details'}}),{status});await assert.rejects(requestAI('https://example.invalid',{}),e=>expected.test(e.message)&&!e.message.includes('private'))}assert.match(friendlyError(new SyntaxError('raw parser details')),/couldn’t read the response/)}finally{global.fetch=old}
});
test('assistant requests use bounded active-session turns and context',()=>{
 const fs=require('node:fs'),vm=require('node:vm');let source=fs.readFileSync('app/js/assistant.js','utf8').replace(/^import[\s\S]*?from "[^\"]+";\n/gm,'').replace(/export /g,'');source+='\nglobalThis.check = turns => { transcript=turns; currentLang="fr"; return apiMessages(); };';const ctx=vm.createContext({document:{},console});vm.runInContext(source,ctx);const turns=Array.from({length:70},(_,i)=>({role:i%2?'assistant':'user',text:'x'.repeat(6000),contexts:Array(8).fill('c'.repeat(5000))}));const messages=ctx.check(turns);assert.equal(messages.length,17);assert.ok(messages.slice(1).every(m=>m.content.length<8500));assert.ok(messages[0].content.includes('French'));
});
