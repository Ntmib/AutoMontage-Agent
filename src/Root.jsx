import { Composition } from 'remotion';
import { Timeline } from './Timeline';
import { scenario } from './scenario';
import { scenarioCaptions } from './scenario-captions';
import { scenarioBroll } from './scenario-broll';
import { scenarioJob1 } from './scenario-job1';
import { scenarioJob1V } from './scenario-job1v';
import { scenarioPreview } from './scenario-preview';
import { scenarioPreviewH } from './scenario-preview-h';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="Reel"
        component={Timeline}
        durationInFrames={360}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenario}
      />
      {/* Демо этапа 4: авто-субтитры (12с) */}
      <Composition
        id="ReelCaptions"
        component={Timeline}
        durationInFrames={360}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenarioCaptions}
      />
      {/* Демо этапа 3: broll-врезка (12с) */}
      <Composition
        id="ReelBroll"
        component={Timeline}
        durationInFrames={360}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenarioBroll}
      />
      {/* Боевой ролик (горизонт) */}
      <Composition
        id="Job1"
        component={Timeline}
        durationInFrames={1325}
        fps={25}
        width={1870}
        height={1080}
        defaultProps={scenarioJob1}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames || 1325,
          width: props.width || 1870,
          height: props.height || 1080,
          fps: props.fps || 25,
        })}
      />
      {/* Боевой ролик — вертикальная версия (reframe + реалистичные broll) */}
      <Composition
        id="Job1V"
        component={Timeline}
        durationInFrames={1325}
        fps={25}
        width={1080}
        height={1920}
        defaultProps={scenarioJob1V}
      />
      {/* ПРЕВЬЮ-ролик (вертикаль, зум-ритм + врезки + плашки) */}
      <Composition
        id="Preview"
        component={Timeline}
        durationInFrames={3100}
        fps={25}
        width={1080}
        height={1920}
        defaultProps={scenarioPreview}
      />
      {/* ПРЕВЬЮ-ролик ГОРИЗОНТАЛЬНЫЙ (как исходник, 720p под Telegram) */}
      <Composition
        id="PreviewH"
        component={Timeline}
        durationInFrames={3100}
        fps={25}
        width={1280}
        height={720}
        defaultProps={scenarioPreviewH}
      />
      {/* Пайплайн: размеры и длина берутся из props (любой аспект/длительность) */}
      <Composition
        id="Dynamic"
        component={Timeline}
        durationInFrames={300}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenario}
        calculateMetadata={({ props }) => ({
          props: { ...props, beatZoom: props.beatZoom ?? false, beatSec: props.beatSec ?? 3 },
          durationInFrames: props.durationInFrames || 300,
          width: props.width || 720,
          height: props.height || 1280,
          fps: props.fps || 30,
        })}
      />
    </>
  );
};
