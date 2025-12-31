# Cat in Box Streamer

Deze applicatie is een 'headless' streaming bot die automatisch een webbrowser opent, naar het dashboard navigeert, en de visuele output streamt naar een RTMP endpoint.

## Tech Stack
- **Node.js**: Runtime environment.
- **Puppeteer**: Headless browser automatie (draait Google Chrome).
- **Xvfb**: Virtual Framebuffer om de browser in te renderen zonder fysiek scherm.
- **FFmpeg**: Capturt het virtuele scherm en streamt dit naar de RTMP server.

## Functionaliteit

1. Start een virtueel display (Xvfb) op `:99`.
2. Lanceert een browser in full-screen modus en opent `https://cat-in-box-pump.lovable.app/dashboard`.
3. Gebruikt FFmpeg om de video output van dit virtuele scherm te capturen (`x11grab`).
4. Streamt de beelden naar de opgegeven RTMP URL.
5. Bevat auto-reconnect logica voor robuustheid.

**Let op:** Momenteel wordt audio gestreamd als stilte (silent stream), omdat audio-capture vanuit een headless container complex is.

## Lokaal draaien (Linux/Docker aanbevolen)

Omdat dit project afhankelijk is van X11 en linux-specifieke packages, wordt aangeraden dit via Docker te draaien.

### Via Docker
1. Bouw de image:
   ```bash
   docker build -t streamer .
   ```
2. Run de container:
   ```bash
   docker run -p 3000:3000 streamer
   ```

## Deployment op Railway

1. Upload dit project naar GitHub.
2. Link de repo aan een nieuw project in Railway.
3. Railway zal automatisch de `Dockerfile` detecteren.
4. De installatie van Chrome en FFmpeg duurt even (enkele minuten).
5. Controleer de logs om te zien of de stream start.

## Environment Variabelen

- `RTMP_URL`: **(Vereist)** De RTMP base URL.
- `RTMP_KEY`: **(Vereist)** De stream key.
- `WEBSITE_URL`: **(Vereist)** De website URL om te streamen.
