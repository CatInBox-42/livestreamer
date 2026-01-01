require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

// Configuration
const DASHBOARD_URL = process.env.WEBSITE_URL;
const RTMP_URL = process.env.RTMP_URL;
const RTMP_KEY = process.env.RTMP_KEY;

function validateConfig() {
    const missing = [];
    if (!DASHBOARD_URL) missing.push('WEBSITE_URL');
    if (!RTMP_URL) missing.push('RTMP_URL');
    if (!RTMP_KEY) missing.push('RTMP_KEY');

    if (missing.length > 0) {
        log(`Missing required environment variables: ${missing.join(', ')}`, 'ERROR');
        process.exit(1);
    }
}

validateConfig();

const FULL_RTMP_URL = RTMP_URL.endsWith('/') ? `${RTMP_URL}${RTMP_KEY}` : `${RTMP_URL}/${RTMP_KEY}`;

const RECONNECT_DELAY = 5000;
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 720;
const DISPLAY_NUM = ':99';

let ffmpegCommand = null;
let browser = null;
let xvfbProcess = null;

function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
}

async function startXvfb() {
    log('Starting Xvfb...', 'INFO');
    // Start PulseAudio
    log('Starting PulseAudio...', 'INFO');
    try {
        spawn('pulseaudio', ['-k']);
        spawn('pulseaudio', [
            '-D', 
            '--exit-idle-time=-1', 
            '--disallow-exit', 
            '--system=false',
            '--daemonize',
            '--log-target=stderr'
        ]);
        
        await new Promise(r => setTimeout(r, 2000));
        
        // Create Virtual Sink
        spawn('pactl', ['load-module', 'module-null-sink', 'sink_name=VirtualSink', 'sink_properties=device.description=VirtualSink']);
        await new Promise(r => setTimeout(r, 500));
        
        // Set as default
        spawn('pactl', ['set-default-sink', 'VirtualSink']);
        // Force Unmute & 100% Volume
        spawn('pactl', ['set-sink-mute', 'VirtualSink', '0']);
        spawn('pactl', ['set-sink-volume', 'VirtualSink', '100%']);
        // Force default sink volume too just in case
        spawn('pactl', ['set-sink-volume', '@DEFAULT_SINK@', '100%']);
        
        log('PulseAudio VirtualSink initialized.', 'SUCCESS');
    } catch (e) {
        log(`PulseAudio setup failed: ${e.message}`, 'WARN');
    }

    xvfbProcess = spawn('Xvfb', [DISPLAY_NUM, '-screen', '0', `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`]);
    
    xvfbProcess.stderr.on('data', (data) => {
        // Xvfb often outputs to stderr for info, so just debug log
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
}

async function startBrowser() {
    log(`Launching Puppeteer for ${DASHBOARD_URL}...`, 'INFO');
    
    browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--app=' + DASHBOARD_URL, // Use App mode to remove UI
            '--window-size=' + SCREEN_WIDTH + ',' + SCREEN_HEIGHT,
            '--start-fullscreen',
            '--autoplay-policy=no-user-gesture-required',
            '--display=' + DISPLAY_NUM,
            '--incognito',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-accelerated-video-decode'
        ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    // Capture browser console logs to debug audio issues
    page.on('console', msg => log('BROWSER LOG: ' + msg.text(), 'DEBUG'));
    
    await page.setCacheEnabled(false);
    
    // No User Agent spoofing (back to Linux default for stability)

    await page.setViewport({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
    
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });
    log('Page loaded.', 'SUCCESS');

    // CLICK to ensure audio starts
    try {
        await new Promise(r => setTimeout(r, 2000)); 
        await page.mouse.click(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
        log('Clicked center screen to trigger audio.', 'INFO');
    } catch (e) {
        log('Click failed: ' + e.message, 'WARN');
    }
    
    // Aggressive CSS Injection
    await page.addStyleTag({ content: `
        body { 
            overflow: hidden !important;
            margin: 0 !important;
            padding: 0 !important;
            transform-origin: center top;
        }
        ::-webkit-scrollbar { 
            display: none !important; 
        }
    `});

    // Scroll down 
    await page.evaluate(() => {
        window.scrollBy(0, 360); // 10px more scroll
    });
    log('Scrolled down to relevant content.', 'INFO');
}

function startStream() {
    log('Starting FFmpeg stream...', 'INFO');
    log(`Source: X11 Display ${DISPLAY_NUM}`);
    log(`Target: ${RTMP_URL} (Key hidden)`);

    ffmpegCommand = ffmpeg()
        // Input: Grab X11 display
        .input(DISPLAY_NUM)
        .inputFormat('x11grab')
        .inputOptions([
            `-video_size ${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
            '-framerate 30',
            '-draw_mouse 0'
        ])
        // Use video filter to crop out the browser UI + Left white line
        // Crop width=1270 (cut 10px from left), height=540 (remove top 180px), start at x=10, y=180
        .complexFilter([
            `crop=w=${SCREEN_WIDTH - 10}:h=${SCREEN_HEIGHT - 180}:x=10:y=180[cropped]`,
            `[cropped]scale=${SCREEN_WIDTH}:${SCREEN_HEIGHT}[outv]`
        ], ['outv'])
        
        // Input: Grab PulseAudio monitor source
        .input('VirtualSink.monitor') 
        .inputFormat('pulse')
        
        // Output options
        .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-maxrate', '2500k',
            '-bufsize', '5000k',
            '-pix_fmt', 'yuv420p',
            '-g', '60',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-f', 'flv'
        ])
        .output(FULL_RTMP_URL)
        
        .on('start', (cmd) => {
            log('Streaming started!', 'SUCCESS');
            log(`Command: ${cmd}`, 'DEBUG');
        })
        .on('error', (err) => {
            log(`Stream error: ${err.message}`, 'ERROR');
            scheduleReconnect();
        })
        .on('end', () => {
            log('Stream ended.', 'WARN');
            scheduleReconnect();
        });

    ffmpegCommand.run();
}

function scheduleReconnect() {
    log(`Restarting streaming components in ${RECONNECT_DELAY/1000}s...`, 'INFO');
    
    if (ffmpegCommand) {
        try { ffmpegCommand.kill(); } catch (e) {}
        ffmpegCommand = null;
    }
    
    if (browser && !browser.isConnected()) {
        log('Browser disconnected. Full restart.', 'WARN');
        process.exit(1);
    }

    setTimeout(startStream, RECONNECT_DELAY);
}

async function main() {
    try {
        process.env.DISPLAY = DISPLAY_NUM;
        await startXvfb();
        await startBrowser();
        startStream();
    } catch (err) {
        log(`Fatal error during startup: ${err.message}`, 'ERROR');
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    log('Stopping...', 'INFO');
    if (ffmpegCommand) try { ffmpegCommand.kill(); } catch (e) {}
    if (browser) await browser.close();
    if (xvfbProcess) xvfbProcess.kill();
    process.exit(0);
});

main();
