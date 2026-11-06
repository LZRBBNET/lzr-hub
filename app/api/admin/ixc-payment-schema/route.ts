import {eq} from 'drizzle-orm';
import {getDb} from '@/db/index';
import {auditEvents} from '@/db/schema';
import {authorize} from '@/lib/platform/session-guard';
import {createPaymentSchemaWebDiagnostic,PAYMENT_SCHEMA_RESERVATION_ID} from '@/lib/platform/payment-schema-web-diagnostic';
import {collectPaymentShape,createSchemaTransport} from '@/scripts/ixc-payment-schema-diagnostic.mjs';

// A fixed primary key in the EXISTING audit table consumes this diagnostic across
// replicas/restarts. Never use best-effort audit or delete/re-key to retry.
const handle=createPaymentSchemaWebDiagnostic({
  env:()=>process.env,
  authorize:request=>authorize(request,'integrations.test'),
  reserve:async()=>{
    const db=await getDb();
    const rows=await db.insert(auditEvents).values({id:PAYMENT_SCHEMA_RESERVATION_ID,actorId:'authenticated-operator',role:'Administrador',action:'ixc.payment.schema.diagnostic',entity:'diagnostic-schema',reason:'Reserva única antes da leitura diagnóstica',correlationId:PAYMENT_SCHEMA_RESERVATION_ID,result:'reserved',origin:'humano',createdAt:new Date().toISOString()}).onConflictDoNothing().returning({id:auditEvents.id});
    return rows.length===1;
  },
  complete:async()=>{
    const db=await getDb();
    const rows=await db.update(auditEvents).set({result:'completed'}).where(eq(auditEvents.id,PAYMENT_SCHEMA_RESERVATION_ID)).returning({id:auditEvents.id});
    if(rows.length!==1)throw Error('UNVERIFIED');
  },
  status:async()=>{
    const db=await getDb();
    const rows=await db.select({result:auditEvents.result}).from(auditEvents).where(eq(auditEvents.id,PAYMENT_SCHEMA_RESERVATION_ID));
    if(rows.length===0)return 'unused';
    return rows.length===1&&(rows[0].result==='reserved'||rows[0].result==='completed')?rows[0].result:'unverified';
  },
  collect:(config,reserve)=>collectPaymentShape(config,{transport:createSchemaTransport(config),reserve}),
});
export const POST=handle;
export const GET=handle;
