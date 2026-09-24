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
- **Collegamenti**: sincronizzazione automatica di operazioni, dividendi, depositi, saldi e prezzi da
  **Interactive Brokers** (Flex Web Service), **Binance**, **Kraken**, **Coinbase**, **OKX** e **Bitpanda**
  (chiavi API di sola lettura). Parte da sola all'apertura dell'app.
- **Impostazioni**: valuta di riferimento, tema chiaro/scuro, tracciamento della liquidità, backup/ripristino JSON,
  esportazione CSV delle transazioni (compatibile con Excel italiano), dati di esempio.

## Avvio rapido (doppio clic)

1. Installa [Node.js](https://nodejs.org) (versione LTS), una volta sola.
2. Fai doppio clic sul file di avvio:
   - **Windows**: `Avvia Finanza.bat`
   - **macOS**: `Avvia Finanza.command` (la prima volta: clic destro → Apri, per autorizzarlo)
   - **Linux**: `./avvia.sh`
3. Si apre il browser su http://localhost:3210. Lascia aperta la finestra del terminale mentre usi l'app.

Lo script installa le dipendenze da solo al primo avvio (e dopo ogni aggiornamento) e, se l'app è già in
esecuzione, apre semplicemente il browser.

## Collegamenti automatici

Apri la pagina **Collegamenti**, scegli la fonte e segui la guida passo-passo nella finestra. Serve l'app avviata
sul tuo computer (file "Avvia Finanza" o `npm start`): un piccolo server locale custodisce le chiavi e parla con
broker ed exchange.

- **Sicurezza**: le chiavi sono salvate solo in `~/.finanza/connections.json` (permessi 600, fuori dal progetto) e
  non vengono mai rimandate al browser. Usa **sempre chiavi di sola lettura**. Il server ascolta solo su `localhost`
  e rifiuta le richieste provenienti da altri siti.
- **Nessun duplicato**: ogni operazione importata ha un identificativo della fonte; le sincronizzazioni successive
  aggiungono solo le novità e non toccano le transazioni modificate a mano.
- **Saldi allineati**: alla prima sincronizzazione, ciò che possedevi prima del periodo scaricato viene registrato
  come "Saldo iniziale" (con il prezzo di carico del broker, se disponibile); in seguito eventuali differenze con i
  saldi reali diventano un "Allineamento al saldo".
- **Crypto**: gli scambi crypto/crypto (es. ETH/USDT) diventano acquisto + vendita della contropartita, valorizzati
  in euro al cambio del giorno. Su Binance lo storico si legge coppia per coppia: vengono lette le monete possedute
  più quelle indicate nel campo facoltativo. OKX (Europa o globale) fornisce via API solo gli ultimi 3 mesi di
  operazioni e somma i conti Trading e Funding.

Per provare il flusso senza account reali: `FINANZA_MOCK=1 npm run dev` aggiunge un "Broker di prova".

In arrivo: eToro, conti bancari via open banking (Enable Banking), import dei file di Fineco, Directa, Degiro,
Trade Republic e Scalable Capital.

## Avvio da terminale

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
  lib/sync.ts        unione dei dati sincronizzati (conti, strumenti, transazioni, allineamento saldi)
  store.tsx          stato dell'app (React context + reducer), fotografia giornaliera del patrimonio
  sync.tsx           collegamenti e sincronizzazione automatica lato browser
  pages/             Panoramica, Posizioni, Transazioni, Strumenti, Conti, Report, Impostazioni
  components/        componenti UI e grafici SVG
server/
  plugin.ts          monta l'API locale /api dentro il server di Vite
  api.ts             endpoint: fonti, collegamenti, sincronizzazione
  store.ts           archivio locale delle credenziali (~/.finanza)
  providers/         Interactive Brokers, exchange crypto (ccxt: Binance, Kraken, Coinbase, OKX), Bitpanda
```

## Note

- Tutti gli importi sono espressi in un'unica valuta di riferimento; i prezzi si aggiornano manualmente.
- Il grafico dell'andamento usa una fotografia del patrimonio salvata ogni giorno in cui apri l'app.
- Le cifre fiscali sono indicative e non sostituiscono la certificazione dell'intermediario.
