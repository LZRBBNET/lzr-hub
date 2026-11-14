// Execute the actual shell cleanup function against fake resource commands.
// No Docker, OS-user, trust or privileged operation is executed by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const source=await readFile(new URL('../scripts/qa-integrated-runner.sh',import.meta.url),'utf8');
const cleanup=source.slice(source.indexOf('cleanup() {'),source.indexOf('\nif [[ ${1:-} == cleanup ]]'));
test('failed resource cleanup retains marker and next cleanup retries rather than claiming success',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lzr-cleanup-unit-'));
 try{
  await mkdir(join(dir,'root'));await mkdir(join(dir,'home'));
  await writeFile(join(dir,'container'),'owned');await writeFile(join(dir,'fail-once'),'yes');
  const script=join(dir,'case.sh');
  await writeFile(script,`set -eu
ROOT_STATE="$1/root"; USER_HOME="$1/home"; FIXTURE="$1"
USER_NAME=fictional; CONTAINER=owned; NETWORK=owned-net; VOLUME=owned-volume
REPO="$USER_HOME/repo"; NSS="$USER_HOME/nss"; GATE="$USER_HOME/gate"; NICK=leaf
stat(){ echo 0; }
id(){ return 1; }
getent(){ return 2; }
# Every unexpected command is rejected, never forwarded to real Docker.
docker(){
 case "$*" in
 'container inspect owned') [[ -e "$FIXTURE/container" ]] ;;
 'rm -f -v owned') if [[ -e "$FIXTURE/fail-once" ]]; then /bin/rm "$FIXTURE/fail-once"; return 1; else /bin/rm "$FIXTURE/container"; fi ;;
 'network inspect owned-net'|'volume inspect owned-volume') return 1 ;;
 *) echo unexpected-command >&2; return 99 ;;
 esac
}
${cleanup}
cleanup
`);
  await assert.rejects(exec('bash',[script,dir]),error=>error.code===1);
  await access(join(dir,'root'));await access(join(dir,'container'));
  const second=await exec('bash',[script,dir]);
  assert.match(second.stdout,/"passed":true/);
  await assert.rejects(access(join(dir,'root')));
  await assert.rejects(access(join(dir,'container')));
  await assert.rejects(access(join(dir,'home')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
