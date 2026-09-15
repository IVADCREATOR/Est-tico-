# SORASAKI — atualização administrativa 2026

## O que foi atualizado
- Divulgação de grupos ligada à sessão atual.
- Formulário completo com plataforma/tipo, categorias, campos opcionais e prévia.
- Limite de divulgações e proteção contra duplicidade/spam no banco.
- Minhas divulgações no perfil.
- Grupos Oficiais gerenciados pelo ADM.
- Central administrativa reorganizada em Dashboard, Estatísticas, Conteúdo, Comunidade, Comercial e Sistema.
- Moderação, denúncias, usuários, histórico e configurações.
- Cupons com percentual/valor fixo, validade, limites e aplicação por plano.
- Produtos e preços.
- Notícias com rascunho/publicação programada.
- Avisos com início/fim automático.
- Auditoria de ações administrativas.
- Suspensão/reativação de usuários com proteção no servidor.
- Página pública `/noticias`.
- Resumos de notícias e avisos na página inicial.
- Mensagens públicas sem detalhes de infraestrutura.

## Banco de dados
Para um projeto já existente, execute **`migration.sql` uma única vez** no SQL Editor do Supabase.

Para uma instalação do zero, use **`schema.sql`**.

Não coloque service role key, token do Mercado Pago ou outros segredos no frontend.

## Painel ADM
O painel continua em:
`/controle-8f4c2e91`

A autorização real é feita pela função `public.is_admin()` + RLS. O frontend apenas apresenta a interface.

## Variáveis do servidor
Mantenha no ambiente do Vercel:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- MERCADOPAGO_ACCESS_TOKEN
- MERCADOPAGO_WEBHOOK_SECRET
- SITE_URL

Nunca coloque essas variáveis no `config.js`.
