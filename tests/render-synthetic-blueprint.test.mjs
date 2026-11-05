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
def origin_entry(d): return next(e for e in d['services'][0]['envVars'] if e['key']=='SYNTHETIC_DEMO_ORIGIN')
def manual_origin(d): d['services'][0]['envVars'][-2]={'key':'SYNTHETIC_DEMO_ORIGIN','sync':False}
def wrong_service(d): origin_entry(d)['fromService']['name']='other-service'
def wrong_type(d): origin_entry(d)['fromService']['type']='pserv'
def wrong_variable(d): origin_entry(d)['fromService']['envVarKey']='RENDER_EXTERNAL_HOSTNAME'
def origin_cycle(d): origin_entry(d)['fromService']['envVarKey']='SYNTHETIC_DEMO_ORIGIN'
def origin_property(d): origin_entry(d)['fromService']={'type':'web','name':d['services'][0]['name'],'property':'host'}
def origin_override(d): origin_entry(d)['value']='https://review.example.invalid'
def bootstrap(d): next(e for e in d['services'][0]['envVars'] if e['key']=='SYNTHETIC_INIT_ENABLED')['value']='true'
def flags(d): d['services'][0]['envVars'][5]['value']='false'
count=0
for change in [bad_plan,paid,external,missing_acl,deploy,previews,main,secret,generate,wrong_ref,migrations,hook,extra,interpolation,flags,bootstrap,manual_origin,wrong_service,wrong_type,wrong_variable,origin_cycle,origin_property,origin_override]:
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
  assert.equal(result.rejectedMutations,24);
  assert.equal(assertSyntheticWeb({...result.flags,SYNTHETIC_DEMO_ORIGIN:'https://review.example.invalid'}),'https://review.example.invalid');
});

// Platform resolution is simulated; no Render API or service is contacted.
test('Render resolved origin remains required and canonical at build/runtime boundaries', () => {
  const flags = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('guard','scripts/check-render-synthetic-blueprint.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
print(json.dumps(g.FLAGS))
`], { encoding: 'utf8' }));
  const platform = { RENDER: 'true', RENDER_EXTERNAL_URL: 'https://synthetic-origin-fixture.onrender.com' };
  const resolved = { ...flags, ...platform, SYNTHETIC_DEMO_ORIGIN: platform.RENDER_EXTERNAL_URL };
  assert.equal(assertSyntheticWeb(resolved), platform.RENDER_EXTERNAL_URL);
  for (const value of [undefined, '', '$RENDER_EXTERNAL_URL', 'https://$RENDER_EXTERNAL_HOSTNAME',
    'http://synthetic-origin-fixture.onrender.com', platform.RENDER_EXTERNAL_URL + '/',
    platform.RENDER_EXTERNAL_URL + '/path', platform.RENDER_EXTERNAL_URL + '?query=1']) {
    assert.throws(() => assertSyntheticWeb({ ...resolved, SYNTHETIC_DEMO_ORIGIN: value }));
  }
  // A platform variable alone is deliberately not an implicit fallback.
  assert.throws(() => assertSyntheticWeb({ ...flags, ...platform }));
});
