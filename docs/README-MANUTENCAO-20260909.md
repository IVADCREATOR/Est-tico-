# Manutenção completa Sorasaki — 09/09/2026

## Antes do deploy
1. Execute `sql-manutencao-20260909.sql` no SQL Editor do Supabase.
2. Confirme no Vercel as variáveis `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
3. A imagem de manutenção já está no projeto como `sorasaki-manutencao.jpg`; não é necessário cadastrar URL.

## Fluxos corrigidos
- Conteúdo público (produtos, notícias e avisos) passa por `/api/public-content`, com filtros aplicados no servidor.
- Catálogo público em `/catalogo`.
- Produtos suportam categoria e imagem.
- Usuários: busca por e-mail, nome, username, metadata ou ID e filtro de status no servidor.
- Manutenção: middleware bloqueia páginas públicas e mantém `/controle-8f4c2e91` acessível; imagem fixa local.

## Limitação de teste
O projeto foi validado estaticamente e com testes locais de sintaxe/fluxo usando mocks. Não é possível confirmar aqui uma conexão real com o Supabase/Vercel sem o ambiente de produção.
