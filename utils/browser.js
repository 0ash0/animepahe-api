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

const activeBrowsers = new Map(); // Map<proxyKey, activeBrowser>
const browserPromises = new Map(); // Map<proxyKey, browserPromise>
const refCounts = new Map(); // Map<proxyKey, count>
const closeTimeouts = new Map(); // Map<proxyKey, timeout>

/**
 * Launches or returns an existing Chromium browser instance for a specific proxy.
 * Implements a singleton pattern keyed by proxy to ensure IP consistency.
 * @param {string|null} proxy - The proxy URL to use (or null for no proxy)
 */
async function launchBrowser(proxy = null) {
    const proxyKey = proxy || 'no-proxy';
    
    // Increment reference count for this specific proxy
    const currentCount = refCounts.get(proxyKey) || 0;
    refCounts.set(proxyKey, currentCount + 1);
    
    // Clear any pending close timeout for this specific proxy
    const existingTimeout = closeTimeouts.get(proxyKey);
    if (existingTimeout) {
        clearTimeout(existingTimeout);
        closeTimeouts.delete(proxyKey);
    }

    // Return existing promise if already launching/launched
    if (browserPromises.has(proxyKey)) {
        return browserPromises.get(proxyKey);
    }

    const promise = (async () => {
        const isServerless = process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
        const isProduction = process.env.NODE_ENV === 'production';
        const isLinux = process.platform === 'linux';
        
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

        const defaultHeadless = (isServerless || isProduction || isLinux) ? true : false;

        const launchOptions = {
            headless: envHeadless === null ? defaultHeadless : envHeadless,
            args: isServerless ? [...baseArgs, ...serverlessArgs] : baseArgs,
            timeout: isServerless ? 30000 : 60000
        };

        // Add proxy if provided
        if (proxy) {
            // We use the same formatting as RequestManager
            const formatted = (proxy.startsWith('http://') || proxy.startsWith('https://') || proxy.startsWith('socks5://'))
                ? proxy 
                : 'http://' + proxy;
            
            try {
                const parsedUrl = new URL(formatted);
                launchOptions.proxy = {
                    server: `${parsedUrl.protocol}//${parsedUrl.host}`
                };
                if (parsedUrl.username) {
                    launchOptions.proxy.username = decodeURIComponent(parsedUrl.username);
                }
                if (parsedUrl.password) {
                    launchOptions.proxy.password = decodeURIComponent(parsedUrl.password);
                }
                console.log(`Configuring browser singleton with proxy: ${parsedUrl.host}`);
            } catch (e) {
                console.error(`Error parsing proxy for browser launch: ${e.message}`);
            }
        }

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

        console.log(`Launching browser singleton [${proxyKey}] with headless=${launchOptions.headless}`);
        
        try {
            const browser = await chromium.launch(launchOptions);
            activeBrowsers.set(proxyKey, browser);
            return browser;
        } catch (error) {
            console.error(`Failed to launch browser [${proxyKey}]:`, error);
            const fallbackOptions = {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            };
            const browser = await chromium.launch(fallbackOptions);
            activeBrowsers.set(proxyKey, browser);
            return browser;
        }
    })();

    browserPromises.set(proxyKey, promise);
    return promise;
}

/**
 * Decrements the reference count and closes the browser for a specific proxy if it reaches zero.
 * @param {string|null} proxy - The proxy URL used (or null for no proxy)
 */
async function closeBrowser(proxy = null) {
    const proxyKey = proxy || 'no-proxy';
    let currentCount = refCounts.get(proxyKey) || 0;
    currentCount--;
    
    if (currentCount <= 0) {
        currentCount = 0;
        refCounts.set(proxyKey, 0);
        
        // Clear any existing timeout
        if (closeTimeouts.has(proxyKey)) {
            clearTimeout(closeTimeouts.get(proxyKey));
        }
        
        const timeout = setTimeout(async () => {
            if ((refCounts.get(proxyKey) || 0) === 0 && activeBrowsers.has(proxyKey)) {
                console.log(`Closing browser singleton [${proxyKey}] (idle)`);
                const browserToClose = activeBrowsers.get(proxyKey);
                activeBrowsers.delete(proxyKey);
                browserPromises.delete(proxyKey);
                refCounts.delete(proxyKey);
                try {
                    await browserToClose.close();
                } catch (e) {
                    console.error(`Error closing browser [${proxyKey}]:`, e.message);
                }
            }
            closeTimeouts.delete(proxyKey);
        }, 5000);
        
        closeTimeouts.set(proxyKey, timeout);
    } else {
        refCounts.set(proxyKey, currentCount);
    }
}

module.exports = { launchBrowser, closeBrowser };