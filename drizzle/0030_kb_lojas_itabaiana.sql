-- Itabaiana não tem loja (Vinícius, 26/11/2026). Sem a linha, quem dizia "sou de Itabaiana" recebia este
-- documento (o endereço de Frei Paulo é "Rua Itabaiana") e a IA podia mandá-lo à loja de Frei Paulo. Só troca se
-- o documento ainda for o de 0029: quem editou na tela não perde a edição.
UPDATE "knowledge_documents"
SET "content" = 'Onde fica a loja da BBNET em cada cidade. Só para o que é presencial: senha do Wi-Fi (levar roteador e fonte), titularidade, contrato, devolver aparelho.
Areia Branca: Praça Juviniano Freire de Oliveira, s/n, Centro, vizinho à Orto Sorriso.
Campo do Brito: Rua João Pessoa, 102, em frente ao Banese e aos Correios.
Capela: Rua Marechal Deodoro da Fonseca, 259, perto do mercado municipal.
Frei Paulo: Rua Itabaiana, 53, Centro, em frente ao supermercado Barreto.
Itabaiana: não tem loja da BBNET; um atendente informa onde ir.
Macambira: Praça Coronel Miguel Rodrigues Pereira, 154, Centro, na praça do quiosque.
Moita Bonita: Rua São Vicente, 126, Centro, perto da academia AL Fitness.
Nossa Senhora Aparecida: Avenida Abdon José Barreto, 830, Centro, vizinho ao cabeleireiro.
Nossa Senhora da Glória: Rua Pedro Alves Feitosa, 220, Centro, na rua do supermercado Kibarato.
Nossa Senhora das Dores: Rua Gildo Lima Souza, 10, sala 7, Centro, vizinho à Bela Grife.
Ribeirópolis: Praça da Bandeira, 119, em frente ao quiosque da praça.
São Domingos: Praça Marechal Castelo Branco, 5, sala 2, Centro, ao lado da lotérica de Budá.
Outra cidade: um atendente informa a loja que atende.',
    "version" = "version" + 1,
    "updated_at" = '2026-11-26T15:00:00.000Z'
WHERE "id" = 'kb-lojas-por-cidade' AND "content" = 'Onde fica a loja da BBNET em cada cidade. Só para o que é presencial: senha do Wi-Fi (levar roteador e fonte), titularidade, contrato, devolver aparelho.
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
Outra cidade: um atendente informa a loja que atende.';
