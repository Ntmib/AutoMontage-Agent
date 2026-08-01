#!/usr/bin/env bash
# Полный пайплайн превью-ролика (горизонт): рендер → финиш → музыка → упаковка под TG.
set -e
cd "$(dirname "$0")/.."
OUT=/tmp/preview_h
echo "=== 1/4 рендер PreviewH (3100 кадров) ==="
npx remotion render PreviewH "$OUT"_raw.mp4 --concurrency=2 --log=error
echo "=== 2/4 финиш (loudnorm -14 LUFS) ==="
node scripts/finish.js "$OUT"_raw.mp4 "$OUT"_fin.mp4 --hdrfix off
echo "=== 3/4 музыка (реальный трек LiQWYD-ReCharge/NCS + ducking, длина по видео) ==="
node scripts/mix-music.js "$OUT"_fin.mp4 assets/music/song.wav "$OUT"_mus.mp4 --gain -10
echo "=== 4/4 упаковка под Telegram (cfr, A/V-синхрон) ==="
node scripts/pack-tg.js "$OUT"_mus.mp4 "$OUT"_final.mp4 --maxrate 2000k
ls -la "$OUT"_final.mp4
echo "=== ГОТОВО: $OUT""_final.mp4 ==="
