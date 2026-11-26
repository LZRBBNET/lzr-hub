-- As 11 lojas, mandadas pelo Vinícius em 26/11/2026 (Campo do Brito mudou: nº 102, em frente ao Banese e aos
-- Correios). Itabaiana (a central) não veio na lista. Sem telefone, como em 0028: a IA não manda o cliente para o
-- WhatsApp da loja. O texto cabe em AGENT_SOURCE_LIMIT (1.200 caracteres), senão o modo autônomo cortaria as
-- últimas cidades. Só troca se o documento ainda for o de 0028: quem editou na tela não perde a edição.
UPDATE "knowledge_documents"
SET "title" = 'Onde fica a loja da BBNET em cada cidade (endereço)',
    "content" = 'Onde fica a loja da BBNET em cada cidade. Só para o que é presencial: senha do Wi-Fi (levar roteador e fonte), titularidade, contrato, devolver aparelho.
Areia Branca: Praça Juviniano Freire de Oliveira, s/n, Centro, vizinho à Orto Sorriso.
Campo do Brito: Rua João Pessoa, 102, em frente ao Banese e aos Correios.
Capela: Rua Marechal Deodoro da Fonseca, 259, perto do mercado municipal.
Frei Paulo: Rua Itabaiana, 53, Centro, em frente ao supermercado Barreto.
Macambira: Praça Coronel Miguel Rodrigues Pereira, 154, Centro, na praça do quiosque.
Moita Bonita: Rua São Vicente, 126, Centro, perto da academia AL Fitness.
Nossa Senhora Aparecida: Avenida Abdon José Barreto, 830, Centro, vizinho ao cabeleireiro.
Nossa Senhora da Glória: Rua Pedro Alves Feitosa, 220, Centro, na rua do supermercado Kibarato.
Nossa Senhora das Dores: Rua Gildo Lima Souza, 10, sala 7, Centro, vizinho à Bela Grife.
Ribeirópolis: Praça da Bandeira, 119, em frente ao quiosque da praça.
São Domingos: Praça Marechal Castelo Branco, 5, sala 2, Centro, ao lado da lotérica de Budá.
Outra cidade: um atendente informa a loja que atende.',
    "version" = "version" + 1,
    "metadata" = '{"origem":"vinicius-2026-11-26","revisar":false}'::jsonb,
    "updated_at" = '2026-11-26T12:00:00.000Z'
WHERE "id" = 'kb-lojas-por-cidade' AND "content" = 'Onde fica a loja da BBNET de cada cidade, com o endereço. Serve para quando o cliente precisa ir ou levar algo até a loja: trocar a senha do Wi-Fi (levar o roteador e a fonte), troca de titularidade, assinar contrato ou devolver aparelho. Para todo o resto o atendimento continua por aqui, no WhatsApp oficial da BBNET, sem precisar ir à loja.
Campo do Brito: Rua João Pessoa, 104, Centro, vizinho aos Correios.
Cidade que não aparece nesta lista: um atendente informa qual é o endereço da loja que atende a cidade.';
