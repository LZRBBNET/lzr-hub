-- Planos e valores dos folhetos da BBNET (Vinícius, 27/11/2026). Só troca se o documento ainda for o da 0022:
-- quem editou na tela não perde a edição. O telefone do folheto fica de fora (o robô recusa resposta com telefone).
UPDATE "knowledge_documents"
SET "content" = 'Planos da BBNET: 100% fibra óptica, instalação grátis e Wi-Fi incluso.
- 300 Mega: R$ 69,90 por mês, com canais abertos, app de livros digitais (Skeelo), o app BBNET e streaming Watch.
- 700 Mega: R$ 99,90 por mês, com Skeelo, ESPN, Sportv e Watch.
- 1000 Mega (1 Giga): R$ 119,90 por mês, com Skeelo, ESPN, HBO Max, Sportv e Watch.
- Plano Fanáticos por Futebol, 1 Giga: R$ 139,90 por mês, com Watch, Skeelo, HBO Max, Sportv, Premiere e ESPN.
- 1 Giga sem aplicativos: R$ 79,90 por mês, com o roteador emprestado (comodato) sem custo a mais.

A fibra não chega em todas as ruas. Para contratar, envie por aqui o endereço completo com bairro e cidade, e um atendente do comercial confirma se atende e fecha o plano.

Para mudar de plano (upgrade, para aumentar a velocidade, ou downgrade, para diminuir), um atendente confere o seu contrato e o plano atual e explica as opções antes de qualquer mudança.',
    "metadata" = '{"origem":"vinicius-2026-11-27","revisar":false}'::jsonb,
    "version" = "version" + 1,
    "updated_at" = '2026-11-27T12:00:00.000Z'
WHERE "id" = 'kb-padrao-planos' AND "content" = 'Os planos e os valores da internet BBNET dependem do endereço, porque a disponibilidade da fibra muda de rua para rua. Para contratar, envie por aqui o endereço completo com bairro e cidade, e um atendente do comercial apresenta os planos disponíveis.

Para mudar de plano (upgrade, para aumentar a velocidade, ou downgrade, para diminuir), um atendente confere o seu contrato e o plano atual e explica as opções antes de qualquer mudança.';
