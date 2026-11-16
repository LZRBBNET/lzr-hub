// OFFLINE audit of existing pure simulation + reply resolver. No provider, DB or channel.
import fs from 'node:fs';
import {serviceOpening,hasPriorOutput} from '../lib/platform/service-opening.ts';
import {servicePreferences} from '../lib/agent/service-preferences.ts';
import {supportRequest} from '../lib/agent/troubleshooting-context.ts';
import { runAgentPipeline } from '../lib/agent/pipeline.ts';
import { resolveSupportReply } from '../lib/platform/support-reply.ts';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/exalted-customer-cases.json',import.meta.url),'utf8'));
const results=fixture.cases.map(c=>{
 const p=runAgentPipeline(c.message,c.history);
 const resolved=resolveSupportReply({intent:p.intent,message:c.message,history:c.history,handoffReason:p.handoff.reason});
 const text=serviceOpening(resolved,{now:Date.parse('2026-10-30T18:00:00Z'),priorOutput:hasPriorOutput(c.history),concise:servicePreferences(c.message,c.history).conciseOpening||!!supportRequest(c.message)});
 const checks=[]; const check=(name,pass)=>checks.push({name,pass});
 check('question_budget',(text.replace(/Tudo bem\?/g,'').match(/\?/g)||[]).length<=c.checks.max_questions);
 check('no_retaliation_or_calm_down',!(/acalme|se acalmar|baixe o tom|você é (idiota|burro)/i.test(text)));
 check('no_unconfirmed_action_promise',!(/(?<!não )vou encaminhar|(?<!não )vou pedir|retornamos por aqui|que retorna por aqui|já (agendei|encaminhei|cancelei|abri)/i.test(text)));
 if(c.checks.greeting)check('first_reply_greeting',/bom dia|boa tarde|boa noite|olá/i.test(text));
 for(const r of c.checks.must_match||[])check('required_content:'+r,new RegExp(r,'i').test(text));
 for(const r of c.checks.forbid||[])check('forbidden_content:'+r,!new RegExp(r,'i').test(text));
 if(c.checks.allowed_intents)check('intent_preserves_context',c.checks.allowed_intents.includes(p.intent));
 if(c.checks.required_handoff_reason)check('explicit_threat_priority_signal',p.handoff.reason===c.checks.required_handoff_reason);
 return {id:c.id,intent:p.intent,handoff:p.handoff,simulationOnly:p.simulationOnly,actionExecuted:p.actionExecuted,tools:p.tools.map(t=>({tool:t.tool,outcome:t.outcome,simulated:t.simulated,realAction:t.realAction})),actual_reply:text,checks,failed_checks:checks.filter(x=>!x.pass).map(x=>x.name),semantic_review:'REQUIRED: automated checks do not validate all expected invariants'};
});
const output={baseline_commit:fixture.baseline_commit,scope:'pure offline simulation and existing resolver; no actual channel, database, model or delivery test',results,summary:{cases:results.length,cases_with_automated_gaps:results.filter(x=>x.failed_checks.length).length,automated_checks_passed:results.flatMap(x=>x.checks).filter(x=>x.pass).length,automated_checks_failed:results.flatMap(x=>x.checks).filter(x=>!x.pass).length,semantic_acceptance:'NOT established'}};
fs.writeFileSync(new URL('../docs/courtesy-review-results.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output.summary)); for(const x of results)console.log(x.id,x.intent,JSON.stringify(x.failed_checks),JSON.stringify(x.actual_reply));
