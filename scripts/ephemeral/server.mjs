import {assertSyntheticWebDatabase} from '../../lib/runtime/synthetic-web.ts';
import {installSyntheticEgress} from '../../lib/runtime/synthetic-egress.mjs';
assertSyntheticWebDatabase(process.env);installSyntheticEgress(process.env.DATABASE_URL);
const {startProdServer}=await import('vinext/server/prod-server');
await startProdServer({port:34444,host:'127.0.0.1',outDir:'/app/work/synthetic-web/dist'});
