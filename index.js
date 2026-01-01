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
        // Kill existing and start with flags for root/docker
        spawn('pulseaudio', ['-k']);
        const pa = spawn('pulseaudio', [
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
        log('PulseAudio VirtualSink initialized.', 'SUCCESS');
        
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
        headless: false,
        defaultViewport: null,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--display=' + DISPLAY_NUM,
            '--incognito',
            '--kiosk', // Fullscreen mode without any browser UI (no tabs, no address bar)
            '--disable-infobars', // Hides the "Chrome is being controlled..." message
            '--window-size=' + SCREEN_WIDTH + ',' + SCREEN_HEIGHT,
            '--autoplay-policy=no-user-gesture-required',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-accelerated-video-decode',
            '--force-wave-audio', // Force audio device
            '--autoplay-policy=no-user-gesture-required',
        ]
    });

    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    
    // Spoof User Agent to look like a standard Windows PC
    // This often forces websites to serve standard MP4/H.264 video instead of weird formats
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.setViewport({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
    await page.setViewport({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
    
    // Go to the URL
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });
    log('Page loaded.', 'SUCCESS');

    // CLICK to ensure audio starts (Autoplay policy often requires interaction)
    try {
        await new Promise(r => setTimeout(r, 2000)); // Wait a bit for video to load
        await page.mouse.click(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
        log('Clicked center screen to trigger audio.', 'INFO');
    } catch (e) {
        log('Click failed: ' + e.message, 'WARN');
    }
    
    // Aggressive CSS Injection to fix layout
    await page.addStyleTag({ content: `
        body { 
            overflow: hidden !important;
            margin: 0 !important;
            padding: 0 !important;
            transform-origin: center top;
        }
        /* Hide scrollbars completely */
        ::-webkit-scrollbar { 
            display: none !important; 
        }
    `});

    // Scroll down 
    await page.evaluate(() => {
        window.scrollBy(0, 250);
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
            '-draw_mouse 0' // Hide mouse cursor
        ])
        // Use video filter to crop out the browser UI (URL bar, tabs)
        // Crop width=1280, height=590 (remove top 130px), start at x=0, y=130
        .complexFilter([
            `crop=w=${SCREEN_WIDTH}:h=${SCREEN_HEIGHT - 130}:x=0:y=130[cropped]`,
            `[cropped]scale=${SCREEN_WIDTH}:${SCREEN_HEIGHT}[outv]`
        ], ['outv'])
        
        // Input: Grab PulseAudio monitor source
        // We use the monitor of our virtual sink explicitly
        .input('VirtualSink.monitor') 
        .inputFormat('pulse')
        
        // Output options
        .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'veryfast', // 'ultrafast' is faster but uses more bandwidth. 'veryfast' is good balance.
            '-tune', 'zerolatency', // Optimize for low latency streaming
            '-maxrate', '2500k',  // Lower bitrate slightly to ensure stability
            '-bufsize', '5000k',
            '-pix_fmt', 'yuv420p',
            '-g', '60', // Keyframe interval (2s at 30fps)
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
