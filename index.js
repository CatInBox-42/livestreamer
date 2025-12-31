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
    // Start Xvfb on display :99 with 1280x720 resolution and 24-bit color
    // Start PulseAudio
    log('Starting PulseAudio...', 'INFO');
    try {
        // Kill any existing instance
        spawn('pulseaudio', ['-k']);
        
        // Start new instance in background
        // We load module-virtual-sink to have a sink to output to, and monitor
        const pa = spawn('pulseaudio', ['-D', '--exit-idle-time=-1']);
        pa.on('error', (err) => log(`PulseAudio error: ${err.message}`, 'WARN'));
        
        // Give PA a moment
        await new Promise(r => setTimeout(r, 1000));
        
        // Create a null sink to capture audio from
        // This acts as a virtual speaker that the browser will play into
        const pacmd = spawn('pactl', ['load-module', 'module-null-sink', 'sink_name=VirtualSink', 'sink_properties=device.description=VirtualSink']);
        pacmd.stderr.on('data', d => log(`pactl stderr: ${d}`, 'DEBUG'));
        
        // Set this as default sink so Chrome uses it automatically
        spawn('pactl', ['set-default-sink', 'VirtualSink']);
        
    } catch (e) {
        log(`PulseAudio setup failed: ${e.message}`, 'WARN');
    }

    xvfbProcess = spawn('Xvfb', [DISPLAY_NUM, '-screen', '0', `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`]);
    
    xvfbProcess.stderr.on('data', (data) => {
        // Xvfb often outputs to stderr for info, so just debug log
        // log(`Xvfb: ${data}`, 'DEBUG');
    });

    // Give Xvfb a moment to start
    await new Promise(resolve => setTimeout(resolve, 2000));
}

async function startBrowser() {
    log(`Launching Puppeteer for ${DASHBOARD_URL}...`, 'INFO');
    
    browser = await puppeteer.launch({
        headless: false, // Important: must be false to render to Xvfb
        defaultViewport: null, // Let the window size dictate viewport
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-fullscreen',
            `--window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT}`,
            '--autoplay-policy=no-user-gesture-required',
            '--display=' + DISPLAY_NUM
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
    
    // Go to the URL
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });
    log('Page loaded.', 'SUCCESS');
    
    // Optional: Hide scrollbars or extra elements if needed
    await page.addStyleTag({ content: 'body { overflow: hidden; }' });
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
            '-draw_mouse 0' // Hide mouse cursor
        ])
        // Input: Grab PulseAudio monitor source
        // We capture from the monitor of our virtual sink
        .input('default') 
        .inputFormat('pulse')
        // .input('anullsrc') // Fallback if pulse fails
        // .inputFormat('lavfi')
        
        // Output options
        .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-maxrate', '3000k',
            '-bufsize', '6000k',
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
    
    // Cleanup
    if (ffmpegCommand) {
        try { ffmpegCommand.kill(); } catch (e) {}
        ffmpegCommand = null;
    }
    
    // We usually keep the browser running if just the stream dropped,
    // but if the browser crashed we might want to restart everything.
    // For simplicity, let's keep the browser open and just restart ffmpeg
    // unless the browser is disconnected.
    
    if (browser && !browser.isConnected()) {
        log('Browser disconnected. Full restart.', 'WARN');
        process.exit(1); // Let Docker/Supervisor restart the process
    }

    setTimeout(startStream, RECONNECT_DELAY);
}

async function main() {
    try {
        // Set DISPLAY env var for this process
        process.env.DISPLAY = DISPLAY_NUM;

        await startXvfb();
        await startBrowser();
        startStream();
    } catch (err) {
        log(`Fatal error during startup: ${err.message}`, 'ERROR');
        process.exit(1);
    }
}

// Cleanup on exit
process.on('SIGINT', async () => {
    log('Stopping...', 'INFO');
    if (ffmpegCommand) try { ffmpegCommand.kill(); } catch (e) {}
    if (browser) await browser.close();
    if (xvfbProcess) xvfbProcess.kill();
    process.exit(0);
});

main();
