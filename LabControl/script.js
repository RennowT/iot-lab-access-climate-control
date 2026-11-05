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
let deviceMac = "A1B2C3D4E5F6";
const unlockButton = document.getElementById("unlock-button");
const lockButton = document.getElementById("lock-button");
const connectionStatus = document.getElementById("mqtt-status");
const commandStatus = document.getElementById("command-status");

function timeNow() {
  return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setConnection(text, available = false) {
  ready = available;
  connectionStatus.textContent = `MQTT · ${text}`;
  unlockButton.disabled = !available;
  lockButton.disabled = !available;
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
  temperatureDisplay.textContent = "—";
  updatedAt.textContent = "—";
  document.getElementById("access-event").textContent = "Aguardando evento de acesso";
  document.getElementById("event-time").textContent = "Os eventos aparecerão aqui.";
  commandStatus.textContent = "Nenhum comando enviado.";
  drawChart();
  if (!window.mqtt) {
    setConnection("Biblioteca indisponível. Recarregue a página.");
    return;
  }
  const temperatureTopic = `tp546/${mac}/temperatura`;
  const accessTopic = `tp546/${mac}/acesso`;
  const current = window.mqtt.connect("wss://broker.hivemq.com:8884/mqtt", {
    clientId: `labcontrol-web-${crypto.randomUUID()}`,
    protocolVersion: 5,
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
      // Não receber nossos próprios comandos como eventos de acesso.
      [accessTopic]: { qos: 0, nl: true },
    }, (error, granted) => {
      if (client !== current || !current.connected) return;
      if (error || !granted || granted.length !== 2 || granted.some(item => item.qos >= 128)) {
        setConnection("Falha na inscrição");
        return;
      }
      setConnection("Conectado", true);
    });
  });
  current.on("message", (topic, payload) => {
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
    } else if (topic === accessTopic && ["liberado", "negado"].includes(text)) {
      document.getElementById("access-event").textContent = text === "liberado"
        ? "Evento recebido: acesso liberado" : "Evento recebido: acesso negado";
      document.getElementById("event-time").textContent = `${timeNow()} · Origem não informada pelo protocolo`;
    }
  });
  const unavailable = text => {
    if (client !== current) return;
    setConnection(text);
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
lockButton.addEventListener("click", () => sendCommand("travado"));
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
  const minimum = Math.min(19.5, Math.floor((Math.min(...readings) - 0.15) * 2) / 2);
  const maximum = Math.max(21, Math.ceil((Math.max(...readings) + 0.15) * 2) / 2);
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
  context.beginPath(); context.moveTo(left, y(20)); context.lineTo(right, y(20)); context.stroke();
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
  canvas.setAttribute("aria-label", `Gráfico com ${readings.length} leituras recebidas. Temperatura atual: ${formatter.format(temperature)} graus Celsius. Referência: 20 graus Celsius.`);
}

