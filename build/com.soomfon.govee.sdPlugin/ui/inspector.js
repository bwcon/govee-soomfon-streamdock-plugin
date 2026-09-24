let websocket = null;
let pluginUUID = null;
let actionContext = null;
let globalSettings = {};
let actionSettings = {};
let actionInfo = {};

const apiKeyInput = document.getElementById('apiKey');
const fetchBtn = document.getElementById('fetchBtn');
const deviceList = document.getElementById('deviceList');
const statusMsg = document.getElementById('statusMsg');
const colorBlock = document.getElementById('colorBlock');
const brightnessBlock = document.getElementById('brightnessBlock');

const targetColor = document.getElementById('targetColor');
const targetBrightness = document.getElementById('targetBrightness');

function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info, actionInfoStr) {
    pluginUUID = uuid;
    actionInfo = JSON.parse(actionInfoStr);
    actionContext = actionInfo.context;
    
    // Show specific blocks based on action type
    const actionId = actionInfo.action;
    if (actionId === "com.soomfon.govee.color") colorBlock.classList.remove('hidden');
    if (actionId === "com.soomfon.govee.brightness") brightnessBlock.classList.remove('hidden');

    websocket = new WebSocket(`ws://127.0.0.1:${port}`);

    websocket.onopen = () => {
        websocket.send(JSON.stringify({
            event: registerEvent,
            uuid: pluginUUID
        }));
        
        // Request settings
        websocket.send(JSON.stringify({
            event: "getGlobalSettings",
            context: pluginUUID
        }));
        websocket.send(JSON.stringify({
            event: "getSettings",
            context: actionContext
        }));
    };

    websocket.onmessage = (evt) => {
        const payload = JSON.parse(evt.data);
        if (payload.event === "didReceiveGlobalSettings") {
            globalSettings = payload.payload.settings;
            if (globalSettings.apiKey) apiKeyInput.value = globalSettings.apiKey;
        } else if (payload.event === "didReceiveSettings") {
            actionSettings = payload.payload.settings;
            if (actionSettings.color) targetColor.value = actionSettings.color;
            if (actionSettings.brightness) targetBrightness.value = actionSettings.brightness;
            renderDeviceList(actionSettings.availableDevices || [], actionSettings.devices || []);
        } else if (payload.event === "sendToPropertyInspector") {
            if (payload.payload.command === "deviceList") {
                statusMsg.innerText = `Found ${payload.payload.devices.length} devices!`;
                // Save available devices
                actionSettings.availableDevices = payload.payload.devices;
                saveSettings();
                renderDeviceList(actionSettings.availableDevices, actionSettings.devices || []);
            } else if (payload.payload.command === "fetchError") {
                statusMsg.innerText = `Error: ${payload.payload.message}`;
            }
        }
    };
}

apiKeyInput.addEventListener('input', () => {
    globalSettings.apiKey = apiKeyInput.value.trim();
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            event: "setGlobalSettings",
            context: pluginUUID,
            payload: globalSettings
        }));
    }
});

fetchBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
        statusMsg.innerText = "Please enter an API Key first.";
        return;
    }
    statusMsg.innerText = "Fetching devices...";
    websocket.send(JSON.stringify({
        event: "sendToPlugin",
        context: actionContext,
        payload: { command: "fetchDevices", apiKey: key }
    }));
});

function renderDeviceList(availableDevices, selectedDevices) {
    deviceList.innerHTML = "";
    if (!availableDevices || availableDevices.length === 0) {
        deviceList.innerHTML = "<div style='color: #888;'>No devices found. Click Fetch.</div>";
        return;
    }
    
    // Map selected to fast lookup
    const selectedMap = {};
    selectedDevices.forEach(d => selectedMap[d.device] = true);

    availableDevices.forEach(dev => {
        const div = document.createElement("div");
        div.className = "device-item";
        
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = dev.device;
        cb.checked = !!selectedMap[dev.device];
        
        cb.addEventListener('change', () => {
            updateSelectedDevices();
        });

        const lbl = document.createElement("label");
        lbl.innerText = `${dev.deviceName} (${dev.model})`;
        lbl.style.cursor = "pointer";
        lbl.onclick = () => cb.click();

        div.appendChild(cb);
        div.appendChild(lbl);
        // Store model in dataset
        cb.dataset.model = dev.model;
        cb.dataset.deviceName = dev.deviceName;
        
        deviceList.appendChild(div);
    });
}

function updateSelectedDevices() {
    const checkboxes = deviceList.querySelectorAll("input[type='checkbox']");
    const selected = [];
    checkboxes.forEach(cb => {
        if (cb.checked) {
            selected.push({
                device: cb.value,
                model: cb.dataset.model,
                deviceName: cb.dataset.deviceName
            });
        }
    });
    actionSettings.devices = selected;
    saveSettings();
}

targetColor.addEventListener('input', () => {
    actionSettings.color = targetColor.value;
    saveSettings();
});

targetBrightness.addEventListener('input', () => {
    actionSettings.brightness = targetBrightness.value;
    saveSettings();
});

function saveSettings() {
    if (websocket) {
        websocket.send(JSON.stringify({
            event: "setSettings",
            context: actionContext,
            payload: actionSettings
        }));
    }
}
