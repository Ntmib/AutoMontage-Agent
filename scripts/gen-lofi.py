#!/usr/bin/env python3
# Генератор lo-fi хип-хоп бита (numpy). Мягкие 7-аккорды + пыльный бит.
#   python3 gen-lofi.py <out.wav> [--dur 55] [--bpm 84]
import sys, numpy as np, wave, struct

def opt(k, d):
    return sys.argv[sys.argv.index(k)+1] if k in sys.argv else d

out = sys.argv[1]
DUR = float(opt('--dur', '55'))
BPM = float(opt('--bpm', '84'))
SR = 44100
beat = 60.0 / BPM
N = int(DUR * SR)
t = np.arange(N) / SR
mix = np.zeros(N)

def env(length, a=0.005, d=0.3):
    n = int(length * SR); e = np.ones(n)
    na = int(a*SR); nd = int(d*SR)
    e[:na] = np.linspace(0, 1, na)
    e[na:na+nd] = np.linspace(1, 0.0, min(nd, n-na))
    if na+nd < n: e[na+nd:] = 0
    return e

def place(sig, at):
    s = int(at*SR); e = min(N, s+len(sig))
    if s < N: mix[s:e] += sig[:e-s]

# --- ноты (Гц) ---
def note(n):  # n — полутоны от A4=440
    return 440 * 2**(n/12)
# lo-fi прогрессия: Am7, Dm7, Gmaj7, Cmaj7 (по 2 такта)
CH = [
    [-12,-9,-5,-2],   # Am7:  A C E G
    [-19,-14,-12,-9], # Dm7:  D F A C  (низко)
    [-14,-10,-7,-3],  # Gmaj7:G B D F#
    [-21,-17,-12,-9], # Cmaj7:C E G B
]

def epiano(freqs, dur):
    n = int(dur*SR); tt = np.arange(n)/SR
    s = np.zeros(n)
    for f in freqs:
        s += np.sin(2*np.pi*f*tt) + 0.3*np.sin(2*np.pi*2*f*tt)
    e = np.exp(-tt*1.6)  # мягкое затухание
    return s * e / len(freqs)

def kick(dur=0.32):
    n=int(dur*SR); tt=np.arange(n)/SR
    f = 110*np.exp(-tt*30)+45
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-tt*7)

def snare(dur=0.2):
    n=int(dur*SR); tt=np.arange(n)/SR
    noise=np.random.randn(n)*np.exp(-tt*18)
    tone=np.sin(2*np.pi*180*tt)*np.exp(-tt*22)*0.4
    return noise*0.6+tone

def hat(dur=0.05):
    n=int(dur*SR); tt=np.arange(n)/SR
    return np.random.randn(n)*np.exp(-tt*80)*0.35

bar = beat*4
nbars = int(DUR/bar)+1
for b in range(nbars):
    ch = CH[(b//2) % len(CH)]
    freqs=[note(x) for x in ch]
    # аккорд в начале такта и на «и» 3-й доли (lo-fi качель)
    place(epiano(freqs, bar*0.9)*0.5, b*bar)
    place(epiano(freqs, beat*1.5)*0.35, b*bar+beat*2.5)
    for beatpos in range(4):
        at=b*bar+beatpos*beat
        if beatpos in (0,2): place(kick()*0.9, at)
        if beatpos in (1,3): place(snare()*0.7, at)
        place(hat()*0.5, at)               # хэт на долях
        place(hat()*0.3, at+beat*0.5)      # и на «и»

# --- lo-fi обработка: one-pole lowpass + лёгкий винил-шум ---
def lowpass(x, cutoff=2600):
    a = np.exp(-2*np.pi*cutoff/SR); y=np.zeros_like(x); p=0
    for i in range(len(x)):
        p = (1-a)*x[i]+a*p; y[i]=p
    return y
mix = lowpass(mix)
mix += np.random.randn(N)*0.006          # винил-пыль
# лёгкое дрожание громкости (wow&flutter вайб)
mix *= (1 + 0.04*np.sin(2*np.pi*0.3*t))

mix /= (np.max(np.abs(mix))+1e-9); mix*=0.85
# fade in/out
fn=int(0.8*SR); mix[:fn]*=np.linspace(0,1,fn); mix[-fn:]*=np.linspace(1,0,fn)

with wave.open(out,'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix*32767).astype(np.int16).tobytes())
print(f'✅ {out}  ({DUR:.0f}с, {BPM:.0f} BPM lo-fi)')
