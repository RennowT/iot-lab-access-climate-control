#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <cstring>

constexpr char WIFI_SSID[] = "#";
constexpr char WIFI_PASSWORD[] = "#";

constexpr char MQTT_HOST[] = "broker.hivemq.com";
constexpr uint16_t MQTT_PORT = 1883;

constexpr uint8_t PIN_BOTAO_AUTORIZADO = 15;
constexpr uint8_t PIN_BOTAO_NEGADO = 14;
constexpr uint8_t PIN_LED_FECHADURA = 25;
constexpr uint8_t PIN_LED_REFRIGERACAO = 26;

constexpr unsigned long INTERVALO_TEMPERATURA_MS = 1000;
constexpr unsigned long TEMPO_ABERTURA_MS = 20000;
constexpr unsigned long TEMPO_FECHADURA_MS = 5000;
constexpr unsigned long DEBOUNCE_MS = 50;
constexpr unsigned long RECONEXAO_WIFI_MS = 10000;
constexpr unsigned long RECONEXAO_MQTT_MS = 5000;

constexpr float TEMPERATURA_ALVO_C = 20.0f;
constexpr float LIMITE_REFRIGERACAO_ON = 20.3f;
constexpr float LIMITE_REFRIGERACAO_OFF = 20.0f;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

char mqttClientId[32];
char topicoAcesso[64];
char topicoTemperatura[64];

float temperaturaC = TEMPERATURA_ALVO_C;

bool refrigeracaoLigada = false;
bool fechaduraLiberada = false;
bool portaAberta = false;

unsigned long ultimaLeitura = 0;
unsigned long ultimoWiFi = 0;
unsigned long ultimoMQTT = 0;
unsigned long inicioLiberacao = 0;
unsigned long inicioAbertura = 0;

struct Botao {
  uint8_t pino;
  bool ultimaLeitura;
  bool estadoEstavel;
  unsigned long ultimaMudanca;
};

Botao botaoAutorizado = {PIN_BOTAO_AUTORIZADO, HIGH, HIGH, 0};
Botao botaoNegado = {PIN_BOTAO_NEGADO, HIGH, HIGH, 0};

bool foiPressionado(Botao &botao) {
  bool leitura = digitalRead(botao.pino);
  unsigned long agora = millis();

  if (leitura != botao.ultimaLeitura) {
    botao.ultimaMudanca = agora;
    botao.ultimaLeitura = leitura;
  }

  if (agora - botao.ultimaMudanca >= DEBOUNCE_MS &&
      leitura != botao.estadoEstavel) {
    botao.estadoEstavel = leitura;
    return leitura == LOW;
  }

  return false;
}

void registrarAcesso(bool autorizado) {
  if (!autorizado) {
    Serial.println("[ACESSO] NEGADO");
    if (mqtt.connected()) mqtt.publish(topicoAcesso, "negado");
    return;
  }

  fechaduraLiberada = true;
  portaAberta = true;
  inicioLiberacao = millis();
  inicioAbertura = millis();

  digitalWrite(PIN_LED_FECHADURA, HIGH);

  Serial.println("[ACESSO] LIBERADO");
  Serial.println("[PORTA] ABERTA");

  if (mqtt.connected()) mqtt.publish(topicoAcesso, "liberado");
}

void atualizarTemperatura() {
  float aleatorio = random(0, 10001) / 10000.0f;

  if (portaAberta) {
    temperaturaC += 0.08f + aleatorio * 0.10f;
  } else if (refrigeracaoLigada) {
    temperaturaC -= 0.10f + aleatorio * 0.12f;
  } else {
    float erro = TEMPERATURA_ALVO_C - temperaturaC;
    temperaturaC += erro * 0.25f + (aleatorio * 0.16f - 0.08f);
  }

  temperaturaC = constrain(temperaturaC, 19.8f, 26.0f);

  if (!refrigeracaoLigada && temperaturaC >= LIMITE_REFRIGERACAO_ON)
    refrigeracaoLigada = true;
  else if (refrigeracaoLigada && temperaturaC <= LIMITE_REFRIGERACAO_OFF)
    refrigeracaoLigada = false;

  digitalWrite(PIN_LED_REFRIGERACAO, refrigeracaoLigada ? HIGH : LOW);

  Serial.printf(
    "[TEMPERATURA] %.2f C | Porta: %s | Refrigeracao: %s\n",
    temperaturaC,
    portaAberta ? "ABERTA" : "FECHADA",
    refrigeracaoLigada ? "LIGADA" : "DESLIGADA"
  );

  if (mqtt.connected()) {
    char mensagem[16];
    snprintf(mensagem, sizeof(mensagem), "%.2f", temperaturaC);
    mqtt.publish(topicoTemperatura, mensagem);
  }
}

void mensagemMQTT(char *topico, byte *payload, unsigned int tamanho) {
  if (strcmp(topico, topicoAcesso) != 0 || tamanho == 0 || tamanho >= 32)
    return;

  char mensagem[32];
  memcpy(mensagem, payload, tamanho);
  mensagem[tamanho] = '\0';

  String comando = String(mensagem);
  comando.trim();
  comando.toLowerCase();

  if (comando == "liberado" && !fechaduraLiberada && !portaAberta) {
    registrarAcesso(true);
  } else if (comando == "travado") {
    fechaduraLiberada = false;
    portaAberta = false;
    digitalWrite(PIN_LED_FECHADURA, LOW);
    Serial.println("[FECHADURA] TRAVADA");
    Serial.println("[PORTA] FECHADA");
  }
}

void gerenciarConexoes() {
  unsigned long agora = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (agora - ultimoWiFi >= RECONEXAO_WIFI_MS) {
      ultimoWiFi = agora;
      WiFi.reconnect();
      Serial.println("[WIFI] Reconectando...");
    }
    return;
  }

  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }

  if (agora - ultimoMQTT < RECONEXAO_MQTT_MS) return;
  ultimoMQTT = agora;

  if (mqtt.connect(mqttClientId)) {
    Serial.println("[MQTT] Conectado");
    mqtt.subscribe(topicoAcesso);

    char mensagem[16];
    snprintf(mensagem, sizeof(mensagem), "%.2f", temperaturaC);
    mqtt.publish(topicoTemperatura, mensagem);
  } else {
    Serial.printf("[MQTT] Falha: %d\n", mqtt.state());
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_BOTAO_AUTORIZADO, INPUT_PULLUP);
  pinMode(PIN_BOTAO_NEGADO, INPUT_PULLUP);
  pinMode(PIN_LED_FECHADURA, OUTPUT);
  pinMode(PIN_LED_REFRIGERACAO, OUTPUT);

  digitalWrite(PIN_LED_FECHADURA, LOW);
  digitalWrite(PIN_LED_REFRIGERACAO, LOW);

  randomSeed(esp_random());

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  String macId = WiFi.macAddress();
  macId.replace(":", "");
  macId.toUpperCase();

  snprintf(mqttClientId, sizeof(mqttClientId), "tp546-%s", macId.c_str());
  snprintf(topicoAcesso, sizeof(topicoAcesso), "tp546/%s/acesso", macId.c_str());
  snprintf(topicoTemperatura, sizeof(topicoTemperatura), "tp546/%s/temperatura", macId.c_str());

  Serial.println("\n=== TP546 - IoT LAB ===");
  Serial.printf("MAC: %s\n", WiFi.macAddress().c_str());
  Serial.printf("Topico acesso: %s\n", topicoAcesso);
  Serial.printf("Topico temperatura: %s\n", topicoTemperatura);

  ultimoWiFi = millis();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mensagemMQTT);
  mqtt.setBufferSize(256);
  mqtt.setSocketTimeout(2);

  ultimoMQTT = millis() - RECONEXAO_MQTT_MS;
  ultimaLeitura = millis();
}

void loop() {
  gerenciarConexoes();

  if (foiPressionado(botaoAutorizado)) registrarAcesso(true);
  if (foiPressionado(botaoNegado)) registrarAcesso(false);

  unsigned long agora = millis();

  if (fechaduraLiberada && agora - inicioLiberacao >= TEMPO_FECHADURA_MS) {
    fechaduraLiberada = false;
    digitalWrite(PIN_LED_FECHADURA, LOW);
    Serial.println("[FECHADURA] TRAVADA");
  }

  if (portaAberta && agora - inicioAbertura >= TEMPO_ABERTURA_MS) {
    portaAberta = false;
    Serial.println("[PORTA] FECHADA");
  }

  if (agora - ultimaLeitura >= INTERVALO_TEMPERATURA_MS) {
    ultimaLeitura = agora;
    atualizarTemperatura();
  }
}