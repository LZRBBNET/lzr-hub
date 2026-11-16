import {stagingDemoRequirements} from '../runtime/staging-demo.ts';
export function configuration(source,build=false){
 if(source.MEMORY_DEMO_ENABLED!=='true')throw Error('MEMORY_DEMO_REFUSED');
 for(const [key,value] of Object.entries(source))if(value!==undefined&&(/^(?:DATABASE|DIRECT_URL|PG|POSTGRES|IXC|REDIS|QUEUE_SERVICE|N8N|META_|EVOLUTION|CHATWOOT|GROQ|OPENAI|ANTHROPIC|TELEGRAM|LANGFUSE|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)/.test(key)||(/(?:PASSWORD|TOKEN|SECRET|API_KEY|AUTHORIZATION)/.test(key)&&!['MEMORY_DEMO_PASSWORD','MEMORY_DEMO_READER_PASSWORD'].includes(key))))throw Error('MEMORY_EXTERNAL_CONFIGURATION_REFUSED');
 const origin=new URL(source.MEMORY_DEMO_ORIGIN??'');if(origin.protocol!=='https:'||origin.origin!==source.MEMORY_DEMO_ORIGIN||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('MEMORY_ORIGIN_REFUSED');
 const port=Number(source.PORT??'3000');if(!Number.isInteger(port)||port<1024||port>65535)throw Error('MEMORY_PORT_REFUSED');
 for(const key of ['MEMORY_DEMO_PASSWORD','MEMORY_DEMO_READER_PASSWORD'])if(build?source[key]!==undefined:typeof source[key]!=='string'||source[key].length<24||source[key].length>256)throw Error('MEMORY_SECRET_REFUSED');
 if(!build&&source.MEMORY_DEMO_PASSWORD===source.MEMORY_DEMO_READER_PASSWORD)throw Error('MEMORY_DISTINCT_SECRETS_REQUIRED');
 const env={...stagingDemoRequirements,NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:origin.origin,SYNTHETIC_INIT_ENABLED:'false',SYNTHETIC_BROWSER_SETUP_ENABLED:'false',FEATURE_N8N_AUTOREPLY:'false',FEATURE_ATTENDANT_REPLY:'false',FEATURE_LLM_INTENT:'false',FEATURE_COPILOT_LLM:'false',FEATURE_TELEGRAM_ALERTS:'false'};
 const bind=source.MEMORY_DEMO_BIND??'0.0.0.0';if(!['127.0.0.1','0.0.0.0'].includes(bind))throw Error('MEMORY_BIND_REFUSED');
 return{bind,origin:origin.origin,host:origin.host,port,env,password:source.MEMORY_DEMO_PASSWORD,readerPassword:source.MEMORY_DEMO_READER_PASSWORD};
}
