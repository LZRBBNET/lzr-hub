import {environment} from './environment.mjs';
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/synthetic-web.mjs','build'],{env:{...environment(),PATH:'/usr/local/bin:/usr/bin:/bin'},stdio:['ignore','pipe','pipe'],maxBuffer:20*1024*1024,timeout:300000});
if(result.status!==0){console.error('SYNTHETIC_IMAGE_BUILD_FAILED');process.exitCode=1;}
