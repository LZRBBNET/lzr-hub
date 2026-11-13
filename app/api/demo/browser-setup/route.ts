import { randomBytes } from 'node:crypto';
import { hashPassword } from '@/lib/platform/auth';
import { createBrowserInitialization } from '@/lib/platform/browser-initialization';
import { GET as initialize } from '../initialize/route';
const handle=createBrowserInitialization({source:()=>process.env,now:Date.now,random:()=>randomBytes(32).toString('hex'),derive:hashPassword,initialize});
export const GET=handle;
export const POST=handle;
