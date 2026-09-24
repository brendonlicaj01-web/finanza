# Finanza

App web per gestire le proprie posizioni finanziarie: conti, strumenti, transazioni, rendimenti e allocazione.
I dati restano **solo nel browser** (localStorage): nessun server, nessun account.

## Funzionalità

- **Panoramica**: patrimonio totale, guadagno complessivo, P&L latente e realizzato, dividendi e interessi,
  imposte stimate sulle plusvalenze latenti, grafico dell'andamento nel tempo, allocazione per tipo e per conto.
- **Posizioni**: quantità, prezzo medio di carico (costo medio ponderato, commissioni incluse), valore di mercato,
  peso in portafoglio, P&L latente/realizzato e proventi, aggregati per strumento o per singolo conto.
- **Transazioni**: acquisti, vendite, dividendi/cedole, interessi, depositi, prelievi, commissioni/imposte, con
  filtri e controllo che non si venda più di quanto posseduto.
- **Strumenti**: azioni, ETF, obbligazioni, fondi, crypto, materie prime; aggiornamento rapido dei prezzi e aliquota
  fiscale per strumento (26% o 12,5% per titoli di Stato).
- **Conti**: broker, banche e wallet con saldo investito e liquidità.
- **Report annuale**: plus/minusvalenze realizzate, proventi, costi, versamenti e prelievi per anno.
- **Impostazioni**: valuta di riferimento, tema chiaro/scuro, tracciamento della liquidità, backup/ripristino JSON,
  esportazione CSV delle transazioni (compatibile con Excel italiano), dati di esempio.

## Avvio

Richiede Node.js 20.19 o successivo.

```bash
npm install
npm run dev        # sviluppo su http://localhost:3210 (si apre da solo nel browser)
npm run build      # build di produzione in dist/
npm run preview    # anteprima della build su http://localhost:3211
npm test           # test dei calcoli
npm run typecheck
```

La cartella `dist/` è statica: si può pubblicare su qualsiasi hosting (GitHub Pages, Netlify, ecc.).

## Struttura

```
src/
  lib/portfolio.ts   calcolo di posizioni, liquidità, riepiloghi e report (funzioni pure, testate)
  lib/types.ts       modello dati
  lib/storage.ts     salvataggio locale e validazione dei backup
  lib/csv.ts         esportazione CSV
  store.tsx          stato dell'app (React context + reducer), fotografia giornaliera del patrimonio
  pages/             Panoramica, Posizioni, Transazioni, Strumenti, Conti, Report, Impostazioni
  components/        componenti UI e grafici SVG
```

## Note

- Tutti gli importi sono espressi in un'unica valuta di riferimento; i prezzi si aggiornano manualmente.
- Il grafico dell'andamento usa una fotografia del patrimonio salvata ogni giorno in cui apri l'app.
- Le cifre fiscali sono indicative e non sostituiscono la certificazione dell'intermediario.
