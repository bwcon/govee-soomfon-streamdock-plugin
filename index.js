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

log("Plugin started!");

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
                
                log("Fetching devices...");
                
                // Try v2 first
                requestGovee('GET', true, '/user/devices').then(resV2 => {
                    log(`Fetch v2 response: ${JSON.stringify(resV2)}`);
                    let devices = [];
                    if (resV2 && resV2.code === 200 && Array.isArray(resV2.data)) {
                        devices = resV2.data.map(d => ({ device: d.device, model: d.sku, deviceName: d.deviceName, apiVersion: 2 }));
                    }

                    if (devices.length > 0) {
                        websocket.send(JSON.stringify({
                            event: "sendToPropertyInspector", context: context,
                            payload: { command: "deviceList", devices: devices }
                        }));
                    } else {
                        // Fallback to v1
                        log("v2 returned no devices, trying v1...");
                        requestGovee('GET', false, '/devices').then(resV1 => {
                            log(`Fetch v1 response: ${JSON.stringify(resV1)}`);
                            if (resV1 && resV1.code === 200 && resV1.data && resV1.data.devices) {
                                let devV1 = resV1.data.devices.map(d => ({ device: d.device, model: d.model, deviceName: d.deviceName, apiVersion: 1 }));
                                websocket.send(JSON.stringify({
                                    event: "sendToPropertyInspector", context: context,
                                    payload: { command: "deviceList", devices: devV1 }
                                }));
                            } else {
                                let msg = (resV2.message || resV2.code) + " (v2); " + (resV1.message || resV1.code) + " (v1)";
                                sendPropertyInspectorError(context, "API Error: " + msg);
                            }
                        }).catch(e => sendPropertyInspectorError(context, String(e)));
                    }
                }).catch(e => {
                    log("v2 fetch threw, trying v1... " + e);
                    requestGovee('GET', false, '/devices').then(resV1 => {
                        if (resV1 && resV1.code === 200 && resV1.data && resV1.data.devices) {
                            let devV1 = resV1.data.devices.map(d => ({ device: d.device, model: d.model, deviceName: d.deviceName, apiVersion: 1 }));
                            websocket.send(JSON.stringify({
                                event: "sendToPropertyInspector", context: context,
                                payload: { command: "deviceList", devices: devV1 }
                            }));
                        } else {
                            sendPropertyInspectorError(context, "API Error: " + (resV1.message || resV1.code));
                        }
                    }).catch(e2 => sendPropertyInspectorError(context, String(e2)));
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

function requestGovee(method, isV2, endpoint, body = null) {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        if (!apiKey) {
            reject("No API Key");
            return;
        }

        const options = {
            hostname: isV2 ? 'openapi.api.govee.com' : 'developer-api.govee.com',
            port: 443,
            path: isV2 ? `/router/api/v1${endpoint}` : `/v1${endpoint}`,
            method: method,
            timeout: 5000,
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

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("Request timed out"));
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function sendPropertyInspectorError(context, msg) {
    if (websocket) {
        websocket.send(JSON.stringify({
            event: "sendToPropertyInspector",
            context: context,
            payload: { command: "fetchError", message: msg }
        }));
    }
}

async function controlDevice(dev, cmdName, cmdValue) {
    const isV2 = dev.apiVersion === 2;
    try {
        if (isV2) {
            // Map v1 commands to v2 capabilities
            let type = "", instance = "", val = cmdValue;
            if (cmdName === 'turn') {
                type = "devices.capabilities.on_off";
                instance = "powerSwitch";
                val = cmdValue === "on" ? 1 : 0;
            } else if (cmdName === 'brightness') {
                type = "devices.capabilities.work_mode";
                instance = "workMode"; // Actually it's range for brightness
                // Wait, brightness in v2 is:
                type = "devices.capabilities.range";
                instance = "brightness";
            } else if (cmdName === 'color') {
                type = "devices.capabilities.color_setting";
                instance = "colorRgb";
                // v2 wants integer rgb value or obj? v2 colorRgb: value: 16711680 (integer)
                val = (cmdValue.r << 16) | (cmdValue.g << 8) | cmdValue.b;
            }

            const payload = {
                requestId: "uuid",
                payload: {
                    sku: dev.model,
                    device: dev.device,
                    capability: { type: type, instance: instance, value: val }
                }
            };
            const res = await requestGovee('POST', true, '/device/control', payload);
            if (res.code === 200) updateCacheOptimistic(dev.device, cmdName, cmdValue);
        } else {
            const res = await requestGovee('PUT', false, '/devices/control', {
                device: dev.device,
                model: dev.model,
                cmd: { name: cmdName, value: cmdValue }
            });
            if (res.code === 200) updateCacheOptimistic(dev.device, cmdName, cmdValue);
        }
    } catch(e) {
        log(`Control error: ${e}`);
    }
}

function updateCacheOptimistic(deviceId, cmdName, cmdValue) {
    if (!stateCache[deviceId]) stateCache[deviceId] = {};
    if (cmdName === 'turn') stateCache[deviceId].powerState = cmdValue;
    if (cmdName === 'brightness') stateCache[deviceId].brightness = cmdValue;
    if (cmdName === 'color') stateCache[deviceId].color = cmdValue;
}

async function getDeviceState(dev) {
    if (stateCache[dev.device] && (Date.now() - stateCache[dev.device].lastFetch < 10000)) {
        return stateCache[dev.device];
    }
    const isV2 = dev.apiVersion === 2;
    try {
        if (isV2) {
            const res = await requestGovee('POST', true, '/device/state', {
                requestId: "uuid",
                payload: { sku: dev.model, device: dev.device }
            });
            if (res.code === 200 && res.payload && res.payload.capabilities) {
                let state = { lastFetch: Date.now() };
                res.payload.capabilities.forEach(c => {
                    if (c.instance === 'powerSwitch') state.powerState = c.state.value === 1 ? "on" : "off";
                    if (c.instance === 'brightness') state.brightness = c.state.value;
                    if (c.instance === 'colorRgb') {
                        let v = c.state.value;
                        state.color = { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
                    }
                });
                stateCache[dev.device] = state;
                return state;
            }
        } else {
            const res = await requestGovee('GET', false, `/devices/state?device=${encodeURIComponent(dev.device)}&model=${encodeURIComponent(dev.model)}`);
            if (res.code === 200 && res.data && res.data.properties) {
                let state = { lastFetch: Date.now() };
                res.data.properties.forEach(p => {
                    if (p.powerState) state.powerState = p.powerState;
                    if (p.brightness !== undefined) state.brightness = p.brightness;
                    if (p.color) state.color = p.color;
                });
                stateCache[dev.device] = state;
                return state;
            }
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
        const state = await getDeviceState(devices[0]);
        const targetState = (state && state.powerState === "on") ? "off" : "on";
        
        for (let dev of devices) {
            await controlDevice(dev, "turn", targetState);
        }
    } else if (action === "com.soomfon.govee.color") {
        let hex = settings.color || "#FF0000";
        let r = parseInt(hex.substr(1,2), 16);
        let g = parseInt(hex.substr(3,2), 16);
        let b = parseInt(hex.substr(5,2), 16);
        
        for (let dev of devices) {
            await controlDevice(dev, "color", {r,g,b});
        }
    } else if (action === "com.soomfon.govee.brightness") {
        let br = parseInt(settings.brightness || "100");
        for (let dev of devices) {
            await controlDevice(dev, "brightness", br);
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
        const state = await getDeviceState(devices[0]);
        let currentBr = (state && state.brightness) ? state.brightness : 50;
        let newBr = currentBr + dialDebounce[context].value;
        if (newBr > 100) newBr = 100;
        if (newBr < 1) newBr = 1;
        
        dialDebounce[context].value = 0; // reset

        for (let dev of devices) {
            await controlDevice(dev, "brightness", newBr);
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
    const state = await getDeviceState(devices[0]);
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
