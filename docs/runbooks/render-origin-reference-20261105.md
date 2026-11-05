# Origem sintética no Render — revisão local 2026-11-05

A candidata de #55 foi conferida no head remoto 1a3020ef1544ecb9ab233d9723b09486ad29a18d; a árvore local de partida 8c2b2bc é equivalente. Correção isolada, sem atualizar branch remota ou plano Render.

SYNTHETIC_DEMO_ORIGIN agora referencia fromService/type:web/name do próprio web/envVarKey:RENDER_EXTERNAL_URL. Não usar property:host (rede interna), RENDER_EXTERNAL_HOSTNAME (sem protocolo), interpolação literal ou referência circular. Não depende de conhecer o sufixo oficial antecipadamente.

Referências oficiais consultadas:
- https://render.com/docs/blueprint-spec#self-referencing-environment-variables: autorreferência permitida para variáveis padrão; RENDER_EXTERNAL_URL não está nas exceções.
- https://render.com/docs/environment-variables: variáveis padrão disponíveis no build e runtime salvo exceção; RENDER_EXTERNAL_URL é URL HTTPS completa do web, sem exceção de fase.
- https://render.com/docs/configure-environment-variables: configuração e ativação dependem de sync/deploy aplicável.

Markdown não pôde ser lido pelo cliente (403/unsupported content-type); HTML oficial foi lido. A conclusão de suporte resulta da combinação das duas primeiras referências, não de uma criação real de serviço. Referências fromService atualizam em Blueprint sync, não continuamente.

O guard de política exige exatamente essa referência ao próprio serviço. assertSyntheticWeb já exige origem HTTPS canônica explícita sem credenciais/path/query/hash/barra final. Nenhum fallback para hostname, variável da plataforma isolada, URL da requisição ou headers foi adicionado. Falta/valor não resolvido bloqueia build e runtime; proxy mantém páginas/APIs fechadas em configuração inválida. O domínio onrender.com da fixture é inventado e nunca foi acessado.

Validação: 12 testes passaram (guard, 24 mutações inseguras recusadas, resolução simulada e regressão do proxy/autenticação). Build Node usa ambiente resolvido simulado, sem banco ou servidor. O smoke importa o artefato e usa Request/Response em memória; não abre porta. Não valida o resolvedor real da Render.

Limites e próxima ação: revisão de diff e transporte do patch para a candidata publicada, seguidos de novo planejamento explicitamente autorizado para conferir a resolução real. O plano remoto atual continua com a versão anterior até atualização autorizada; não aprová-lo supondo esta correção aplicada. Não houve API de validação oficial, sync, alteração de plano, deploy, banco, geração de credenciais ou dados privados. SYNTHETIC_INIT_ENABLED permanece false; free/ACL/autoDeploy e demais flags preservados.
