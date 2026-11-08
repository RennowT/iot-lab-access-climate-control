#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <cstring>

constexpr char WIFI_SSID[] = "";
constexpr char WIFI_PASSWORD[] = "";

constexpr char MQTT_HOST[] = "broker.hivemq.com";
constexpr uint16_t MQTT_PORT = 1883;

constexpr uint8_t PIN_BOTAO_FECHAR = 14;
constexpr uint8_t PIN_LED_FECHADURA = 25;
constexpr uint8_t PIN_LED_REFRIGERACAO = 26;

constexpr unsigned long INTERVALO_TEMPERATURA_MS = 1000;
constexpr unsigned long DEBOUNCE_MS = 50;
constexpr unsigned long RECONEXAO_WIFI_MS = 10000;
constexpr unsigned long RECONEXAO_MQTT_MS = 5000;

constexpr float TEMPERATURA_INICIAL_C = 25.0f;
constexpr float LIMITE_REFRIGERACAO_ON = 35.0f;
constexpr float LIMITE_REFRIGERACAO_OFF = 25.0f;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

char mqttClientId[32];
char topicoAcesso[64];
char topicoTemperatura[64];
char topicoCooler[64];

float temperaturaC = TEMPERATURA_INICIAL_C;

bool refrigeracaoLigada = false;
bool portaAberta = false;

bool ultimaLeituraBotao = HIGH;
bool estadoBotao = HIGH;

unsigned long ultimaMudancaBotao = 0;
unsigned long ultimaLeitura = 0;
unsigned long ultimoWiFi = 0;
unsigned long ultimoMQTT = 0;

void atualizarTemperatura() {
  float aleatorio = random(0, 10001) / 10000.0f;

  if (refrigeracaoLigada) {
    temperaturaC -= 0.18f + aleatorio * 0.14f;
  } else {
    temperaturaC += 0.10f + aleatorio * 0.09f;
  }

  if (portaAberta) {
    temperaturaC += 0.06f + aleatorio * 0.08f;
  }

  temperaturaC = constrain(temperaturaC, 20.0f, 45.0f);

  bool estadoAnterior = refrigeracaoLigada;

  if (!refrigeracaoLigada && temperaturaC >= LIMITE_REFRIGERACAO_ON)
    refrigeracaoLigada = true;
  else if (refrigeracaoLigada && temperaturaC <= LIMITE_REFRIGERACAO_OFF)
    refrigeracaoLigada = false;

  digitalWrite(PIN_LED_REFRIGERACAO, refrigeracaoLigada ? HIGH : LOW);

  if (estadoAnterior != refrigeracaoLigada) {
    Serial.printf(
      "[COOLER] %s\n",
      refrigeracaoLigada ? "LIGADO" : "DESLIGADO"
    );

    if (mqtt.connected()) {
      mqtt.publish(
        topicoCooler,
        refrigeracaoLigada ? "ligado" : "desligado",
        true
      );
    }
  }

  Serial.printf(
    "[TEMPERATURA] %.2f C | Porta: %s | Cooler: %s\n",
    temperaturaC,
    portaAberta ? "ABERTA" : "FECHADA",
    refrigeracaoLigada ? "LIGADO" : "DESLIGADO"
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

  if (comando == "liberado" && !portaAberta) {
    portaAberta = true;

    digitalWrite(PIN_LED_FECHADURA, HIGH);

    Serial.println("[ACESSO] LIBERADO REMOTAMENTE");
    Serial.println("[PORTA] ABERTA");

    mqtt.publish(topicoAcesso, "aberta", true);
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

    mqtt.publish(
      topicoAcesso,
      portaAberta ? "aberta" : "fechada",
      true
    );

    mqtt.publish(
      topicoCooler,
      refrigeracaoLigada ? "ligado" : "desligado",
      true
    );

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

  pinMode(PIN_BOTAO_FECHAR, INPUT);
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
  snprintf(topicoCooler, sizeof(topicoCooler), "tp546/%s/cooler", macId.c_str());

  Serial.println("\n=== TP546 - RACK TELECOM ===");
  Serial.printf("MAC: %s\n", WiFi.macAddress().c_str());
  Serial.printf("Topico acesso: %s\n", topicoAcesso);
  Serial.printf("Topico temperatura: %s\n", topicoTemperatura);
  Serial.printf("Topico cooler: %s\n", topicoCooler);

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

  unsigned long agora = millis();
  bool leitura = digitalRead(PIN_BOTAO_FECHAR);

  if (leitura != ultimaLeituraBotao)
    ultimaMudancaBotao = agora;

  if (agora - ultimaMudancaBotao >= DEBOUNCE_MS &&
      leitura != estadoBotao) {

    estadoBotao = leitura;

    if (estadoBotao == LOW && portaAberta) {
      portaAberta = false;

      digitalWrite(PIN_LED_FECHADURA, LOW);

      Serial.println("[PORTA] FECHADA LOCALMENTE");

      if (mqtt.connected())
        mqtt.publish(topicoAcesso, "fechada", true);
    }
  }

  ultimaLeituraBotao = leitura;

  if (agora - ultimaLeitura >= INTERVALO_TEMPERATURA_MS) {
    ultimaLeitura = agora;
    atualizarTemperatura();
  }
}