# Troca Aí · Portfólio de Evidências

Página interativa do portfólio (Empreenda Senac, 19ª edição), publicada em
**https://portfolio.trocai.bia.lu** via GitHub Pages.

- `index.html` — a página (texto, gráficos, protótipo embutido, lista de espera e analytics)
- `demo/index.html` — protótipo navegável (bundle do Claude Design)
- `img/` — telas do protótipo
- `worker/` — Cloudflare Worker de analytics in-house (`/collect`, `/waitlist`, `/dash`) + `wrangler.toml`

## Configuração

1. **Worker**: criar `trocai-portfolio-api` no Cloudflare, colar `worker/worker.js`, ligar o binding D1 `DB`
   (`trocai-portfolio-analytics`), definir o secret `DASH_KEY` e a variável `GOOGLE_CLIENT_ID`,
   e adicionar o Custom Domain `trocai-api.bia.lu`.
2. **Google**: OAuth Client ID (Web) no Google Cloud Console com origem `https://portfolio.trocai.bia.lu`;
   colar o ID em `GOOGLE_CLIENT_ID` no `index.html` e no Worker.
3. **DNS**: `CNAME portfolio → luishansen.github.io` (DNS only) na zona `trocai.bia.lu`.
4. **GitHub Pages**: Settings → Pages → branch `main`, pasta `/`, custom domain `portfolio.trocai.bia.lu`, Enforce HTTPS.

Links por avaliador: `https://portfolio.trocai.bia.lu/?v=nome` — o código aparece no painel.
Painel: `https://trocai-api.bia.lu/dash?key=SUA_CHAVE`.
