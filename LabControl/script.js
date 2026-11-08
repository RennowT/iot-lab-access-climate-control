"use strict";

// Dados recebidos exclusivamente por MQTT; não há geração de leituras locais.
const temperatureDisplay = document.getElementById("temperature");
const updatedAt = document.getElementById("updated-at");
const canvas = document.getElementById("temperature-chart");
const context = canvas.getContext("2d");
const readings = [];
const formatter = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
let temperature = null;
let client = null;
let ready = false;
let deviceMac = "AABBCCDDEEFF";
let coolerState = null;
let doorState = null;
const coolerHistory = [];
const accessHistory = [];
const unlockButton = document.getElementById("unlock-button");
const connectionStatus = document.getElementById("mqtt-status");
const commandStatus = document.getElementById("command-status");

function timeNow() {
  return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setConnection(text, available = false) {
  ready = available;
  connectionStatus.textContent = `MQTT · ${text}`;
  unlockButton.disabled = !available;
}

function renderHistory(id, events) {
  const list = document.getElementById(id);
  list.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nenhum evento recebido nesta sessão.";
    list.append(empty);
    return;
  }
  events.forEach(event => {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = event.time;
    const description = document.createElement("span");
    description.textContent = event.text;
    item.append(time, description);
    list.append(item);
  });
}

function addEvent(id, history, text) {
  history.unshift({ time: timeNow(), text });
  history.splice(10);
  renderHistory(id, history);
}

function connectDevice(mac) {
  setConnection("Conectando…");
  if (client) {
    client.removeAllListeners();
    client.on("error", () => {});
    client.end(true);
  }
  deviceMac = mac;
  temperature = null;
  readings.length = 0;
  coolerState = null;
  doorState = null;
  coolerHistory.length = 0;
  accessHistory.length = 0;
  renderHistory("cooler-history", coolerHistory);
  renderHistory("access-history", accessHistory);
  const coolerIndicator = document.getElementById("cooler-state");
  coolerIndicator.textContent = "COOLER · AGUARDANDO";
  coolerIndicator.classList.remove("is-on");
  temperatureDisplay.textContent = "—";
  updatedAt.textContent = "—";
  document.getElementById("access-event").textContent = "Aguardando estado da porta";
  document.getElementById("event-time").textContent = "Nenhum estado recebido.";
  commandStatus.textContent = "Nenhum comando enviado.";
  drawChart();
  if (!window.mqtt) {
    setConnection("Biblioteca indisponível. Recarregue a página.");
    return;
  }
  const temperatureTopic = `tp546/${mac}/temperatura`;
  const accessTopic = `tp546/${mac}/acesso`;
  const coolerTopic = `tp546/${mac}/cooler`;
  const current = window.mqtt.connect("wss://broker.hivemq.com:8884/mqtt", {
    clientId: `labcontrol-web-${crypto.randomUUID()}`,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 5000,
    reconnectOnConnackError: true,
    connectTimeout: 15000,
    resubscribe: false,
    queueQoSZero: false,
  });
  client = current;
  current.on("connect", () => {
    setConnection("Inscrevendo…");
    current.subscribe({
      [temperatureTopic]: { qos: 0 },
      [accessTopic]: { qos: 0 },
      [coolerTopic]: { qos: 0 },
    }, (error, granted) => {
      if (client !== current || !current.connected) return;
      if (error || !granted || granted.length !== 3 || granted.some(item => item.qos >= 128)) {
        setConnection("Falha na inscrição");
        return;
      }
      setConnection("Conectado", true);
    });
  });
  current.on("message", (topic, payload, packet) => {
    if (client !== current) return;
    const text = payload.toString().trim();
    if (topic === temperatureTopic) {
      if (!/^-?\d+(?:\.\d+)?$/.test(text)) return;
      const value = Number(text);
      if (!Number.isFinite(value)) return;
      temperature = value;
      readings.push(value);
      if (readings.length > 60) readings.shift();
      temperatureDisplay.textContent = formatter.format(value);
      updatedAt.textContent = timeNow();
      drawChart();
    } else if (topic === coolerTopic && ["ligado", "desligado"].includes(text)) {
      const previous = coolerState;
      coolerState = text;
      const indicator = document.getElementById("cooler-state");
      indicator.textContent = `COOLER ${text.toUpperCase()}`;
      indicator.classList.toggle("is-on", text === "ligado");
      if (!packet?.retain && previous !== text) {
        const latestTemperature = temperature === null ? "temperatura indisponível" : `${formatter.format(temperature)} °C`;
        addEvent("cooler-history", coolerHistory, `Cooler ${text} · ${latestTemperature}`);
      }
    } else if (topic === accessTopic && ["aberta", "fechada"].includes(text)) {
      const previous = doorState;
      doorState = text;
      document.getElementById("access-event").textContent = `PORTA ${text.toUpperCase()}`;
      document.getElementById("event-time").textContent = `${timeNow()} · ${packet?.retain ? "Último estado conhecido (retido)" : "Estado recebido"}`;
      if (!packet?.retain && previous !== text) {
        addEvent("access-history", accessHistory, `Porta ${text}`);
      }
    }
  });
  const unavailable = text => {
    if (client !== current) return;
    setConnection(text);
    document.getElementById("access-event").textContent = "Estado da porta indisponível";
    document.getElementById("event-time").textContent = doorState === null
      ? "Aguardando conexão e estado MQTT."
      : `Último estado conhecido: porta ${doorState}. Aguardando novo estado MQTT.`;
    commandStatus.textContent = "Conexão indisponível. Comandos desabilitados.";
  };
  current.on("reconnect", () => unavailable("Reconectando…"));
  current.on("offline", () => unavailable("Desconectado · tentando reconectar"));
  current.on("close", () => unavailable("Desconectado · tentando reconectar"));
  current.on("error", () => unavailable("Erro de conexão · tentando reconectar"));
}

function sendCommand(command) {
  if (!ready || !client?.connected) return;
  const current = client;
  commandStatus.textContent = "Enviando comando…";
  current.publish(`tp546/${deviceMac}/acesso`, command, { qos: 0, retain: false }, error => {
    if (client !== current) return;
    commandStatus.textContent = error
      ? "Falha ao enviar comando."
      : `Comando “${command}” enviado · execução não confirmada.`;
  });
}

unlockButton.addEventListener("click", () => sendCommand("liberado"));
document.getElementById("device-form").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.getElementById("device-mac");
  const mac = input.value.trim().toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(mac)) {
    input.reportValidity();
    return;
  }
  input.value = mac;
  connectDevice(mac);
});
window.addEventListener("resize", drawChart);
connectDevice(deviceMac);

function drawChart() {
  if (!context) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!readings.length) {
    canvas.setAttribute("aria-label", "Aguardando leituras de temperatura via MQTT.");
    return;
  }
  const left = 34, right = width - 8, top = 10, bottom = height - 15;
  const minimum = Math.min(24, Math.floor((Math.min(...readings) - 0.15) * 2) / 2);
  const maximum = Math.max(36, Math.ceil((Math.max(...readings) + 0.15) * 2) / 2);
  const y = value => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
  const x = index => left + index / 59 * (right - left);
  context.font = '10px "Segoe UI", Arial, sans-serif';
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let index = 0; index <= 3; index++) {
    const value = minimum + (maximum - minimum) * index / 3;
    context.fillStyle = "#93a0b2";
    context.fillText(formatter.format(value), left - 9, y(value));
    context.strokeStyle = "#edf1f7";
    context.beginPath(); context.moveTo(left, y(value)); context.lineTo(right, y(value)); context.stroke();
  }
  context.setLineDash([4, 5]);
  context.strokeStyle = "#b3c5dd";
  [25, 35].forEach(value => {
    context.beginPath(); context.moveTo(left, y(value)); context.lineTo(right, y(value)); context.stroke();
    context.fillStyle = "#7d91ab";
    context.fillText(`${value} °C`, right - 4, y(value) - 8);
  });
  context.setLineDash([]);
  const gradient = context.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, "rgba(75,136,220,0.16)");
  gradient.addColorStop(1, "rgba(75,136,220,0.01)");
  context.beginPath(); context.moveTo(left, bottom);
  readings.forEach((value, index) => context.lineTo(x(index), y(value)));
  context.lineTo(x(readings.length - 1), bottom); context.closePath();
  context.fillStyle = gradient; context.fill();
  context.beginPath();
  readings.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
  context.strokeStyle = "#4b88dc"; context.lineWidth = 2.5; context.lineJoin = "round"; context.stroke(); context.lineWidth = 1;
  context.beginPath(); context.arc(x(readings.length - 1), y(readings.at(-1)), 3.5, 0, Math.PI * 2); context.fillStyle = "#4b88dc"; context.fill();
  canvas.setAttribute("aria-label", `Gráfico com ${readings.length} leituras recebidas. Temperatura atual: ${formatter.format(temperature)} graus Celsius. Referências: 25 e 35 graus Celsius.`);
}

