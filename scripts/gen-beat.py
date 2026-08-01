#!/usr/bin/env python3
# Генератор трэп/хип-хоп инструментала (numpy). 808-бас, хай-хет роллы,
# снейр на 3 (халф-тайм трэп). Легально: сгенерировано с нуля, без сэмплов.
#   python3 gen-beat.py <out.wav> [--dur 60] [--bpm 140] [--key 41.2]  (key=E1 Гц)
import sys, numpy as np, wave

def opt(k, d):
    return sys.argv[sys.argv.index(k)+1] if k in sys.argv else d

out = sys.argv[1]
DUR = float(opt('--dur', '60'))
BPM = float(opt('--bpm', '140'))     # трэп-темп; снейр на 3 → ощущается как ~70
KEY = float(opt('--key', '41.2'))    # E1
SR = 44100
beat = 60.0 / BPM
N = int(DUR*SR); t = np.arange(N)/SR
mix = np.zeros(N)

def place(sig, at, gain=1.0):
    s = int(at*SR); e = min(N, s+len(sig))
    if s < N: mix[s:e] += sig[:e-s]*gain

def env(n, a, d, sr=SR):
    e = np.ones(n); na=int(a*sr); nd=int(d*sr)
    if na: e[:na]=np.linspace(0,1,na)
    if nd: e[na:na+nd]=np.linspace(1,0,min(nd,n-na))
    if na+nd<n: e[na+nd:]=0
    return e

def sub808(freq, dur=0.6):
    n=int(dur*SR); tt=np.arange(n)/SR
    # глайд питча вниз + мягкая сатурация → «808»
    f = freq*(1+2.0*np.exp(-tt*30))
    ph = 2*np.pi*np.cumsum(f)/SR
    s = np.tanh(1.6*np.sin(ph))
    return s*np.exp(-tt*3.0)

def kick(dur=0.28):
    n=int(dur*SR); tt=np.arange(n)/SR
    f=120*np.exp(-tt*35)+45
    return np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-tt*9)

def snare(dur=0.22):
    n=int(dur*SR); tt=np.arange(n)/SR
    return (np.random.randn(n)*np.exp(-tt*16)*0.7 + np.sin(2*np.pi*190*tt)*np.exp(-tt*20)*0.3)

def hat(dur=0.05, bright=9000):
    n=int(dur*SR); tt=np.arange(n)/SR
    x=np.random.randn(n)
    # простой хайпасс через разность
    x=np.diff(np.concatenate([[0],x]))
    return x*np.exp(-tt*70)*0.5

def keys(freqs, dur):
    n=int(dur*SR); tt=np.arange(n)/SR; s=np.zeros(n)
    for f in freqs: s+=np.sin(2*np.pi*f*tt)+0.25*np.sin(2*np.pi*2*f*tt)
    return s/len(freqs)*np.exp(-tt*1.2)

def note(semi):  # от KEY
    return KEY*2**(semi/12)

# минорная прогрессия (i - VI - III - VII), 2 такта на аккорд
CH = [[0,3,7,10],[8,12,15,19],[3,7,10,14],[10,14,17,20]]
bar = beat*4
nbars = int(DUR/bar)+1
for b in range(nbars):
    ch = CH[(b//2)%len(CH)]
    root = note(ch[0])
    place(keys([note(x)*2 for x in ch], bar*0.95)*0.22, b*bar)     # эйрные ключи
    # 808 паттерн: на 1 и на «и» 3-й доли, с нотами аккорда
    place(sub808(root, beat*1.6)*0.9, b*bar)
    place(sub808(note(ch[2]), beat*1.2)*0.7, b*bar+beat*2.5)
    for i in range(4):
        at=b*bar+i*beat
        if i in (0,2): place(kick()*0.9, at)
        if i==2: place(snare()*0.8, at)          # снейр на 3 (халф-тайм трэп)
        # хай-хеты 8-е + роллы 16-х иногда
        for k in range(2):
            place(hat()*0.5, at+k*beat*0.5)
        if i==3:  # ролл в конце такта
            for k in range(4): place(hat(0.04)*0.4, at+beat*0.5+k*beat*0.125)

# лёгкий лоупас + мастер
def lp(x, c=6000):
    a=np.exp(-2*np.pi*c/SR); y=np.zeros_like(x); p=0
    for i in range(len(x)): p=(1-a)*x[i]+a*p; y[i]=p
    return y
mix = lp(mix, 8000)
mix /= (np.max(np.abs(mix))+1e-9); mix*=0.9
fn=int(0.6*SR); mix[:fn]*=np.linspace(0,1,fn); mix[-fn:]*=np.linspace(1,0,fn)

with wave.open(out,'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix*32767).astype(np.int16).tobytes())
print(f'✅ {out}  ({DUR:.0f}с, {BPM:.0f} BPM трэп-бит)')
