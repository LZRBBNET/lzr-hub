# Sessão e permissões no piloto

## Problema reproduzido

Na base do PR #39 (0fb9642e858ad4fd59ad51d5385fc95e00f1208c), authorize liberava acesso sem identidade com FEATURE_AUTH=false mesmo em PILOT_MODE=internal. A criação de promessa podia gravar com autor não identificado; a leitura de promessas também passava. A mudança de estado de atendimento já recusava ausência de ator no serviço, mas depois do guard e acesso ao banco. Com FEATURE_AUTH=true, a sessão era exigida, mas o guard não restringia participantes ao piloto.

Baseline: 22 falhas entre 26 testes novos. Não se trata de 22 vulnerabilidades independentes: são cenários do bypass, allowlist e autorização.

## Correção

- Piloto declarado exige sessão independentemente de FEATURE_AUTH. Valor inválido de PILOT_MODE também não reabre a demo.
- authorize exige PILOT_MODE=internal, de dois a três IDs únicos de participantes e correspondência exata com o ID da sessão resolvida no servidor.
- RBAC continua obrigatório depois da participação; estar na lista não concede permissão adicional.
- Erros genéricos não expõem lista, usuário, cookie ou falha do banco.
- Demonstração com piloto ausente/disabled conserva o contrato anterior de FEATURE_AUTH. Esta entrega não torna esse modo apropriado para dados reais.

Escopo: guard compartilhado, portanto afeta todas as rotas que o invocam. Não altera endpoints que usam apenas currentUser, endpoints públicos de login, webhooks nem políticas específicas desses endpoints. Não é um bloqueio global de toda a aplicação. Configuração do runtime continua sujeita às exigências existentes, incluindo segredo administrativo; o guard não substitui o validador.

## Testes e revisão

Guard, parser de cookie, hash/resolução de sessão, matriz RBAC e handlers de promessa/estado reais. Repositórios de sessão, promessas e estados em memória; provedor e auditoria sintéticos.

26 testes novos: flag ausente/false/TRUE/true, cookie ausente/malformado/desconhecido, sessão expirada, usuário inativo, lookup indisponível, participante externo com auth ligada/desligada, allowlists inválidas, modo inválido, normalização e identidade exata. Matriz Supervisor/Cobrança/Atendente/Somente leitura verifica escrita, claim e ator do servidor, ignorando ator forjado no corpo. Negação ocorre antes de provedor, banco de negócio, mutação ou auditoria de sucesso.

100/100 focados passaram. Build/artefato, lint, typecheck e diff-check passaram. Revisão do diff: nenhum segredo/dado privado novo; todos os identificadores e tokens de teste são explicitamente sintéticos e os endereços usam example.invalid. Sem alteração de configuração, credenciais, schema ou dependências.

Agregada permitida: 1062/1062, sem falhas/skips; executada com preload tests/helpers/offline-guard.mjs e exclusão de tests/ixc-http.test.mjs. Build staging e 25/25 testes sintéticos passaram. Logs locais /tmp/lzr-pilot-auth-{before,focused,suite,build,lint,typecheck,staging}.log.

## Relação com outros PRs e limites

Incremental sobre #39. Não duplica #32 nem #43/#44: aqueles tratam outra implementação do Copiloto, wrapper de staging e preflight de configuração; esta correção é aplicada pelo guard em cada requisição. Não toca a candidata privada de auditoria.

Os testes usam guard/resolver reais, mas não banco PostgreSQL, navegador, cookies reais, transporte HTTP, Redis ou IXC. Sem socket/servidor, envio, produção, merge ou deploy. Resultados locais, não CI remoto aprovado. Cinco testes ixc-http que abrem sockets ficam fora da agregada permitida.

Antes de piloto: configurar FEATURE_AUTH=true e IDs reais das contas de homologação em ambiente exclusivamente sintético; validar login/logout/expiração e permissões pelo navegador, além dos endpoints que não usam authorize. Não executar ações reais para verificar acesso. Manter este PR draft até revisão e homologação; qualquer configuração real permanece fora desta entrega.
