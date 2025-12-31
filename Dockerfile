FROM node:18-bullseye

# Install FFmpeg, Chrome dependencies, PulseAudio, and full Google Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    ffmpeg \
    xvfb \
    pulseaudio \
    socat \
    alsa-utils \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configure PulseAudio
RUN mkdir -p /var/run/dbus

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./

# Install packages (Puppeteer will still download Chromium, but we will tell it to use Chrome Stable in index.js)
RUN npm install --production

# Bundle app source
COPY . .

# Set environment for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Start script
CMD [ "npm", "start" ]
