import React from 'react';
import { FONT_CSS } from './fonts-data';

// Инлайн base64-шрифты в DOM. Никаких промисов/delayRender —
// @font-face с data-URI применяется браузером синхронно при раскладке.
export const FontStyle = () =>
  React.createElement('style', { dangerouslySetInnerHTML: { __html: FONT_CSS } });
