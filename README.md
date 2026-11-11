# RackSafe IoT

**Sistema IoT de Monitoramento e Proteção de Racks de Telecomunicações**

O RackSafe é um projeto de Internet das Coisas (IoT) desenvolvido para a disciplina **TP546 – IoT e Redes Veiculares**, do programa de Mestrado do Instituto Nacional de Telecomunicações (Inatel).

O projeto propõe uma solução para monitoramento térmico e controle de acesso a racks de telecomunicações, utilizando ESP32, comunicação MQTT e uma interface web para supervisão remota.

## Funcionalidades

- **Monitoramento de temperatura:** simulação do aquecimento gradual dos equipamentos instalados no rack, com atualização a cada segundo.
- **Controle automático de refrigeração:** acionamento do cooler quando a temperatura atinge 35 °C e desligamento quando retorna a 25 °C.
- **Controle remoto de acesso:** abertura da porta exclusivamente por comando enviado pela dashboard.
- **Fechamento local:** a porta permanece aberta até o acionamento de um botão físico.
- **Sinalização visual:** LEDs indicam o estado da porta e do cooler.
- **Dashboard:** visualização da temperatura em tempo real, gráfico com as últimas 60 medições, estados dos dispositivos e histórico de eventos de acesso e refrigeração.

## Tecnologias utilizadas

- ESP32
- Wi-Fi
- MQTT (PubSubClient)
- HTML, CSS e JavaScript para a dashboard

## Hardware do protótipo

| Componente | GPIO | Função |
|---|---|---|
| Botão | GPIO14 | Fechamento local da porta |
| LED vermelho | GPIO25 | Indicação de porta aberta |
| LED verde | GPIO26 | Indicação de cooler ligado |

Os LEDs são utilizados para representar os atuadores. A temperatura é gerada por uma simulação no firmware, sem necessidade de sensor físico.

## Comunicação MQTT

O ESP32 utiliza o broker público HiveMQ para troca de informações com a dashboard.

| Parâmetro | Valor |
|---|---|
| Broker | `broker.hivemq.com` |
| Porta | `1883` |
| Protocolo | MQTT |
| Autenticação | Não requerida |

Cada dispositivo é identificado pelo endereço MAC do ESP32, sem os separadores `:`.

### Tópicos MQTT

| Tópico | Direção | Payload |
|---|---|---|
| `tp546/<MAC>/temperatura` | ESP32 → Dashboard | Temperatura em °C, exemplo: `28.45` |
| `tp546/<MAC>/cooler` | ESP32 → Dashboard | `ligado` ou `desligado` |
| `tp546/<MAC>/acesso` | Dashboard → ESP32 | `liberado` |
| `tp546/<MAC>/acesso` | ESP32 → Dashboard | `aberta` ou `fechada` |

O endereço MAC permite identificar individualmente diferentes dispositivos conectados ao mesmo broker.

## Funcionamento

A temperatura aumenta gradualmente devido ao aquecimento simulado dos equipamentos. Ao atingir 35 °C, o ESP32 aciona a refrigeração, representada pelo LED verde. O cooler permanece ativo até a temperatura diminuir para 25 °C.

A abertura da porta ocorre somente após o recebimento do comando MQTT `liberado`. O LED vermelho acende e o ESP32 publica o estado `aberta`. O fechamento é realizado exclusivamente pelo botão físico, apagando o LED e publicando `fechada`.

A dashboard apresenta os dados recebidos e permite acompanhar as variações térmicas, a frequência de acionamento do cooler e os eventos de abertura e fechamento.

## Execução do projeto

1. Instale o Visual Studio Code com a extensão PlatformIO.
2. Abra o diretório do firmware como um projeto PlatformIO.
3. Configure `WIFI_SSID` e `WIFI_PASSWORD` no arquivo `src/main.cpp`.
4. Conecte o ESP32 e grave o firmware.
5. Abra o monitor serial a 115200 baud para visualizar o endereço MAC e os eventos.
6. Configure a dashboard com o MAC do dispositivo.

## Vídeo da apresentação

A apresentação do projeto RackSafe IoT está disponível no YouTube:

**[Assistir à apresentação do RackSafe IoT](https://www.youtube.com/watch?v=1WE1xzhwNRE)**

## Possíveis melhorias

Para uma implementação física, o projeto prevê a integração de sensores e atuadores reais, incluindo sensor de temperatura DS18B20, sensor magnético de abertura, fechadura elétrica e módulo de acionamento do cooler.

Outras possibilidades incluem autenticação dos operadores, comunicação MQTT criptografada, armazenamento persistente dos eventos, detecção de anomalias térmicas e integração com plataformas de gerenciamento de infraestrutura.

## Limitações

O RackSafe é um protótipo acadêmico. A temperatura, a porta e os atuadores são simulados, e o broker público não possui os mecanismos de autenticação necessários para controlar o acesso físico a equipamentos reais.

## Autores

- Gustavo Henrique de Sousa Nogueira
- Matheus Renó Torres

**Instituição:** Instituto Nacional de Telecomunicações (Inatel)

**Disciplina:** TP546 – IoT e Redes Veiculares
