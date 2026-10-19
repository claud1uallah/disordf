# Storm Discord Relay

Relay privat pentru logurile FiveM: host -> HTTPS Render -> Discord. Fara dependente npm. Nu necesita PC-ul pornit dupa conectarea hostului.

## Render

1. New > Web Service, conecteaza repository-ul `claud1uallah/disordf`.
2. Runtime **Node**; Build Command `npm install --omit=dev`; Start Command `npm start`; Health Check `/health`. Alege planul Free daca este disponibil.
3. In Environment seteaza `RELAY_SECRET` la un secret aleator de minimum 32 caractere.
4. Seteaza `DISCORD_WEBHOOKS_JSON` la un obiect JSON cu canalele: `admin`, `connect`, `disconnect`, `ck`, `faction`, `kill`, `police`, `inventory`, `economy`. Fiecare valoare este webhookul Discord corespunzator. Vezi `.env.example` pentru format. Nu publica aceste valori in GitHub.
5. Deploy, apoi trimite adresa `https://....onrender.com` pentru conectarea hostului. Endpointul de mesaje este `/relay`; GET `/health` confirma doar ca aplicatia ruleaza.

Alternativ, foloseste Blueprint-ul `render.yaml`; cele doua secrete se completeaza in Render.

## Protocol

`POST /relay`, `Authorization: Bearer RELAY_SECRET`, JSON:

```json
{"route":"connect","id":"identificator-unic-eveniment","payload":{"content":"mesaj"}}
```

`route` accepta numele configurat sau ID-ul webhookului configurat. Serverul nu accepta URL-uri arbitrare. Raspunde cu 200 numai dupa ce Discord accepta mesajul; 429 transmite timpul de asteptare; 502/503 solicita reincercare. Expeditorul trebuie sa pastreze mesajul pana primeste confirmarea.

Mentiunile Discord sunt dezactivate. Cererile sunt serializate, limitate la 4 MB, iar timpii Retry-After sunt respectati. Cheile de deduplicare se pastreaza in memorie 24 ore, maximum 10000; restartarea Render sterge deduplicarea si poate duce la repetarea ultimului mesaj. Nu exista o coada durabila pe Render: coada durabila trebuie sa ramana pe host. Planul gratuit poate adormi si poate intarzia prima cerere; expeditorul trebuie sa reincerce. Nu folosi servicii de ping pentru a ocoli regulile planului gratuit. Niciun plan gratuit nu promite disponibilitate permanenta.

## Local

Node 22 sau mai nou. Configureaza variabilele de mediu (sau `node --env-file=.env server.mjs`), apoi `npm start`. Verificari: `npm test`.

Nu pune `.env`, parole SFTP sau webhookuri in repository. Workerul local Python ramane o alternativa pana cand este activat relay-ul gazduit.

## Ten-minute log reports

The FiveM durable queue seals events every 600 seconds, grouped by original webhook. Timestamped events are sent to Discord as numbered text lists, preserving original titles, descriptions and fields. Long lists split into readable messages under Discord limits; no log file is attached. The internal host-to-relay JSONL transport remains compatible with already queued reports. Failed batches retain the same id and contents until confirmed delivery. Restart does not discard pending events. The status card continues to edit its existing message independently. The relay converts internal JSONL batches into JSON webhook messages and tracks accepted pages so a rate-limit retry does not resend earlier pages. `/health` exposes `log_batch_text: true` when this version is live.
