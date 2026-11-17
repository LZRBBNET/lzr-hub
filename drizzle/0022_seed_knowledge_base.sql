-- Base inicial de conhecimento da IA (17/11/2026). Escrita a partir do roteiro de
-- atendimento da BBNET e de pesquisa (luz LOS, reinício, compensação de pagamento,
-- desbloqueio de confiança, Anatel 765/2023). Sem preço, endereço, telefone ou link:
-- o que é específico da BBNET e não estava confirmado fica com "um atendente informa".
-- Entra publicada e editável na tela Base de conhecimento. ON CONFLICT: quem já editou
-- ou apagou um documento não o vê voltar.
INSERT INTO "knowledge_documents" ("id", "title", "category", "content", "status", "version", "metadata", "valid_until", "created_at", "updated_at") VALUES
('kb-padrao-horario', 'Horário de atendimento da BBNET', 'Atendimento', 'O horário de atendimento com pessoas da BBNET é de segunda a sexta-feira, das 8h às 12h e das 14h às 18h, exceto feriados. Aos sábados, domingos e feriados não há atendimento com pessoas.

A assistente virtual da BBNET atende pelo WhatsApp a qualquer hora, inclusive à noite, nos fins de semana e feriados: tira dúvidas, orienta quando a internet está sem conexão ou lenta e envia a segunda via da fatura com PIX depois de confirmar o CPF do titular.

O que precisa de uma pessoa fica registrado com o número de protocolo, e a equipe continua a conversa no próximo dia útil, por aqui mesmo.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-sem-conexao', 'Internet sem conexão: o que fazer quando a internet cai', 'Suporte técnico', 'Quando a internet fica sem conexão, primeiro veja se o problema acontece em todos os aparelhos (celular, TV, computador). Se só um aparelho está sem internet, desligue e ligue o Wi-Fi dele ou reinicie o próprio aparelho.

Se nenhum aparelho conecta, olhe as luzes do equipamento da fibra (ONU ou modem). Se a luz LOS estiver vermelha, acesa ou piscando, o sinal da fibra não está chegando até a sua casa: reiniciar não resolve e é preciso visita técnica. Nesse caso, avise por aqui que a luz LOS está vermelha.

Se a luz LOS estiver apagada, faça o reinício: tire o equipamento da fibra e o roteador da tomada, espere 30 segundos, ligue primeiro o equipamento da fibra, aguarde uns 2 minutos e depois ligue o roteador. Não aperte o botão de reset, porque ele apaga as configurações.

Confira também se os cabos estão bem encaixados e se o equipamento está ligado na tomada. Se a internet estiver bloqueada por fatura em atraso, a conexão volta depois do pagamento: a assistente envia a segunda via com PIX.

Se depois do reinício a conexão não voltar, responda dizendo que não voltou: um atendente verifica a sua linha e, se preciso, agenda a visita técnica.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-lentidao', 'Internet lenta: lentidão, travando ou devagar', 'Suporte técnico', 'Para saber se a lentidão é da internet ou do Wi-Fi, faça um teste de velocidade num computador ligado ao roteador por cabo. Pelo Wi-Fi a velocidade costuma ser menor, principalmente longe do roteador ou com paredes no caminho.

Muitos aparelhos usando a internet ao mesmo tempo, downloads, atualizações e vídeos em alta qualidade dividem a velocidade. Pause downloads e atualizações e veja se a internet lenta melhora.

Reiniciar ajuda na lentidão: tire o equipamento da fibra e o roteador da tomada por 30 segundos e ligue de novo, primeiro o da fibra. Não aperte o botão de reset.

Se o roteador tiver duas redes Wi-Fi, use a de 5 GHz (costuma ter 5G no nome) perto do roteador: ela é mais rápida. A de 2,4 GHz alcança mais longe e atravessa melhor as paredes, mas é mais lenta.

Se mesmo no cabo a velocidade ficar bem abaixo do plano contratado, avise por aqui com o resultado do teste: um atendente confere a sua conexão.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-wifi', 'Wi-Fi fraco ou caindo: sinal, alcance e cômodos', 'Suporte técnico', 'O sinal do Wi-Fi fica mais forte com o roteador num lugar central da casa, no alto e longe de paredes grossas, espelhos, aquários e micro-ondas. Dentro de armário ou atrás da TV o sinal do Wi-Fi enfraquece.

Em cômodos longe do roteador, prefira a rede Wi-Fi de 2,4 GHz, que alcança mais longe. Perto do roteador, a rede de 5 GHz é mais rápida.

Se o Wi-Fi cai e volta, reinicie o roteador tirando da tomada por 30 segundos. Se a casa é grande e o sinal não chega em algum cômodo, um repetidor ou um sistema mesh pode ajudar: um atendente informa as opções disponíveis.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-senha-wifi', 'Trocar a senha ou o nome da rede Wi-Fi', 'Suporte técnico', 'A troca da senha do Wi-Fi ou do nome da rede é feita pela equipe da BBNET, com segurança, para não deixar a sua internet sem acesso. Peça por aqui e um atendente faz a troca da senha com você.

Depois da troca da senha do Wi-Fi, todos os aparelhos precisam ser conectados de novo com a senha nova.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-reiniciar', 'Como reiniciar o roteador e o equipamento da fibra (reinício de equipamento)', 'Suporte técnico', 'Para reiniciar o equipamento: tire da tomada o equipamento da fibra (ONU ou modem) e o roteador, espere 30 segundos, ligue primeiro o equipamento da fibra, aguarde uns 2 minutos até as luzes estabilizarem e depois ligue o roteador.

O reinício resolve boa parte das quedas e da lentidão. O reset (botão escondido, apertado com um clipe) é diferente: ele apaga as configurações e deixa a internet sem funcionar até um técnico configurar de novo. Não use o reset.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-segunda-via', 'Segunda via da fatura, boleto e PIX', 'Financeiro', 'Quando o número do WhatsApp é o mesmo do cadastro do contrato, a assistente virtual envia a segunda via da fatura com o código PIX copia e cola. Por segurança, antes de mostrar qualquer dado financeiro ela pede o CPF do titular e confere com o cadastro.

Para receber a segunda via, escreva segunda via e, quando pedido, mande o CPF do titular, só os números. O PIX copia e cola é colado no aplicativo do seu banco, na opção PIX copia e cola.

O pagamento da fatura por PIX costuma ser reconhecido em poucos minutos. O boleto pode levar até 3 dias úteis para compensar.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-ja-paguei', 'Já paguei e a internet continua bloqueada (pagamento não reconhecido)', 'Financeiro', 'O pagamento por PIX costuma ser reconhecido em poucos minutos. O pagamento por boleto pode levar até 3 dias úteis para compensar, dependendo do banco e do horário em que foi pago.

Depois que o pagamento é reconhecido, a internet volta sozinha. Se não voltar, reinicie o equipamento da fibra e o roteador, tirando da tomada por 30 segundos.

Se você pagou e a internet continua bloqueada, envie o comprovante de pagamento por aqui: um atendente confere o pagamento e, enquanto ele compensa, pode fazer o desbloqueio de confiança, que libera a internet por um período.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-bloqueio', 'Internet bloqueada por fatura em atraso (desbloqueio)', 'Financeiro', 'Quando uma fatura fica em atraso, a internet pode ser bloqueada até o pagamento. Pagando por PIX, o desbloqueio costuma acontecer em poucos minutos depois do pagamento.

A assistente envia a fatura em aberto com o código PIX depois de confirmar o CPF do titular. Escreva segunda via para começar.

O desbloqueio de confiança é uma liberação temporária da internet enquanto o pagamento compensa. Ele segue as regras do contrato e é feito pelo atendimento: peça por aqui que um atendente verifica se o seu contrato pode usar.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-pagamento', 'Formas de pagamento da fatura', 'Financeiro', 'Você pode pagar a fatura da BBNET por PIX, com o código copia e cola, ou pelo boleto, com a linha digitável, no aplicativo do banco, em lotéricas ou correspondentes bancários.

PIX é a forma de pagamento mais rápida: costuma ser reconhecido em poucos minutos. O boleto pode levar até 3 dias úteis para compensar.

Para outras formas de pagamento ou para mudar a data de vencimento, um atendente verifica as opções do seu contrato.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-planos', 'Planos, contratação, upgrade e downgrade', 'Comercial', 'Os planos e os valores da internet BBNET dependem do endereço, porque a disponibilidade da fibra muda de rua para rua. Para contratar, envie por aqui o endereço completo com bairro e cidade, e um atendente do comercial apresenta os planos disponíveis.

Para mudar de plano (upgrade, para aumentar a velocidade, ou downgrade, para diminuir), um atendente confere o seu contrato e o plano atual e explica as opções antes de qualquer mudança.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-endereco', 'Mudança de endereço da internet', 'Comercial', 'Para levar a internet para outro endereço, envie por aqui o endereço novo completo, com bairro e cidade. Um atendente verifica se há cobertura da fibra no local e agenda a instalação no endereço novo.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-titularidade', 'Troca de titularidade do contrato', 'Atendimento', 'A troca de titularidade (passar o contrato da internet para o nome de outra pessoa, como mãe, pai, esposa, marido ou filho) é feita na loja da BBNET, com a presença do novo titular. Por segurança, ela não é feita pelo WhatsApp.

Para a troca de titularidade, leve documento oficial com foto e o CPF do titular atual e do novo titular. A loja confirma na hora se precisa de mais algum documento.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-visita', 'Visita técnica e ordem de serviço (chamado técnico)', 'Suporte técnico', 'A visita técnica é agendada quando o problema não se resolve à distância, como fibra rompida, luz LOS vermelha ou equipamento com defeito. Um atendente abre a ordem de serviço e combina o melhor horário com você.

No dia da visita técnica, é preciso ter uma pessoa maior de idade no local para receber o técnico.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-protocolo', 'Protocolo de atendimento', 'Atendimento', 'Todo atendimento pelo WhatsApp recebe um número de protocolo, enviado na primeira resposta. Guarde o protocolo: ele identifica o seu atendimento se você precisar falar dele depois.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-instabilidade', 'Internet caindo e voltando (instabilidade, quedas constantes)', 'Suporte técnico', 'Se a internet cai e volta, veja se acontece em todos os aparelhos ou só no Wi-Fi. Só no Wi-Fi costuma ser distância do roteador ou interferência; em todos os aparelhos, pode ser o equipamento ou a linha.

Para quedas constantes, reinicie o equipamento da fibra e o roteador, tirando da tomada por 30 segundos, e confira se os cabos estão firmes. Anote os horários em que a internet cai.

Se as quedas continuarem depois do reinício, avise por aqui com os horários aproximados: um atendente analisa a sua conexão.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-velocidade', 'Velocidade contratada e direito do consumidor', 'Atendimento', 'Pelas regras da Anatel (Regulamento Geral de Direitos do Consumidor, Resolução 765 de 2023), o cliente tem direito à velocidade contratada. A forma certa de medir a velocidade é com um computador ligado ao roteador por cabo, porque o Wi-Fi reduz a velocidade.

Se a velocidade medida no cabo ficar abaixo do contratado com frequência, avise por aqui com os resultados dos testes: um atendente verifica a sua conexão.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-aplicativo', 'Um aplicativo ou site específico não funciona', 'Suporte técnico', 'Se só um aplicativo ou site não abre (Netflix, YouTube, Instagram, WhatsApp, jogo, banco) e o resto da internet funciona, o problema costuma ser do próprio serviço. Feche e abra o aplicativo, atualize o aplicativo e reinicie o aparelho.

Se vários aplicativos falham ao mesmo tempo, siga as dicas de internet sem conexão ou lenta: reinicie o equipamento da fibra e o roteador por 30 segundos.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z'),
('kb-padrao-equipamento', 'Roteador novo, troca ou configuração de equipamento', 'Suporte técnico', 'A troca ou a configuração do roteador e do equipamento da fibra é feita por um técnico da BBNET, com ordem de serviço. Peça por aqui que um atendente agenda a visita técnica.', 'published', 1, '{"origem":"lzr-padrao","revisar":true}'::jsonb, NULL, '2026-11-17T21:00:00.000Z', '2026-11-17T21:00:00.000Z')
ON CONFLICT ("id") DO NOTHING;
