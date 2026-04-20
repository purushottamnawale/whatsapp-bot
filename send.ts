import { isLikelyPhoneTarget, normalizeNumber, parseBoolean, parsePositiveInt } from './methods';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const util = require('util');
require('dotenv').config();

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
}

const WA_SEND_TO = (args[0] || process.env.WA_SEND_TO || '').trim();
const message = args.length > 1
    ? args.slice(1).join(' ')
    : (process.env.WA_DEFAULT_PROMPT || 'Hello from terminal');

const WA_HEADLESS = String(process.env.WA_HEADLESS || 'true').toLowerCase() !== 'false';
const WA_AUTH_CLIENT_ID = process.env.WA_AUTH_CLIENT_ID || '';
const WA_USE_AI_RESPONSE = parseBoolean(process.env.WA_USE_AI_RESPONSE, true);
const WA_KEEP_ALIVE = parseBoolean(process.env.WA_KEEP_ALIVE, true);
const WA_AI_TIMEOUT_MS = parsePositiveInt(process.env.WA_AI_TIMEOUT_MS, 20000);
const DEFAULT_AI_FAILURE_MESSAGE = 'AI is temporarily unavailable. Please try again later.';
const WA_AI_FAILURE_MESSAGE = (process.env.WA_AI_FAILURE_MESSAGE || DEFAULT_AI_FAILURE_MESSAGE).trim() || DEFAULT_AI_FAILURE_MESSAGE;
const WA_INIT_DEBUG = parseBoolean(process.env.WA_INIT_DEBUG, true);
const WA_PUPPETEER_EXECUTABLE_PATH = (process.env.WA_PUPPETEER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
const WA_PUPPETEER_LAUNCH_TIMEOUT_MS = parsePositiveInt(process.env.WA_PUPPETEER_LAUNCH_TIMEOUT_MS, 120000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

if (!WA_SEND_TO) {
    console.error('Missing WA_SEND_TO (or first CLI argument).');
    printUsage();
    process.exit(1);
}

// Pre-normalize once so target resolution does not repeatedly parse the same number.
const sanitizedNumber = isLikelyPhoneTarget(WA_SEND_TO) ? normalizeNumber(WA_SEND_TO) : '';

function createClient() {
    const authOptions = WA_AUTH_CLIENT_ID ? { clientId: WA_AUTH_CLIENT_ID } : undefined;
    const executablePath = WA_PUPPETEER_EXECUTABLE_PATH;

    const puppeteerOptions: any = {
        headless: WA_HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--no-default-browser-check'
        ],
        timeout: WA_PUPPETEER_LAUNCH_TIMEOUT_MS
    };

    if (executablePath) {
        puppeteerOptions.executablePath = executablePath;
        logDebug('Using browser executable path:', executablePath);
    } else {
        logDebug('No browser executable path detected; using Puppeteer default browser resolution.');
    }

    return new Client({
        authStrategy: new LocalAuth(authOptions),
        puppeteer: puppeteerOptions
    });
}

let hasSent = false;

function logDebug(...parts) {
    if (!WA_INIT_DEBUG) {
        return;
    }
    const stamp = new Date().toISOString();
    console.log(`[debug ${stamp}]`, ...parts);
}

function printUsage() {
    console.log('Usage: npx tsx send.ts <send_to> <message>');
    console.log('Examples:');
    console.log('  npx tsx send.ts 1234567890 "Hello from server"');
    console.log('  npx tsx send.ts "Saved Messages" "Hello group/chat"');
    console.log('You can set WA_SEND_TO and WA_DEFAULT_PROMPT in .env for defaults.');
}

async function resolveTarget(client) {
    // Fast path: phone numbers can be sent directly via WhatsApp user JID.
    if (isLikelyPhoneTarget(WA_SEND_TO)) {
        if (!sanitizedNumber) {
            throw new Error(`Invalid phone target: ${WA_SEND_TO}`);
        }
        return {
            chatId: `${sanitizedNumber}@c.us`,
            label: `number ${sanitizedNumber}`
        };
    }

    const targetName = WA_SEND_TO;
    const chats = await client.getChats();

    // Prefer exact chat name match first to avoid wrong partial hits.
    const exactMatch = chats.find((chat) => {
        const chatName = String(chat.name || '').trim().toLowerCase();
        return chatName === targetName.toLowerCase();
    });

    if (exactMatch) {
        return {
            chatId: exactMatch.id._serialized,
            label: `chat/group "${exactMatch.name}"`
        };
    }

    const partialMatches = chats.filter((chat) => {
        const chatName = String(chat.name || '').trim().toLowerCase();
        return chatName.includes(targetName.toLowerCase());
    });

    if (partialMatches.length === 1) {
        const partialMatch = partialMatches[0];
        return {
            chatId: partialMatch.id._serialized,
            label: `chat/group "${partialMatch.name}"`
        };
    }

    if (partialMatches.length > 1) {
        const exampleNames = partialMatches
            .slice(0, 5)
            .map((chat) => chat.name)
            .join(', ');

        throw new Error(
            `Ambiguous chat/group name "${targetName}". Found ${partialMatches.length} matches. Use exact name. Example matches: ${exampleNames}`
        );
    }

    throw new Error(`Could not find chat/group with name: ${targetName}`);
}

function extractCandidateText(payload) {
    // Gemini may return multiple parts/candidates; merge them into a single outgoing message.

    return (payload?.candidates || [])
        .flatMap((candidate) => (candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : []))
        .map((part) => part.text || '')
        .join('\n')
        .trim();
}

async function generateAiMessage(promptText) {
    if (!GEMINI_API_KEY) {
        return {
            text: WA_AI_FAILURE_MESSAGE,
            isAi: false,
            reason: 'GEMINI_API_KEY is not set'
        };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WA_AI_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: [
                                    'Create WhatsApp-ready output based on the user prompt.',
                                    'If the prompt asks for a vocabulary list, strictly follow it and keep exactly requested count and fields.',
                                    'If a vocabulary list is requested, use different words each time and do not repeat excluded words.',
                                    'If no strict format is requested, write a short friendly message in simple English.',
                                    `Topic or prompt: ${promptText}`
                                ].join('\n')
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.7
                }
            }),
            signal: controller.signal
        });

        const payload: any = await response.json();
        if (!response.ok) {
            const errText = `Gemini API failed: ${response.status} ${util.inspect(payload, { depth: 3 })}`;
            console.error(errText);
            return {
                text: WA_AI_FAILURE_MESSAGE,
                isAi: false,
                reason: `Gemini API error ${response.status}`
            };
        }

        const aiText = extractCandidateText(payload);
        if (!aiText) {
            console.error('Gemini returned empty content, using plain message.');
            return {
                text: WA_AI_FAILURE_MESSAGE,
                isAi: false,
                reason: 'Gemini returned empty content'
            };
        }

        return {
            text: aiText,
            isAi: true,
            reason: ''
        };
    } catch (err) {
        console.error('AI generation failed, using plain message:', err && err.message ? err.message : err);
        return {
            text: WA_AI_FAILURE_MESSAGE,
            isAi: false,
            reason: err && err.message ? err.message : 'AI generation failed'
        };
    } finally {
        clearTimeout(timeout);
    }
}




function bindEvents(client) {
    client.on('change_state', (state) => {
        logDebug('Client state changed:', state);
    });

    client.on('loading_screen', (percent, messageText) => {
        logDebug(`Loading screen ${percent}%`, messageText || '');
    });

    client.on('qr', (qr) => {
        console.log('SCAN THIS QR CODE WITH YOUR PHONE:');
        qrcode.generate(qr, { small: true });
        logDebug('QR emitted. Waiting for phone scan/approval.');
    });

    client.on('authenticated', () => {
        console.log('WhatsApp authenticated.');
        logDebug('Authenticated event received.');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        logDebug('Auth failure payload:', msg);
    });

    client.on('disconnected', (reason) => {
        console.error('Client disconnected:', reason);
        logDebug('Disconnected event reason:', reason);
    });

    client.on('ready', async () => {
        if (hasSent) {
            return;
        }

        console.log('Client is ready!');

        try {
            const loggedInUser = client.info && client.info.wid ? client.info.wid.user : 'unknown';
            console.log('Logged in as WhatsApp number:', loggedInUser);

            const target = await resolveTarget(client);
            const chatId = target.chatId;
            console.log('Target:', target.label);

            const generated = WA_USE_AI_RESPONSE
                ? await generateAiMessage(message)
                : { text: message, isAi: false, reason: 'WA_USE_AI_RESPONSE is false' };
            const outgoingMessage = generated.text;

            if (WA_USE_AI_RESPONSE && generated.isAi) {
                console.log('Using AI-generated message content.');
            } else if (WA_USE_AI_RESPONSE && !generated.isAi) {
                console.log(`Using plain message fallback (${generated.reason}).`);
            }

            console.log('Outgoing message text:');
            console.log('---');
            console.log(outgoingMessage);
            console.log('---');


            let sentMessage;
            try {
                sentMessage = await client.sendMessage(chatId, outgoingMessage);
            } catch (primaryErr) {
                // Transient web session hiccups happen; one quick retry improves reliability.
                console.error('Primary send failed, retrying after short delay...');
                await new Promise((resolve) => setTimeout(resolve, 2000));
                sentMessage = await client.sendMessage(chatId, outgoingMessage);
                if (primaryErr) {
                    console.error('Primary error detail:', primaryErr.stack || util.inspect(primaryErr, { depth: 5 }));
                }
            }

            hasSent = true;
            console.log('Message sent successfully to', target.label);
            if (sentMessage && sentMessage.id && sentMessage.id._serialized) {
                console.log('Message id:', sentMessage.id._serialized);
            }
            console.log('Target chat id:', chatId);

        } catch (err) {
            console.error('Failed to send message:', err && err.message ? err.message : err);
            console.error('Error stack/detail:', err && err.stack ? err.stack : util.inspect(err, { depth: 6 }));
        } finally {
            if (hasSent) {
                if (WA_KEEP_ALIVE) {
                    console.log('Keeping WhatsApp session alive. Press Ctrl+C to stop.');
                    return;
                }
                process.exit(0);
            }

            try {
                await client.destroy();
            } catch (destroyErr) {
                console.error('Destroy error:', destroyErr && destroyErr.message ? destroyErr.message : destroyErr);
            }
            process.exit(1);
        }
    });
}

const client = createClient();
bindEvents(client);

logDebug('Calling client.initialize() now.');
client.initialize();
