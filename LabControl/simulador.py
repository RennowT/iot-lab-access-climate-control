"""Simulador do main.cpp. Instalação: python -m pip install 'paho-mqtt>=2,<3'."""

import argparse
import queue
import random
import re
import secrets
import sys
import threading
import time

import paho.mqtt.client as mqtt


MQTT_HOST = "broker.hivemq.com"
MQTT_PORT = 1883
TEMPERATURA_ALVO = 20.0
LIMITE_ON = 20.3
LIMITE_OFF = 20.0
TEMPO_FECHADURA = 5.0
TEMPO_PORTA = 20.0
INTERVALO_LOG_TEMPERATURA = 10.0


class Terminal:
    """Preserva a linha digitada no console Windows, sem dependências extras."""

    def __init__(self):
        self.lock = threading.Lock()
        self.texto = ""
        self.ativo = False
        self.parar = threading.Event()

    def desenhar(self):
        sys.stdout.write("\r" + " " * 40 + "\rcomando> " + self.texto)
        sys.stdout.flush()

    def escrever(self, mensagem, flush=True):
        with self.lock:
            if self.ativo:
                sys.stdout.write("\r" + " " * 40 + "\r")
            sys.stdout.write(str(mensagem) + "\n")
            if self.ativo:
                self.desenhar()
            sys.stdout.flush()

    def ler(self, eventos):
        if sys.platform != "win32" or not sys.stdin.isatty():
            # Entrada redirecionada ou terminal fora do Windows.
            while not self.parar.is_set():
                try:
                    comando = input().strip().lower()
                except EOFError:
                    return
                eventos.put(("terminal", comando))
                if comando == "sair":
                    return
            return

        import msvcrt

        with self.lock:
            self.ativo = True
            self.desenhar()
        especial = False
        while not self.parar.wait(0.03):
            if not msvcrt.kbhit():
                continue
            tecla = msvcrt.getwch()
            with self.lock:
                if especial:
                    especial = False
                    continue
                if tecla in ("\x00", "\xe0"):
                    especial = True
                    continue
                if tecla in ("\r", "\n", "\x03", "\x1a"):
                    comando = "sair" if tecla in ("\x03", "\x1a") else self.texto.strip().lower()
                    sys.stdout.write("\n")
                    self.texto = ""
                    eventos.put(("terminal", comando))
                    if comando == "sair":
                        self.ativo = False
                        sys.stdout.flush()
                        return
                elif tecla == "\b":
                    self.texto = self.texto[:-1]
                elif tecla.isprintable() and len(self.texto) < 24:
                    self.texto += tecla
                self.desenhar()

    def encerrar(self):
        self.parar.set()
        with self.lock:
            if self.ativo:
                sys.stdout.write("\n")
                sys.stdout.flush()
            self.ativo = False


terminal = Terminal()


def validar_mac(valor):
    """O identificador faz parte dos tópicos e não contém dois-pontos."""
    if not re.fullmatch(r"[0-9a-fA-F]{12}", valor):
        raise argparse.ArgumentTypeError("Use exatamente 12 caracteres hexadecimais, sem ':'.")
    return valor.upper()


class Simulador:
    def __init__(self, mac):
        self.topico_acesso = f"tp546/{mac}/acesso"
        self.topico_temperatura = f"tp546/{mac}/temperatura"
        # Prefixo diferente do firmware, mais um sufixo exclusivo por execução.
        self.client_id = f"sim-tp546-{mac}-{secrets.token_hex(4)}"
        self.temperatura = TEMPERATURA_ALVO
        self.refrigeracao = False
        self.fechadura_liberada = False
        self.porta_aberta = False
        self.inicio_acesso = 0.0
        self.ultimo_log_temperatura = time.monotonic()
        self.eventos = queue.Queue()
        # Somente o laço principal altera os estados da simulação.
        # Callbacks MQTT e leitura do terminal apenas colocam eventos na fila.
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=self.client_id,
            protocol=mqtt.MQTTv5,
        )
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_connect_fail = self.on_connect_fail
        self.client.on_subscribe = self.on_subscribe
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(min_delay=5, max_delay=5)

    def on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            terminal.escrever(f"[MQTT] Conexão recusada: {reason_code}", flush=True)
            return
        terminal.escrever("[MQTT] Conectado.", flush=True)
        # MQTT 5 noLocal impede o eco dos próprios eventos, sem mudar tópicos
        # ou payloads e sem confundir eventos locais com comandos remotos.
        result, _ = client.subscribe(
            self.topico_acesso,
            options=mqtt.SubscribeOptions(qos=0, noLocal=True),
        )
        if result != mqtt.MQTT_ERR_SUCCESS:
            terminal.escrever(f"[MQTT] Falha ao solicitar inscrição: {result}", flush=True)
        self.eventos.put(("conectado", None))

    def on_subscribe(self, client, userdata, mid, reason_codes, properties):
        if any(code.is_failure for code in reason_codes):
            terminal.escrever(f"[MQTT] Inscrição recusada: {reason_codes}", flush=True)
        else:
            terminal.escrever(f"[MQTT] Inscrito em {self.topico_acesso} (sem eco local).", flush=True)

    def on_disconnect(self, client, userdata, flags, reason_code, properties):
        terminal.escrever(f"[MQTT] Desconectado: {reason_code}", flush=True)
        if reason_code.is_failure:
            terminal.escrever("[MQTT] Tentando reconectar a cada 5 segundos.", flush=True)

    def on_connect_fail(self, client, userdata):
        terminal.escrever("[MQTT] Broker indisponível. Nova tentativa em 5 segundos.", flush=True)

    def on_message(self, client, userdata, message):
        if message.topic != self.topico_acesso:
            return
        # Mesmo limite de tamanho usado pelo firmware.
        if not 0 < len(message.payload) < 32:
            terminal.escrever("[MQTT] Payload ignorado: tamanho inválido.", flush=True)
            return
        comando = message.payload.split(b"\0", 1)[0].decode("utf-8", errors="replace").strip().lower()
        self.eventos.put(("mqtt", comando))

    def publicar(self, topico, mensagem):
        # Como no ESP32, leituras e eventos offline não são armazenados.
        if self.client.is_connected():
            resultado = self.client.publish(topico, mensagem, qos=0, retain=False)
            if resultado.rc != mqtt.MQTT_ERR_SUCCESS:
                terminal.escrever(f"[MQTT] Publicação não enviada: {resultado.rc}", flush=True)

    def registrar_acesso(self, autorizado, agora):
        if not autorizado:
            terminal.escrever("[ACESSO] NEGADO", flush=True)
            self.publicar(self.topico_acesso, "negado")
            return
        self.fechadura_liberada = True
        self.porta_aberta = True
        self.inicio_acesso = agora
        terminal.escrever("[ACESSO] LIBERADO | Fechadura: LIBERADA | Porta: ABERTA", flush=True)
        self.publicar(self.topico_acesso, "liberado")

    def comando_mqtt(self, comando, agora):
        terminal.escrever(f"[MQTT] Comando recebido: {comando!r}", flush=True)
        if comando == "liberado":
            if not self.fechadura_liberada and not self.porta_aberta:
                self.registrar_acesso(True, agora)
            else:
                terminal.escrever("[MQTT] Liberação ignorada: acesso já em andamento.", flush=True)
        elif comando == "travado":
            self.fechadura_liberada = False
            self.porta_aberta = False
            terminal.escrever("[FECHADURA] TRAVADA | [PORTA] FECHADA", flush=True)

    def atualizar_tempos(self, agora):
        if self.fechadura_liberada and agora - self.inicio_acesso >= TEMPO_FECHADURA:
            self.fechadura_liberada = False
            terminal.escrever("[FECHADURA] TRAVADA (5 segundos)", flush=True)
        if self.porta_aberta and agora - self.inicio_acesso >= TEMPO_PORTA:
            self.porta_aberta = False
            terminal.escrever("[PORTA] FECHADA (20 segundos)", flush=True)

    def atualizar_temperatura(self):
        refrigeracao_anterior = self.refrigeracao
        # Mesmo sorteio discreto, fórmulas e ordem de avaliação de main.cpp.
        aleatorio = random.randint(0, 10000) / 10000.0
        if self.porta_aberta:
            self.temperatura += 0.08 + aleatorio * 0.10
        elif self.refrigeracao:
            self.temperatura -= 0.10 + aleatorio * 0.12
        else:
            erro = TEMPERATURA_ALVO - self.temperatura
            self.temperatura += erro * 0.25 + (aleatorio * 0.16 - 0.08)

        self.temperatura = max(19.8, min(26.0, self.temperatura))
        if not self.refrigeracao and self.temperatura >= LIMITE_ON:
            self.refrigeracao = True
        elif self.refrigeracao and self.temperatura <= LIMITE_OFF:
            self.refrigeracao = False

        if self.refrigeracao != refrigeracao_anterior:
            terminal.escrever(
                f"[REFRIGERAÇÃO] {'LIGADA' if self.refrigeracao else 'DESLIGADA'}"
            )

        agora = time.monotonic()
        if agora - self.ultimo_log_temperatura >= INTERVALO_LOG_TEMPERATURA:
            self.ultimo_log_temperatura = agora
            self.exibir_temperatura()
        self.publicar(self.topico_temperatura, f"{self.temperatura:.2f}")

    def exibir_temperatura(self):
        terminal.escrever(
            f"[TEMPERATURA] {self.temperatura:.2f} C"
            f" | Porta: {'ABERTA' if self.porta_aberta else 'FECHADA'}"
            f" | Fechadura: {'LIBERADA' if self.fechadura_liberada else 'TRAVADA'}"
            f" | Refrigeração: {'LIGADA' if self.refrigeracao else 'DESLIGADA'}",
            flush=True,
        )

    def ler_terminal(self):
        terminal.ler(self.eventos)

    def executar(self):
        terminal.escrever(f"Dispositivo simulado: {self.topico_acesso.split('/')[1]}")
        terminal.escrever(f"Client ID: {self.client_id}")
        terminal.escrever(f"Broker: {MQTT_HOST}:{MQTT_PORT}")
        terminal.escrever(f"Temperatura: {self.topico_temperatura}")
        terminal.escrever(f"Acesso:      {self.topico_acesso}")
        terminal.escrever("Comandos + Enter: autorizar | negar | sair")
        terminal.escrever("[TEMPERATURA] Inicial: 20.00 C | Porta: FECHADA | Fechadura: TRAVADA | Refrigeração: DESLIGADA")
        self.client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
        self.client.loop_start()
        threading.Thread(target=self.ler_terminal, daemon=True).start()
        ultima_leitura = time.monotonic()
        try:
            while True:
                # Verificação frequente dos temporizadores, sem bloquear no input.
                try:
                    origem, comando = self.eventos.get(timeout=0.05)
                except queue.Empty:
                    origem, comando = None, None
                agora = time.monotonic()
                if origem == "terminal":
                    if comando == "sair":
                        break
                    if comando == "autorizar":
                        # O botão físico reinicia os prazos mesmo com acesso ativo.
                        self.registrar_acesso(True, agora)
                    elif comando == "negar":
                        self.registrar_acesso(False, agora)
                    elif comando:
                        terminal.escrever("Use: autorizar | negar | sair", flush=True)
                elif origem == "mqtt":
                    self.comando_mqtt(comando, agora)
                elif origem == "conectado":
                    self.publicar(self.topico_temperatura, f"{self.temperatura:.2f}")
                self.atualizar_tempos(agora)
                if agora - ultima_leitura >= 1.0:
                    ultima_leitura = agora
                    self.atualizar_temperatura()
        except KeyboardInterrupt:
            pass
        finally:
            terminal.encerrar()
            self.client.disconnect()
            self.client.loop_stop()
            terminal.escrever("Simulador encerrado.", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Simulador MQTT do ESP32 LabControl IoT")
    parser.add_argument(
        "--mac", type=validar_mac, default=secrets.token_hex(6).upper(),
        help="ID exclusivo com 12 dígitos hexadecimais (padrão: aleatório a cada execução).",
    )
    args = parser.parse_args()
    Simulador(args.mac).executar()


if __name__ == "__main__":
    main()
