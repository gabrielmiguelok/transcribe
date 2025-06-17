#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script para transcribir archivos de audio usando OpenAI Whisper,
mostrando en tiempo real el uso de RAM, CPU y el progreso del proceso.

Características:
  - Escaneo recursivo EXCLUSIVAMENTE en la carpeta "./transcripciones/" y TODOS sus subdirectorios.
  - Cada 60 segundos, se realiza un nuevo escaneo solo DESPUÉS de haber terminado
    de procesar la cola detectada en el escaneo anterior.
  - Transcribe archivos de a uno por vez (secuencial), y al terminar, elimina el
    archivo de audio original para no volver a procesarlo.
  - Si el nombre de un archivo empieza con más de 13 dígitos consecutivos (p.ej. 14, 15... 18 dígitos),
    se ignora la transcripción y se elimina directamente el archivo.
  - El archivo .txt de salida se guarda en la MISMA carpeta que el archivo fuente,
    con el mismo nombre base.
  - El proceso no finaliza; permanece en ejecución indefinidamente hasta que se
    fuerce su cierre (Ctrl+C o similar).
  - La transcripción resultante no hará saltos de línea dobles entre cada segmento.
    Sólo se hará un cambio de línea si se detecta una pausa grande entre segmentos
    (silencio fuerte) o si el segmento anterior finaliza en punto (.), exclamación
    (!) o interrogación (?). Esto para lograr un texto más prolijo.
"""

import glob
import os
import re
import sys
import threading
import time

import psutil
import torch
import whisper
from rich.live import Live
from rich.table import Table
from rich.panel import Panel

# =============================================================================
#                   VARIABLES IMPORTANTES Y CONFIGURABLES
# =============================================================================

# Directorio base donde se buscarán los audios (y subdirectorios).
MONITORED_DIRECTORY = "./transcripciones"

# Modelo por defecto (tiny, base, small, medium, large)
MODEL_NAME = "small"

# Cantidad de hilos (threads) para CPU
CPU_THREADS = 4

# Si es True, desactiva fp16 y usa float32 (más lento y mayor uso de RAM, pero más estable en algunos casos)
USE_FP32 = True

# Tamaño del haz en la búsqueda. Si >1, se usa beam search (más exigente en CPU y RAM)
BEAM_SIZE = 10

# Número de hipótesis totales en modo "greedy" (solo se aplica si BEAM_SIZE=1)
BEST_OF = 5

# Extensiones de audio que se desean procesar
AUDIO_EXTENSIONS = [
    "*.wav", "*.ogg", "*.mp3", "*.m4a", "*.flac"
]

# Umbral para considerar un "silencio fuerte" (en segundos).
# Si el siguiente segmento empieza después de X segundos de terminado el anterior,
# forzamos un salto de línea.
SILENCE_THRESHOLD = 3.0

# Intervalo (en segundos) entre un escaneo y el siguiente.
SCAN_INTERVAL = 10

# =============================================================================
#                         ESTADO GLOBAL PARA EL MONITOR
# =============================================================================
status = {
    "current_file": "Ninguno",
    "files_processed": 0,
    "total_files": 0,
}
done = False  # En este script, se mantiene en False para ejecución indefinida.

# =============================================================================
#                           FUNCIONES PRINCIPALES
# =============================================================================

def cargar_modelo(nombre_modelo: str, hilos_cpu: int) -> whisper.Whisper:
    """
    Carga el modelo de Whisper en CPU, ajustando la cantidad de hilos que PyTorch utilizará.

    Args:
        nombre_modelo (str): Nombre del modelo a cargar (tiny, base, small, medium, large).
        hilos_cpu (int): Cantidad de hilos que se usarán en CPU.

    Returns:
        whisper.Whisper: Instancia del modelo Whisper cargada en CPU.
    """
    torch.set_num_threads(hilos_cpu)
    try:
        modelo = whisper.load_model(nombre_modelo, device="cpu")
    except Exception as e:
        print(f"Error al cargar el modelo '{nombre_modelo}': {e}", file=sys.stderr)
        sys.exit(1)

    return modelo


def formatear_transcripcion(segments, silence_threshold: float = 1.0) -> str:
    """
    Dada la lista de segments devuelta por Whisper, genera un texto final
    donde se unen los segmentos en la misma línea, a menos que:
      - Exista una pausa mayor al `silence_threshold` segundos entre
        el final del segmento anterior y el inicio del actual.
      - El texto anterior termine en punto (.), exclamación (!) o interrogación (?).

    Args:
        segments (list): Lista de segmentos devueltos por whisper, donde cada elemento
                         contiene 'start', 'end', 'text'.
        silence_threshold (float): Umbral de silencio (en segundos) para forzar un salto de línea.

    Returns:
        str: Texto unificado con saltos de línea sólo en caso de pausas grandes o signos de puntuación fuertes.
    """
    if not segments:
        return ""

    lineas = []
    punctuation_marks = {'.', '!', '?'}

    # Procesamos el primer segmento
    prev_end = segments[0]["end"]
    lineas.append(segments[0]["text"].strip())

    # Iteramos desde el segundo en adelante
    for i in range(1, len(segments)):
        start_time = segments[i]["start"]
        text = segments[i]["text"].strip()

        diff = start_time - prev_end  # diferencia de tiempo con el segmento anterior

        # Si el último caracter de la última línea es un signo de puntuación
        # o se superó el umbral de silencio, iniciamos una nueva línea
        if lineas[-1] and (lineas[-1][-1] in punctuation_marks or diff > silence_threshold):
            lineas.append(text)
        else:
            # Continuamos en la misma línea, separando con espacio
            lineas[-1] += " " + text

        prev_end = segments[i]["end"]

    return "\n".join(lineas)


def transcribir_audio(
    modelo: whisper.Whisper,
    ruta_audio: str,
    usar_fp32: bool,
    beam_size: int,
    best_of: int
) -> str:
    """
    Transcribe un archivo de audio, usando parámetros de decodificación (fp16/fp32, beam_size, best_of).
    Luego formatea la transcripción para evitar saltos de línea innecesarios.

    Args:
        modelo (whisper.Whisper): Instancia del modelo de Whisper previamente cargada.
        ruta_audio (str): Ruta al archivo de audio.
        usar_fp32 (bool): Indica si se forzará fp32 (desactivando fp16).
        beam_size (int): Tamaño del haz en beam search.
        best_of (int): Número de hipótesis totales al usar greedy search (solo si beam_size=1).

    Returns:
        str: Texto transcrito y formateado.
    """
    if not os.path.isfile(ruta_audio):
        print(f"El archivo de audio '{ruta_audio}' no existe.", file=sys.stderr)
        return ""

    opciones_decod = {
        "fp16": not usar_fp32,  # Si usar_fp32=True => fp16=False
        "beam_size": beam_size,
        "best_of": best_of
    }

    try:
        resultado = modelo.transcribe(ruta_audio, **opciones_decod)
    except Exception as e:
        print(f"Error al transcribir el audio '{ruta_audio}': {e}", file=sys.stderr)
        return ""

    if "segments" in resultado:
        return formatear_transcripcion(resultado["segments"], silence_threshold=SILENCE_THRESHOLD)
    else:
        return resultado.get("text", "")


def ignorar_archivo_por_numeracion_inicial(nombre_archivo: str) -> bool:
    """
    Devuelve True si el nombre del archivo comienza con 14 o más dígitos consecutivos.
    Ejemplo: '120363335127043974_send...'
    """
    patron = r'^\d{14,}'
    return bool(re.match(patron, nombre_archivo))


def buscar_archivos_audio(directorio: str) -> list:
    """
    Busca recursivamente (subdirectorios incluidos) todos los archivos de audio
    con las extensiones definidas en AUDIO_EXTENSIONS.

    Args:
        directorio (str): Ruta base donde iniciar la búsqueda recursiva.

    Returns:
        list: Lista con rutas absolutas de los archivos encontrados.
    """
    archivos_audio = []
    for ext in AUDIO_EXTENSIONS:
        archivos_audio.extend(
            glob.glob(os.path.join(directorio, "**", ext), recursive=True)
        )
    return archivos_audio


def procesar_archivos(
    modelo: whisper.Whisper,
    archivos_audio: list,
    usar_fp32: bool,
    beam_size: int,
    best_of: int
):
    """
    Procesa (transcribe) una lista de archivos de audio secuencialmente.
    - Si el archivo empieza con más de 13 dígitos consecutivos, se ignora y borra.
    - Caso contrario, se transcribe y borra el original sólo si la transcripción fue exitosa.

    Args:
        modelo (whisper.Whisper): Instancia del modelo de Whisper cargada.
        archivos_audio (list): Lista de rutas de archivos de audio.
        usar_fp32 (bool): Si se usa float32 en lugar de float16.
        beam_size (int): Tamaño del haz para beam search.
        best_of (int): Cantidad de hipótesis totales en greedy search (si beam_size=1).
    """
    for archivo in archivos_audio:
        nombre_archivo = os.path.basename(archivo)
        status["current_file"] = nombre_archivo

        # Verificar si se ignora por numeración inicial (más de 13 dígitos)
        if ignorar_archivo_por_numeracion_inicial(nombre_archivo):
            print(f"[IGNORADO] El archivo '{nombre_archivo}' empieza con más de 13 dígitos. Se eliminará sin transcribir.")
            try:
                os.remove(archivo)
                print(f"[ELIMINADO] '{nombre_archivo}' borrado correctamente.")
            except Exception as e:
                print(f"[ERROR] Al intentar eliminar '{nombre_archivo}': {e}", file=sys.stderr)
            status["files_processed"] += 1
            continue

        print(f"[INICIO] Transcribiendo '{nombre_archivo}'...")
        transcripcion = transcribir_audio(modelo, archivo, usar_fp32, beam_size, best_of)

        if not transcripcion.strip():
            print(f"[ERROR] No se obtuvo transcripción para '{nombre_archivo}'. Se omite borrado.")
            status["files_processed"] += 1
            continue

        # Guardar transcripción en archivo .txt
        nombre_base = os.path.splitext(archivo)[0]
        archivo_txt = nombre_base + ".txt"

        try:
            with open(archivo_txt, "w", encoding="utf-8") as f:
                f.write(transcripcion)
            print(f"[OK] Transcripción guardada en: {archivo_txt}")

            # Eliminar archivo original solo si todo salió bien
            os.remove(archivo)
            print(f"[OK] Archivo fuente '{nombre_archivo}' eliminado tras éxito.")
        except Exception as e:
            print(f"[ERROR] Al guardar/eliminar: {e}", file=sys.stderr)

        # Actualizar contador de archivos procesados
        status["files_processed"] += 1

    status["current_file"] = "Ninguno"


# =============================================================================
#                         FUNCIONES DE MONITOREO
# =============================================================================

def crear_tabla_estado() -> Table:
    """
    Crea y retorna una tabla (Rich Table) que muestra el estado actual del proceso y
    el uso de recursos (CPU, RAM).

    Returns:
        Table: Objeto Table de la librería Rich con los datos de monitoreo.
    """
    tabla = Table(title="Estado de Transcripción")
    tabla.add_column("Parámetro", justify="left", style="cyan", no_wrap=True)
    tabla.add_column("Valor", style="magenta")

    uso_cpu = psutil.cpu_percent(interval=None)
    memoria = psutil.virtual_memory()
    ram_usada_mb = memoria.used / (1024 * 1024)
    ram_total_mb = memoria.total / (1024 * 1024)

    total_archivos = status.get("total_files", 0)
    procesados = status.get("files_processed", 0)
    if total_archivos > 0:
        progreso = f"{(procesados / total_archivos * 100):.1f}%"
    else:
        progreso = "N/A"

    tabla.add_row("Archivo actual", status.get("current_file", "Ninguno"))
    tabla.add_row("Archivos procesados", f"{procesados} / {total_archivos}")
    tabla.add_row("Progreso", progreso)
    tabla.add_row("Uso CPU", f"{uso_cpu}%")
    tabla.add_row("RAM usada", f"{ram_usada_mb:.1f} MB / {ram_total_mb:.1f} MB")

    return tabla


def monitor_recursos(live: Live):
    """
    Función encargada de actualizar la vista en vivo (uso de CPU, RAM, progreso) cada segundo,
    hasta que la bandera global 'done' indique la finalización.
    """
    global done
    while not done:  # Se mantiene en False para ejecución indefinida
        live.update(Panel(crear_tabla_estado(), title="Monitor de Recursos"))
        time.sleep(1)

    # Última actualización si done se pusiera en True
    live.update(Panel(crear_tabla_estado(), title="Monitor de Recursos - Finalizado"))


# =============================================================================
#                                 PUNTO DE ENTRADA
# =============================================================================

def main():
    """
    Punto de entrada principal del script.
    1. Carga el modelo de Whisper en CPU con la configuración elegida.
    2. Lanza un hilo de monitoreo de recursos con Rich.
    3. Entra en un ciclo infinito donde cada SCAN_INTERVAL segundos:
       - Escanea recursivamente el directorio "./transcripciones/" en busca de archivos de audio.
       - Ignora y elimina directamente los que cumplan la condición de numeración inicial (> 13 dígitos).
       - Procesa los que sí deben transcribirse, uno por uno, transcribiendo y eliminando
         el archivo fuente tras el éxito.
       - Actualiza los contadores de estado.
       - Luego espera SCAN_INTERVAL segundos para el siguiente escaneo.
    """
    print(f"[INFO] Cargando el modelo Whisper '{MODEL_NAME}' en CPU con {CPU_THREADS} hilos...")

    if USE_FP32:
        print("  -> Modo fp32 ACTIVADO (fp16 deshabilitado). Esto consumirá más RAM.")
    if BEAM_SIZE > 1:
        print(f"  -> Búsqueda por haz (beam_size={BEAM_SIZE}). Mayor consumo de CPU y RAM.")
    else:
        print(f"  -> Búsqueda 'greedy' (best_of={BEST_OF}).")

    # Cargar el modelo
    modelo = cargar_modelo(MODEL_NAME, CPU_THREADS)
    print("[INFO] Modelo cargado con éxito.\n")

    directorio_absoluto = os.path.abspath(MONITORED_DIRECTORY)
    print(f"[INFO] Escaneando y transcribiendo audios en: {directorio_absoluto}\n")

    global done
    done = False

    with Live(crear_tabla_estado(), refresh_per_second=1) as vista_live:
        hilo_monitor = threading.Thread(
            target=monitor_recursos, args=(vista_live,), daemon=True
        )
        hilo_monitor.start()

        # Bucle infinito de monitoreo y procesamiento
        while True:
            archivos_encontrados = buscar_archivos_audio(directorio_absoluto)
            archivos_encontrados = [a for a in archivos_encontrados if os.path.isfile(a)]

            status["files_processed"] = 0
            status["total_files"] = len(archivos_encontrados)

            if status["total_files"] == 0:
                print(f"[INFO] No se encontraron archivos de audio. Revisando de nuevo en {SCAN_INTERVAL} seg...")
            else:
                print(f"[INFO] Se encontraron {status['total_files']} archivo(s). Iniciando proceso...")
                procesar_archivos(
                    modelo=modelo,
                    archivos_audio=archivos_encontrados,
                    usar_fp32=USE_FP32,
                    beam_size=BEAM_SIZE,
                    best_of=BEST_OF
                )
                print("[INFO] Finalizó el procesamiento de esta tanda.")

            time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
