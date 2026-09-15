# Sorasaki

Site estático na Vercel + funções em `/api` + Supabase (contas e banco).

- Guia atual de publicação, configuração e segurança: `docs/README-ATUALIZACAO-20260912.md`
- SQL a executar no Supabase: `docs/sql-seguranca-20260912.sql`
- Bibliotecas de terceiros ficam em `vendor/`, com a versão no nome do arquivo.
- Scripts de cada página ficam em `js/` (nada de JavaScript inline — o CSP não permite).
- A pasta `docs/`, arquivos `.md` e `.sql` não vão para o ar (`.vercelignore` + bloqueio no `vercel.json`).
