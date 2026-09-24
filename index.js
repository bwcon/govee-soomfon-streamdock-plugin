const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

let websocket = null;
let pluginUUID = null;
let globalSettings = {};
let contexts = {}; // map context -> settings
let stateCache = {}; // map device -> {power, brightness, color, lastFetch}

// Debounce map for dial rotation
let dialDebounce = {};

function log(msg) {
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(__dirname, 'debug.log'), `[${ts}] [Govee] ${msg}\n`);
    console.log(`[Govee] ${msg}`);
}

function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info) {
    pluginUUID = uuid;
    websocket = new WebSocket(`ws://127.0.0.1:${port}`);

    websocket.on('open', () => {
        websocket.send(JSON.stringify({
            event: registerEvent,
            uuid: pluginUUID
        }));
        websocket.send(JSON.stringify({
            event: "getGlobalSettings",
            context: pluginUUID
        }));
    });

    websocket.on('message', (message) => {
        const payload = JSON.parse(message);
        const event = payload.event;
        const context = payload.context;
        const action = payload.action;

        if (event === "didReceiveGlobalSettings") {
            globalSettings = payload.payload.settings;
        } else if (event === "willAppear") {
            contexts[context] = payload.payload.settings;
            contexts[context].action = action;
            updateDeviceState(context);
        } else if (event === "willDisappear") {
            delete contexts[context];
        } else if (event === "didReceiveSettings") {
            contexts[context] = payload.payload.settings;
            contexts[context].action = action;
            updateDeviceState(context);
        } else if (event === "sendToPlugin") {
            if (payload.payload && payload.payload.command === "fetchDevices") {
                // Update global API key if provided
                if (payload.payload.apiKey) {
                    globalSettings.apiKey = payload.payload.apiKey;
                    websocket.send(JSON.stringify({
                        event: "setGlobalSettings",
                        context: pluginUUID,
                        payload: globalSettings
                    }));
                }
                
                requestGovee('GET', '/devices').then(res => {
                    log(`Fetch devices response: ${JSON.stringify(res)}`);
                    if (res && res.data && res.data.devices) {
                        websocket.send(JSON.stringify({
                            event: "sendToPropertyInspector",
                            context: context,
                            payload: { command: "deviceList", devices: res.data.devices }
                        }));
                    } else {
                        websocket.send(JSON.stringify({
                            event: "sendToPropertyInspector",
                            context: context,
                            payload: { command: "fetchError", message: res.message || "Failed to fetch devices" }
                        }));
                    }
                }).catch(e => {
                    websocket.send(JSON.stringify({
                        event: "sendToPropertyInspector",
                        context: context,
                        payload: { command: "fetchError", message: String(e) }
                    }));
                });
            }
        } else if (event === "keyUp" || event === "touchTap") {
            handleAction(context, action, payload.payload.settings);
        } else if (event === "dialRotate") {
            handleDial(context, payload.payload.settings, payload.payload.ticks);
        } else if (event === "dialDown") {
            handleAction(context, action, payload.payload.settings);
        }
    });
}

function getApiKey() {
    return globalSettings.apiKey || "";
}

function requestGovee(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        if (!apiKey) {
            reject("No API Key");
            return;
        }

        const options = {
            hostname: 'developer-api.govee.com',
            port: 443,
            path: `/v1${endpoint}`,
            method: method,
            headers: {
                'Govee-API-Key': apiKey,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch(e) {
                    resolve({code: res.statusCode, data});
                }
            });
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function controlDevice(device, model, cmdName, cmdValue) {
    try {
        const res = await requestGovee('PUT', '/devices/control', {
            device: device,
            model: model,
            cmd: { name: cmdName, value: cmdValue }
        });
        if (res.code === 200) {
            // Optimistic cache update
            if (!stateCache[device]) stateCache[device] = {};
            if (cmdName === 'turn') stateCache[device].powerState = cmdValue;
            if (cmdName === 'brightness') stateCache[device].brightness = cmdValue;
            if (cmdName === 'color') stateCache[device].color = cmdValue;
        }
    } catch(e) {
        log(`Control error: ${e}`);
    }
}

async function getDeviceState(device, model) {
    if (stateCache[device] && (Date.now() - stateCache[device].lastFetch < 10000)) {
        return stateCache[device];
    }
    try {
        const res = await requestGovee('GET', `/devices/state?device=${encodeURIComponent(device)}&model=${encodeURIComponent(model)}`);
        if (res.code === 200 && res.data && res.data.properties) {
            let state = { lastFetch: Date.now() };
            res.data.properties.forEach(p => {
                if (p.powerState) state.powerState = p.powerState;
                if (p.brightness !== undefined) state.brightness = p.brightness;
                if (p.color) state.color = p.color;
            });
            stateCache[device] = state;
            return state;
        }
    } catch(e) {
        log(`State error: ${e}`);
    }
    return null;
}

async function handleAction(context, action, settings) {
    const devices = settings.devices || [];
    if (devices.length === 0) return;

    if (action === "com.soomfon.govee.power" || action === "com.soomfon.govee.dial") {
        const state = await getDeviceState(devices[0].device, devices[0].model);
        const targetState = (state && state.powerState === "on") ? "off" : "on";
        
        for (let dev of devices) {
            await controlDevice(dev.device, dev.model, "turn", targetState);
        }
    } else if (action === "com.soomfon.govee.color") {
        let hex = settings.color || "#FF0000";
        let r = parseInt(hex.substr(1,2), 16);
        let g = parseInt(hex.substr(3,2), 16);
        let b = parseInt(hex.substr(5,2), 16);
        
        for (let dev of devices) {
            await controlDevice(dev.device, dev.model, "color", {r,g,b});
        }
    } else if (action === "com.soomfon.govee.brightness") {
        let br = parseInt(settings.brightness || "100");
        for (let dev of devices) {
            await controlDevice(dev.device, dev.model, "brightness", br);
        }
    }

    setTimeout(() => updateDeviceState(context), 500);
}

function handleDial(context, settings, ticks) {
    const devices = settings.devices || [];
    if (devices.length === 0) return;

    if (!dialDebounce[context]) dialDebounce[context] = { value: 0, timer: null };
    
    // Accumulate ticks
    dialDebounce[context].value += (ticks * 5); // 5% per tick

    if (dialDebounce[context].timer) clearTimeout(dialDebounce[context].timer);

    dialDebounce[context].timer = setTimeout(async () => {
        const state = await getDeviceState(devices[0].device, devices[0].model);
        let currentBr = (state && state.brightness) ? state.brightness : 50;
        let newBr = currentBr + dialDebounce[context].value;
        if (newBr > 100) newBr = 100;
        if (newBr < 1) newBr = 1;
        
        dialDebounce[context].value = 0; // reset

        for (let dev of devices) {
            await controlDevice(dev.device, dev.model, "brightness", newBr);
        }
        updateDeviceState(context);
    }, 300);
}

async function updateDeviceState(context) {
    const settings = contexts[context];
    if (!settings) return;
    const devices = settings.devices || [];
    if (devices.length === 0) return;

    // Use the first device's state to represent the button
    const state = await getDeviceState(devices[0].device, devices[0].model);
    if (!state) return;

    const action = settings.action;
    let bgColor = "#1e1e1e"; // default off
    if (state.powerState === "on") {
        if (state.color) {
            bgColor = `rgb(${state.color.r}, ${state.color.g}, ${state.color.b})`;
        } else {
            bgColor = "#f39c12"; // warm on
        }
    }

    // Paint dynamic SVG to key/dial
    const isDial = (action === "com.soomfon.govee.dial");
    const svg = generateSVG(state.powerState, state.brightness || 0, bgColor, isDial);
    
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            event: "setImage",
            context: context,
            payload: {
                image: "data:image/svg+xml;charset=utf8," + encodeURIComponent(svg),
                target: 0,
                state: 0
            }
        }));

        if (isDial) {
            websocket.send(JSON.stringify({
                event: "setFeedback",
                context: context,
                payload: {
                    title: `Br: ${state.brightness || 0}%`,
                    value: state.powerState === "on" ? "ON" : "OFF",
                    icon: "data:image/svg+xml;charset=utf8," + encodeURIComponent(svg)
                }
            }));
        }
    }
}

function generateSVG(power, brightness, color, isDial) {
    const w = isDial ? 200 : 144;
    const h = isDial ? 100 : 144;
    const opacity = power === "on" ? 1.0 : 0.3;
    
    const cx = w/2;
    const cy = h/2 - (isDial ? 0 : 15);
    const r = isDial ? 35 : 38;
    
    // Smooth modern gradient ring design for Govee
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${w}" height="${h}" fill="#0f0f0f" rx="15"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${opacity}"/>
        ${power === "on" ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.6"/>` : ""}
        
        <g transform="translate(${cx - 12}, ${cy - 12}) scale(1.0)" opacity="${opacity}">
            <path fill="#ffffff" d="M12,2C8.13,2 5,5.13 5,9c0,2.38 1.19,4.47 3,5.74V17c0,0.55 0.45,1 1,1h6c0.55,0 1,-0.45 1,-1v-2.26c1.81,-1.27 3,-3.36 3,-5.74C19,5.13 15.87,2 12,2z M14,15h-4v-1h4V15z M14,13h-4v-1h4V13z M12,22c1.1,0 2,-0.9 2,-2h-4C10,21.1 10.9,22 12,22z"/>
        </g>

        <text x="${w/2}" y="${h - 12}" font-family="Arial, sans-serif" font-size="${isDial ? 14 : 16}" font-weight="bold" fill="#ffffff" text-anchor="middle" opacity="${opacity}">${power === "on" ? brightness + '%' : 'OFF'}</text>
    </svg>`;
}

// Global scope initialization trick for Node 20 StreamDock environments
if (typeof process !== 'undefined') {
    const args = process.argv;
    let port = 0, uuid = "", registerEvent = "", info = "";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-port") port = args[i + 1];
        if (args[i] === "-pluginUUID") uuid = args[i + 1];
        if (args[i] === "-registerEvent") registerEvent = args[i + 1];
        if (args[i] === "-info") info = args[i + 1];
    }
    if (port && uuid) {
        connectElgatoStreamDeckSocket(port, uuid, registerEvent, info);
    }
}
