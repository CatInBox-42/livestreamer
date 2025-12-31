# Handleiding: Updates doorvoeren

Elke keer als je code aanpast op je computer (bijvoorbeeld in `index.js` of `Dockerfile`), moet je deze wijzigingen naar de server brengen. Hier is het stappenplan.

## Stap 1: Lokaal (Op je eigen computer)

Open je terminal (bijv. Git Bash, PowerShell of VS Code terminal) en voer deze commando's uit om je wijzigingen naar GitHub te sturen:

```bash
# 1. Voeg alle gewijzigde bestanden toe
git add .

# 2. Sla de wijzigingen op met een berichtje
git commit -m "Beschrijving van je update"

# 3. Stuur ze naar GitHub
git push
```

---

## Stap 2: Op de Server (DigitalOcean)

Nu moet de server de nieuwe code ophalen en de streamer herstarten.

1. **Log in op je server:**
   ```bash
   ssh root@165.22.201.84
   ```

   Paste password from .env

2. **Ga naar de projectmap:**
   ```bash
   cd livestreamer
   ```
   *(Of hoe je map ook heet, check dit met `ls`)*

3. **Haal de nieuwe code op:**
   ```bash
   git pull
   ```

4. **Bouw de nieuwe Docker image:**
   *(Dit duurt even, zeker als de Dockerfile gewijzigd is)*
   ```bash
   docker build -t streamer .
   ```

5. **Herstart de stream:**
   Voer deze regels één voor één uit:

   ```bash
   # Stop de huidige stream
   docker stop streamer

   # Verwijder de oude container (maakt ruimte voor de nieuwe)
   docker rm streamer

   # Start de nieuwe versie
   docker run -d --restart unless-stopped --name streamer --env-file .env streamer
   ```

## Handige tip (Alles in één keer)

Je kunt op de server ook dit hele riedeltje in één regel plakken om te herstarten (nadat je `git pull` en `docker build` hebt gedaan):

```bash
docker stop streamer && docker rm streamer && docker run -d --restart unless-stopped --name streamer --env-file .env streamer
```

