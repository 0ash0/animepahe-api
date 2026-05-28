const fs = require('fs/promises');
const path = require('path');
const { existsSync } = require('fs');
const os = require('os');
// const config = require('../utils/config');

let chromiumBinary = null;
let chromium = null;
let useServerlessChromium = false;
let playwrightExtraAvailable = false;

// Try to load playwright-extra and stealth plugin if installed and opt-in via USE_STEALTH
// Setting USE_STEALTH=true enables playwright-extra + stealth plugin. Otherwise we keep
// the original Playwright loading behavior.
if (String(process.env.USE_STEALTH).toLowerCase() === 'true') {
    try {
        const playwrightExtra = require('playwright-extra');
        const stealth = require('playwright-extra-plugin-stealth')();
        // Use playwright-extra's chromium and register stealth plugin
        chromium = playwrightExtra.chromium;
        chromium.use(stealth);
        playwrightExtraAvailable = true;
        console.log('Using playwright-extra with stealth plugin (USE_STEALTH=true)');
    } catch (err) {
        console.warn('USE_STEALTH=true but playwright-extra or stealth plugin not installed; falling back to regular Playwright');
    }
}

try {
    // Load serverless-compatible Chromium binary and core playwright if not set
    chromiumBinary = require('@sparticuz/chromium');

    // If we didn't already set chromium via playwright-extra, try playwright-core
    if (!chromium) chromium = require('playwright-core').chromium;

    // Only use serverless chromium on Linux
    if (os.platform() === 'linux') {
        useServerlessChromium = true;
    } else {
        console.warn('⚠️ Detected non-Linux OS. Disabling @sparticuz/chromium for local dev.');
    }
} catch (e) {
    // Fallback to full Playwright (e.g. local dev) if not already set
    if (!chromium) {
        console.warn('Falling back to full Playwright (probably running locally)');
        chromium = require('playwright').chromium;
    }
}

let activeBrowser = null;
let browserPromise = null;
let refCount = 0;
let closeTimeout = null;

/**
 * Launches or returns the existing Chromium browser instance.
 * Implements a singleton pattern with reference counting.
 */
async function launchBrowser() {
    refCount++;
    
    // Clear any pending close timeout since we now have an active requester
    if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
    }

    if (browserPromise) {
        return browserPromise;
    }

    browserPromise = (async () => {
        const isServerless = process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
        
        const baseArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-infobars',
            '--disable-notifications',
            '--disable-offline-sync',
            '--disable-sync',
            '--disable-translate',
            '--no-first-run',
            '--no-zygote'
        ];

        const serverlessArgs = [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-domain-reliability',
            '--disable-component-extensions-with-background-pages',
            '--memory-pressure-off',
            '--max_old_space_size=4096'
        ];

        const envHeadless = typeof process.env.CHROME_HEADLESS !== 'undefined'
            ? String(process.env.CHROME_HEADLESS).toLowerCase() === 'true'
            : null;

        const defaultHeadless = isServerless ? true : false;

        const launchOptions = {
            headless: envHeadless === null ? defaultHeadless : envHeadless,
            args: isServerless ? [...baseArgs, ...serverlessArgs] : baseArgs,
            timeout: isServerless ? 30000 : 60000
        };

        launchOptions.args.push(
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        if (useServerlessChromium && chromiumBinary) {
            try {
                const executablePath = await chromiumBinary.executablePath();
                if (existsSync(executablePath)) {
                    launchOptions.executablePath = executablePath;
                    launchOptions.args = [...chromiumBinary.args, ...launchOptions.args];
                }
            } catch (error) {
                console.error('Error setting up serverless Chromium:', error);
            }
        }

        console.log('Launching browser singleton with headless=%s', launchOptions.headless);
        
        try {
            activeBrowser = await chromium.launch(launchOptions);
            return activeBrowser;
        } catch (error) {
            console.error('Failed to launch browser:', error);
            const fallbackOptions = {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            };
            activeBrowser = await chromium.launch(fallbackOptions);
            return activeBrowser;
        }
    })();

    return browserPromise;
}

/**
 * Decrements the reference count and closes the browser if it reaches zero.
 * Includes a small delay before closing to handle rapid successive requests.
 */
async function closeBrowser() {
    refCount--;
    
    if (refCount <= 0) {
        refCount = 0; // Prevent negative
        
        // Wait 5 seconds before closing to see if new requests come in
        // This is efficient for batch processing
        if (closeTimeout) clearTimeout(closeTimeout);
        
        closeTimeout = setTimeout(async () => {
            if (refCount === 0 && activeBrowser) {
                console.log('Closing browser singleton (idle)');
                const browserToClose = activeBrowser;
                activeBrowser = null;
                browserPromise = null;
                try {
                    await browserToClose.close();
                } catch (e) {
                    console.error('Error closing browser:', e.message);
                }
            }
            closeTimeout = null;
        }, 5000);
    }
}

module.exports = { launchBrowser, closeBrowser };