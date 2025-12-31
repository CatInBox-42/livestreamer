FROM node:18-bullseye

# Install FFmpeg and Puppeteer dependencies (Chrome + Xvfb)
# We install 'google-chrome-stable' dependencies manually or rely on 'chromium'
RUN apt-get update && apt-get install -y \
    ffmpeg \
    xvfb \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    pulseaudio \
    socat \
    alsa-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configure PulseAudio
# Create a user for PulseAudio (it doesn't like running as root, but we can force it or configure it)
# We will run PulseAudio as the root user for simplicity in this container context, 
# although typically not recommended for desktop use.
RUN mkdir -p /var/run/dbus


# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./

# Install packages including puppeteer
RUN npm install --production

# Bundle app source
COPY . .

# Set environment for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
# Puppeteer will automatically find the local chromium downloaded during npm install

# Start script
CMD [ "npm", "start" ]
