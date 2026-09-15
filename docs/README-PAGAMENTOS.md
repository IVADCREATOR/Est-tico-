# Pagamentos do Sorasaki

A integração usa o Checkout Pro do Mercado Pago.

## Variáveis da Vercel

Cadastre no projeto, em Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MERCADOPAGO_ACCESS_TOKEN`
- `MERCADOPAGO_WEBHOOK_SECRET`
- `SITE_URL`

As quatro primeiras variáveis de servidor nunca devem ser colocadas em `config.js`, HTML ou JavaScript enviado ao navegador.

## Fluxo

1. Usuário precisa estar autenticado.
2. O navegador envia apenas `plan_id` e `group_id` para `/api/create-preference`.
3. A função verifica a sessão no Supabase.
4. O servidor confirma que o plano está ativo e que o grupo pertence ao usuário e está aprovado.
5. O servidor cria o pedido pendente no banco.
6. O servidor cria a preferência no Mercado Pago e devolve somente a URL de checkout.
7. O Mercado Pago envia o webhook para `/api/mercadopago-webhook`.
8. O webhook valida a assinatura e consulta o pagamento diretamente no Mercado Pago.
9. O valor recebido é comparado com o valor do pedido.
10. Somente depois da confirmação `approved` o pedido vira `paid` e o destaque é criado.

O retorno do navegador ao site nunca é tratado como prova de pagamento.

## Webhook

No Mercado Pago, configure o evento de pagamentos para:

`https://SEU-DOMINIO/api/mercadopago-webhook`

Use a chave secreta de Webhooks como `MERCADOPAGO_WEBHOOK_SECRET`.

Os preços dos planos não ficam confiados ao frontend. Eles são lidos do banco pelo servidor.

## Banco

Como o banco já pode ter sido criado antes desta atualização, execute `migration.sql` no SQL Editor do Supabase uma vez. Ele é idempotente para os índices e planos iniciais.

Os três planos iniciais são criados inativos e com valor zero. Entre no painel ADM, defina preço e duração e só então marque cada plano como ativo.
