# Spike (c, part 2): whisper.cpp (CUDA) and Kokoro latency on the NVIDIA GPU

Status: benchmark procedure, not yet run. Date: 2026-10-31. Run it on the Windows 11 PC with the NVIDIA GPU, in English. Nothing here has been executed in the build sandbox, and every command below is a starting point to check against the current README of the tool it names (flags and file names move between releases).

Why: the voice loop is a latency budget ([ADR 0006](../../docs/adr/0006-avatar-vrm-and-voice-stack.md)). The research found most STT and TTS numbers are vendor claims or blog benchmarks that disagree by an order of magnitude (Kokoro: a real-time factor from 0.2 to about 1.1 in one source, about 3.7 s to first audio in another). Do not commit to an engine before measuring on the real GPU, and measure with the 3D Room running, because they share the GPU.

Network is needed only to download the tools and models once. After that the benchmark runs offline.

## 0. Record the machine

Fill this in first; it goes at the top of your results.

```
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"Total Physical Memory"
```

Note the CPU model, RAM, the Windows build, and which monitor refresh rate you use.

## 1. Test material

Record three English clips of your own voice, 16 kHz, mono, 16-bit WAV, in a normal room with the microphone you will use. Audacity works (export WAV, 16000 Hz, mono). With ffmpeg: list devices with `ffmpeg -list_devices true -f dshow -i dummy`, then `ffmpeg -f dshow -i audio="<device name>" -ar 16000 -ac 1 -t 10 clip.wav`.

| Clip | Length | Read this |
|---|---|---|
| `clips/3s.wav` | about 3 s | "Mira, remind me to look at the Atlas migration first thing tomorrow." |
| `clips/6s.wav` | about 6 s | "What is Priya waiting on, exactly? And can you draft a short reply that offers a walkthrough before Thursday?" |
| `clips/10s.wav` | about 10 s | "Does the Q4 plan still feel right to you? I keep thinking general productivity toolmaker is too wide, and everything I wrote this week points at independent builders." |

For TTS, use these four sentences:

1. "Good morning, I am here." (5 words)
2. "Three things need you today, and one is urgent." (9 words)
3. "Priya is waiting on the revised homepage before Thursday." (9 words)
4. "I drafted a short reply for you, and it only goes out if you approve it." (16 words)

## 2. whisper.cpp with CUDA

Prerequisites: a current NVIDIA driver, the CUDA Toolkit, Visual Studio Build Tools (MSVC), CMake and Git. Follow the build section of https://github.com/ggml-org/whisper.cpp for the current CUDA flag; at the time of research it was along these lines:

```
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=1
cmake --build build -j --config Release
```

Download models as that repo's `models` documentation describes: `base.en`, `small.en` and `large-v3-turbo` (multilingual, English used here). Executables normally land in `build\bin\Release\` (`whisper-cli.exe`, `whisper-server.exe`); check with `--help`.

Measure in server mode, so the model stays resident (this is the latency the app will see):

```
build\bin\Release\whisper-server.exe -m models\ggml-small.en.bin --host 127.0.0.1 --port 8178 -t 4
```

In another PowerShell window, time five requests per clip and discard the first (cold):

```
1..6 | ForEach-Object {
  (Measure-Command { curl.exe -s http://127.0.0.1:8178/inference -F "file=@clips\6s.wav" -F "response_format=json" -F "temperature=0.0" | Out-Null }).TotalMilliseconds
}
```

Repeat for each model and clip. Also run `whisper-cli.exe -m <model> -f clips\6s.wav` once per model and note the encode and decode times it prints. While a run is going, read VRAM from `nvidia-smi` and note the peak. Check the transcript text is correct for each clip.

Record (milliseconds, warm median of 5):

| Model | 3 s clip | 6 s clip | 10 s clip | VRAM | Transcript correct |
|---|---|---|---|---|---|
| base.en | | | | | |
| small.en | | | | | |
| large-v3-turbo | | | | | |

Note that this is batch latency after the utterance ends, which is what a push-to-talk loop pays. Streaming engines (Moonshine, whisper-stream) trade accuracy for lower end-of-speech latency; if the numbers here miss the gate, try Moonshine as the fallback (vendor figures: 59 ms on a MacBook Pro and 269 ms on Linux x86 for the medium streaming model; unmeasured on this PC).

## 3. Kokoro first-audio latency

Kokoro-82M is Apache-2.0. Use whichever route installs cleanly, and record which one and which execution provider (CPU, CUDA, DirectML) actually ran.

Option A, Node (`kokoro-js`, which runs through Transformers.js and ONNX Runtime). Check the package README for the current API; the shape is roughly:

```js
import { KokoroTTS } from 'kokoro-js'
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' }) // try fp32 and a GPU device if supported
for (const text of sentences) {
  const t0 = performance.now()
  const audio = await tts.generate(text, { voice: 'af_heart' })
  console.log(text.split(' ').length, 'words', (performance.now() - t0).toFixed(0), 'ms to a full sentence of audio')
}
```

Option B, Python (`kokoro-onnx` with `onnxruntime-gpu`). Again check the README; roughly:

```python
import time
from kokoro_onnx import Kokoro
kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
for text in sentences:
    t0 = time.perf_counter()
    samples, sr = kokoro.create(text, voice="af_heart", speed=1.0, lang="en-us")
    print(len(text.split()), "words", round((time.perf_counter() - t0) * 1000), "ms")
```

If the engine only returns after synthesising the whole sentence, that time is the first-audio latency for sentence-chunked streaming (synthesise sentence N+1 while N plays). If it offers a streaming API, record time to the first audio chunk instead.

Measure per sentence: cold start (model load, expect 3 to 5 s, which the app hides by preloading at start), then warm runs (median of 5), then the real-time factor (synthesis time divided by audio duration). The first model download needs the network; later runs do not.

| Sentence | Words | Warm first-audio (ms) | Real-time factor | Provider |
|---|---|---|---|---|
| 1 | 5 | | | |
| 2 | 9 | | | |
| 3 | 9 | | | |
| 4 | 16 | | | |

Listen to each output and note whether the voice is acceptable for a warm, playful persona (Kokoro has no emotion control).

## 4. GPU contention

The Room, STT and TTS share one GPU. Repeat sections 2 and 3 (one clip, one sentence, small.en) while the page `../webgl-camera/index.html` is running its frame-pacing test (press "WebGL2 and frame pacing" and start your timing runs during it). Record:

- the STT and TTS latencies with the Room load, as a percentage of the unloaded numbers;
- the WebGL frame median and p95 with STT and TTS running versus idle.

## 5. Combined estimate

Fill in with your measured numbers, plus the TTFT from [../ttft](../ttft):

```
endpointing (assume 400 ms until measured)       ____ ms
+ final STT (small.en, 6 s clip, warm)           ____ ms
+ Claude TTFT (p50 from spike (a), your path)    ____ ms
+ wait for the first clause (assume 150 ms)      ____ ms
+ TTS first audio (sentence 3, warm)             ____ ms
+ audio device and lip-sync alignment (assume 60 ms)  ____ ms
= end of speech to first audible syllable        ____ ms
```

## Gate (proposed, derived from the budget in docs/research/avatar-voice-room.md)

| Check | Pass | Warn | Fail |
|---|---|---|---|
| STT, warm, 6 s clip, with the chosen model | 500 ms or less | up to 800 ms | over 800 ms, or the transcript is wrong |
| TTS first audio, warm, 9-word sentence | 500 ms or less | up to 900 ms | over 900 ms, or no acceptable voice |
| Contention (Room running) | latencies up 30 percent or less and frame p95 within 1.6 times the median | up to 60 percent | worse, or frames stall |
| Combined estimate | 2.5 s or less | 2.5 to 3.0 s | over 3.0 s |

What a result means: pass means the Phase 3 voice order (text, Kokoro, push-to-talk whisper.cpp, then VAD) stands as written. A warm or fail on STT means trying a smaller model or Moonshine; on TTS, a smaller or quantised model, a GPU provider, or the optional cloud voice behind the `TtsProvider` (sentences would leave the PC); on the combined estimate, the Voice lane, a cached acknowledgement clip, or both. A fail on contention means lowering the Room frame cap or moving STT and TTS to the CPU.

The figures in the research are estimates marked (e) or vendor numbers. Your measurements replace them in [ADR 0006](../../docs/adr/0006-avatar-vrm-and-voice-stack.md).
