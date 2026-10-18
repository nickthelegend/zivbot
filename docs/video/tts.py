# Chatterbox TTS: one wav per line of the script. Usage: python tts.py script.json outdir
import json, sys, os, torch, torchaudio as ta
from chatterbox.tts import ChatterboxTTS
dev = os.environ.get("TTS_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
model = ChatterboxTTS.from_pretrained(device=dev)
lines = json.load(open(sys.argv[1]))
out = sys.argv[2]; os.makedirs(out, exist_ok=True)
for item in lines:
    path = os.path.join(out, f"{item['id']}.wav")
    if os.path.exists(path) and not os.environ.get('FORCE'): continue
    wav = model.generate(item['text'], exaggeration=float(item.get('exaggeration', 0.45)), cfg_weight=float(item.get('cfg', 0.5)))
    ta.save(path, wav, model.sr)
    print('saved', path, wav.shape[-1] / model.sr, flush=True)
