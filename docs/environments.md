# Ambientes

| Ambiente | Dados | IXC | Uso |
|---|---|---|---|
| local | sintéticos | disabled ou mock | desenvolvimento |
| test | fixtures sanitizadas | mock | testes automatizados |
| staging | D1 isolado | staging-readonly | homologação interna |
| production | não habilitado nesta fase | bloqueado | fora do escopo 3A |

`IXC_WRITE_ENABLED=true` falha na inicialização. `production-readonly` também é rejeitado durante a Fase 3A. O banner da aplicação deve identificar o ambiente e nunca misturar Demo, Homologação e dados reais.
