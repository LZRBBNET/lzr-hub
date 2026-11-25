-- Endereço das lojas por cidade (decisão do Vinícius, 25/11/2026: "opção 1"). A análise do backup da central
-- de Itabaiana mostrou que 91% das conversas encaminhadas iam para a loja da cidade do cliente; aqui a IA
-- resolve pelo WhatsApp oficial e só indica a loja para o que é presencial. Sem telefone de propósito: o
-- atendimento não sai do número oficial, e a conferência da resposta do robô recusa telefone de qualquer jeito.
-- Começa com Campo do Brito (piloto); as outras cidades entram pela tela da base. ON CONFLICT: quem editou ou
-- apagou não vê voltar.
INSERT INTO "knowledge_documents" ("id", "title", "category", "content", "status", "version", "metadata", "valid_until", "created_at", "updated_at") VALUES
('kb-lojas-por-cidade', 'Onde fica a loja da BBNET em cada cidade (endereço)', 'Atendimento', 'Onde fica a loja da BBNET de cada cidade, com o endereço. Serve para quando o cliente precisa ir ou levar algo até a loja: trocar a senha do Wi-Fi (levar o roteador e a fonte), troca de titularidade, assinar contrato ou devolver aparelho. Para todo o resto o atendimento continua por aqui, no WhatsApp oficial da BBNET, sem precisar ir à loja.
Campo do Brito: Rua João Pessoa, 104, Centro, vizinho aos Correios.
Cidade que não aparece nesta lista: um atendente informa qual é o endereço da loja que atende a cidade.', 'published', 1, '{"origem":"vinicius-2026-11-25","revisar":false}'::jsonb, NULL, '2026-11-25T18:00:00.000Z', '2026-11-25T18:00:00.000Z')
ON CONFLICT ("id") DO NOTHING;
