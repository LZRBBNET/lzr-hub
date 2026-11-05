import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertSyntheticWeb } from '../lib/runtime/synthetic-web.ts';

test('Blueprint local: free/privado/manual; mutações inseguras recusadas sem rede ou recursos', () => {
  const output = execFileSync('python3', ['-c', `
import copy,importlib.util,json,pathlib,yaml,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('guard','scripts/check-render-synthetic-blueprint.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
source=pathlib.Path('deploy/render/render.synthetic-review.yaml').read_text()
doc=yaml.load(source,Loader=g.UniqueLoader);valid=g.validate(doc)
def bad_plan(d): d['services'][0].pop('plan')
def paid(d): d['databases'][0]['plan']='0.1c-256mb'
def external(d): d['databases'][0]['ipAllowList']=[{'source':'0.0.0.0/0'}]
def missing_acl(d): d['databases'][0].pop('ipAllowList')
def deploy(d): d['services'][0]['autoDeployTrigger']='commit'
def previews(d): d['services'][0]['pullRequestPreviewsEnabled']=True
def main(d): d['services'][0]['branch']='main'
def secret(d): d['services'][0]['envVars'].append({'key':'META_ACCESS_TOKEN','value':'invented'})
def generate(d): d['services'][0]['envVars'].append({'key':'SESSION_SECRET','generateValue':True})
def wrong_ref(d): d['services'][0]['envVars'][-1]['fromDatabase']['name']='existing-db'
def migrations(d): d['services'][0]['preDeployCommand']='npm run db:migrate'
def hook(d): d['services'][0]['initialDeployHook']='seed'
def extra(d): d['services'].append(copy.deepcopy(d['services'][0]))
def interpolation(d): d['services'][0]['envVars'][-2]={'key':'SYNTHETIC_DEMO_ORIGIN','value':'https://$RENDER_EXTERNAL_HOSTNAME'}
def bootstrap(d): next(e for e in d['services'][0]['envVars'] if e['key']=='SYNTHETIC_INIT_ENABLED')['value']='true'
def flags(d): d['services'][0]['envVars'][5]['value']='false'
count=0
for change in [bad_plan,paid,external,missing_acl,deploy,previews,main,secret,generate,wrong_ref,migrations,hook,extra,interpolation,flags,bootstrap]:
 d=copy.deepcopy(doc);change(d)
 try:g.validate(d)
 except Exception:count+=1
 else:raise Exception('unsafe mutation passed')
try:yaml.load(source+'services: []\\n',Loader=g.UniqueLoader)
except Exception:count+=1
else:raise Exception('duplicate YAML accepted')
print(json.dumps({'valid':valid,'rejectedMutations':count,'flags':g.FLAGS}))
`], { encoding:'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.valid.validLocalPolicy,true); assert.equal(result.valid.provisioningAuthorized,false);
  assert.equal(result.rejectedMutations,17);
  assert.equal(assertSyntheticWeb({...result.flags,SYNTHETIC_DEMO_ORIGIN:'https://review.example.invalid'}),'https://review.example.invalid');
});
