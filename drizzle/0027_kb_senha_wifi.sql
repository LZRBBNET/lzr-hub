-- Troca de senha do Wi-Fi: o texto de 0022 dizia "peça por aqui e um atendente faz a troca". O certo, confirmado
-- pelo Vinícius em 25/11/2026 e pelo backup da central de Itabaiana: trazer o roteador e a fonte à loja ou agendar
-- visita, porque cada cidade e cada cliente têm suas exceções. (Quando o ACS for integrado, a troca poderá ser remota.)
-- Só troca se o texto ainda for o original: não sobrescreve documento que alguém tenha mudado.
UPDATE "knowledge_documents"
SET "content" = 'A troca da senha ou do nome da rede Wi-Fi não é feita pelo aplicativo nem por mensagem: traga o roteador e a fonte (o carregador que vai na tomada) até a loja da BBNET da sua cidade, ou peça por aqui uma visita técnica. Cada cidade e cada caso pode ter uma condição diferente, e a equipe confirma com você. Depois da troca, todos os aparelhos precisam ser conectados de novo com a senha nova.',
    "version" = "version" + 1,
    "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"revisado":"2026-11-25","motivo":"senha do wi-fi: loja ou visita"}'::jsonb,
    "updated_at" = '2026-11-25T12:00:00.000Z'
WHERE "id" = 'kb-padrao-senha-wifi'
  AND "content" = 'A troca da senha do Wi-Fi ou do nome da rede é feita pela equipe da BBNET, com segurança, para não deixar a sua internet sem acesso. Peça por aqui e um atendente faz a troca da senha com você.

Depois da troca da senha do Wi-Fi, todos os aparelhos precisam ser conectados de novo com a senha nova.';
