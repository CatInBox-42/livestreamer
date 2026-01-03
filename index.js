require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const puppeteer = require('puppeteer');
const { spawn, execSync } = require('child_process');

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
const SCREEN_WIDTH = 1500;   // Slightly narrower
const SCREEN_HEIGHT = 900;   // 16:9 aspect ratio
const DISPLAY_NUM = ':99';

// Crop settings (adjust these as needed)
const CROP_TOP = 150;     // Pixels to remove from top
const CROP_BOTTOM = 80;   // Pixels to remove from bottom
const CROP_LEFT = 25;     // Pixels to remove from left (was 15, increased to remove white line)
const SCROLL_DOWN = 210;  // Pixels to scroll down on page

let ffmpegCommand = null;
let browser = null;
let xvfbProcess = null;

function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
}

async function startXvfb() {
    log('Starting Xvfb...', 'INFO');
    
    // Start PulseAudio FIRST (before Xvfb)
    log('Starting PulseAudio...', 'INFO');
    try {
        // Kill any existing PulseAudio
        try {
            execSync('pulseaudio -k 2>/dev/null || true');
        } catch (e) {
            // Ignore if pulseaudio wasn't running
        }
        
        // Wait a moment
        await new Promise(r => setTimeout(r, 500));
        
        // Start PulseAudio daemon
        const pa = spawn('pulseaudio', [
            '-D',                    // Daemonize
            '--exit-idle-time=-1',   // Never exit
            '--disallow-exit',       // Don't allow exit
            '--system=false',        // User mode
        ]);
        
        pa.on('error', (err) => log(`PulseAudio spawn error: ${err.message}`, 'ERROR'));
        
        // Wait for PulseAudio to fully start
        await new Promise(r => setTimeout(r, 2000));
        
        // Create Virtual Sink for capturing browser audio
        try {
            execSync('pactl load-module module-null-sink sink_name=VirtualSink sink_properties=device.description=VirtualSink');
            log('Created VirtualSink', 'SUCCESS');
        } catch (e) {
            log('VirtualSink may already exist: ' + e.message, 'WARN');
        }
        
        await new Promise(r => setTimeout(r, 500));
        
        // Set VirtualSink as default so Chrome uses it
        try {
            execSync('pactl set-default-sink VirtualSink');
            execSync('pactl set-sink-mute VirtualSink 0');
            execSync('pactl set-sink-volume VirtualSink 100%');
            log('Set VirtualSink as default with 100% volume', 'SUCCESS');
        } catch (e) {
            log('Failed to set default sink: ' + e.message, 'WARN');
        }
        
        // List sinks to verify (for debugging)
        try {
            const sinks = execSync('pactl list short sinks').toString();
            log('Available sinks: ' + sinks.trim(), 'DEBUG');
        } catch (e) {
            log('Could not list sinks', 'WARN');
        }
        
        log('PulseAudio VirtualSink initialized.', 'SUCCESS');
        
    } catch (e) {
        log(`PulseAudio setup failed: ${e.message}`, 'ERROR');
    }

    // Now start Xvfb
    xvfbProcess = spawn('Xvfb', [DISPLAY_NUM, '-screen', '0', `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`]);
    
    xvfbProcess.on('error', (err) => log(`Xvfb error: ${err.message}`, 'ERROR'));
    
    // Give Xvfb a moment to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    log('Xvfb started on display ' + DISPLAY_NUM, 'SUCCESS');
}

async function startBrowser() {
    log(`Launching Puppeteer for ${DASHBOARD_URL}...`, 'INFO');
    
    browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: '/tmp/puppeteer_fresh_profile_' + Date.now(), // Fresh profile every time (no cookies/cache)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--display=' + DISPLAY_NUM,
            '--incognito',
            '--kiosk',
            '--disable-infobars',
            '--window-size=' + SCREEN_WIDTH + ',' + SCREEN_HEIGHT,
            '--autoplay-policy=no-user-gesture-required',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-accelerated-video-decode',
            '--disable-extensions',           // No extensions
            '--disable-default-apps',         // No default apps
            '--no-first-run',                 // Skip first run wizards
            '--disable-background-networking' // Disable background stuff
        ]
    });

    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    
    // Spoof User Agent to look like a standard Windows PC
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.setViewport({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT });
    
    // Go to the URL
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });
    log('Page loaded.', 'SUCCESS');

    // Do a HARD refresh to bypass any cache (like Ctrl+F5)
    await page.evaluate(() => {
        location.reload(true); // true = force reload from server
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    log('Hard refresh completed.', 'SUCCESS');

    // Wait a bit for any videos to initialize, then click to trigger audio
    await new Promise(r => setTimeout(r, 2000));
    
    try {
        await page.mouse.click(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
        log('Clicked center screen to trigger audio.', 'INFO');
    } catch (e) {
        log('Click failed: ' + e.message, 'WARN');
    }
    
    // CSS to hide scrollbars
    await page.addStyleTag({ content: `
        body { 
            overflow: hidden !important;
            margin: 0 !important;
            padding: 0 !important;
        }
        ::-webkit-scrollbar { 
            display: none !important; 
        }
    `});

    // Scroll down 
    await page.evaluate((scrollAmount) => {
        window.scrollBy(0, scrollAmount);
    }, SCROLL_DOWN);
    log(`Scrolled down ${SCROLL_DOWN}px.`, 'INFO');
}

function startStream() {
    log('Starting FFmpeg stream...', 'INFO');
    log(`Source: X11 Display ${DISPLAY_NUM}`);
    log(`Target: ${RTMP_URL} (Key hidden)`);
    log(`Crop: top=${CROP_TOP}px, left=${CROP_LEFT}px`);

    // Calculate crop dimensions
    const cropWidth = SCREEN_WIDTH - CROP_LEFT;
    const cropHeight = SCREEN_HEIGHT - CROP_TOP - CROP_BOTTOM;
    const cropFilter = `crop=${cropWidth}:${cropHeight}:${CROP_LEFT}:${CROP_TOP},scale=${SCREEN_WIDTH}:${SCREEN_HEIGHT}`;

    ffmpegCommand = ffmpeg()
        // Video Input: X11 display
        .input(DISPLAY_NUM)
        .inputFormat('x11grab')
        .inputOptions([
            '-thread_queue_size', '1024',  // ADDED: Prevent video queue blocking
            `-video_size ${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
            '-framerate 24',
            '-draw_mouse 0'
        ])
        
        // Audio Input: PulseAudio VirtualSink monitor
        .input('VirtualSink.monitor')
        .inputFormat('pulse')
        .inputOptions([
            '-thread_queue_size', '1024'   // ADDED: Prevent audio queue blocking (was 8, now 1024)
        ])
        
        // Output options - OPTIMIZED FOR LOW CPU (small VPS)
        .outputOptions([
            '-vf', cropFilter,           // Video filter for cropping (does NOT affect audio)
            '-c:v', 'libx264',
            '-preset', 'ultrafast',      // CHANGED: ultrafast uses least CPU
            '-tune', 'zerolatency',
            '-crf', '28',                // ADDED: Quality-based encoding (28 = decent quality, less CPU)
            '-maxrate', '1500k',         // REDUCED: from 2500k to 1500k
            '-bufsize', '3000k',         // REDUCED: from 5000k to 3000k
            '-pix_fmt', 'yuv420p',
            '-g', '60',
            '-threads', '1',             // ADDED: Limit threads for small VPS
            '-c:a', 'aac',               // Audio codec
            '-b:a', '96k',               // REDUCED: from 128k to 96k
            '-ar', '44100',              // Audio sample rate
            '-ac', '2',                  // Audio channels (stereo)
            '-f', 'flv'
        ])
        .output(FULL_RTMP_URL)
        
        .on('start', (cmd) => {
            log('Streaming started!', 'SUCCESS');
            log(`Command: ${cmd}`, 'DEBUG');
        })
        .on('stderr', (stderrLine) => {
            // Log FFmpeg output for debugging audio issues
            if (stderrLine.includes('audio') || stderrLine.includes('pulse')) {
                log(`FFmpeg: ${stderrLine}`, 'DEBUG');
            }
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
